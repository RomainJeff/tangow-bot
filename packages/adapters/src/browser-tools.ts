import type {
  AdapterContext,
  BrowserActKind,
  BrowserActResult,
  BrowserActStep,
  BrowserProvider,
  BrowserSnapshotNode,
  BrowserSnapshotResult,
  ComputerRef,
  DecisionProvider,
  DecisionRequest,
} from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { decideWithin, topChoices } from "./decision.js";

const MAX_BROWSER_ACTIONS = 24;
/** Each target takes its own snapshot and decision, so keep a call short. */
const MAX_BROWSER_TARGET_ACTIONS = 6;
const MAX_TARGET_CHARS = 200;
/** The helper caps a snapshot at 80 elements; in-process sessions do not. */
const MAX_TARGET_OPTIONS = 80;
const MAX_OPTION_NAME_CHARS = 120;
/**
 * Starting value before offline calibration (ticket 06); not a user setting. Compared
 * with the answer's `confidence`, a statistic of how peaked the whole distribution is,
 * not the chosen option's probability (documented example: 0.75 for a 0.84 pick).
 */
const TARGET_CONFIDENCE_HIGH = 0.8;
const TARGET_DECISION_TIMEOUT_MS = 1_000;
const TARGET_CANDIDATE_COUNT = 3;
const NONE_OPTION = "none";
/**
 * v1 targets only reversible controls: navigation for click, text entry for
 * fill/type. Buttons and submits always need an explicit ref.
 */
const TARGET_ROLES: Record<BrowserActKind, ReadonlySet<string>> = {
  click: new Set(["link", "tab"]),
  fill: new Set(["textbox", "searchbox", "combobox"]),
  type: new Set(["textbox", "searchbox", "combobox"]),
};

type BrowserTargetStep =
  | { kind: "click"; target: string }
  | { kind: "fill" | "type"; target: string; text: string };

type BrowserActToolStep = BrowserActStep | BrowserTargetStep;

type BrowserTargetOutcome =
  | "executed"
  | "returned_low_confidence"
  | "returned_none"
  | "returned_unavailable";

export interface BrowserTargetStats {
  calls: number;
  executed: number;
  returned: number;
}

/** Present only when the run resolved a decision provider. */
export interface BrowserTargetOptions {
  provider: DecisionProvider;
  secrets: string[];
  stats?: BrowserTargetStats;
}

type BrowserActToolResult = BrowserActResult & {
  needsRef?: true;
  candidates?: Array<{ ref: string; name: string; probability: number }>;
  reason?: string;
  note?: string;
};

export async function browserNavigateFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const url = String(args.url ?? "").trim();
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
      return {
        error: "An HTTP(S) URL without embedded credentials is required",
        fallback: "computer_act" as const,
      };
    }
    const result = await browser.navigate(computer, { url, signal: context.signal }, context);
    return formatBrowserResult(result);
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      error: error instanceof Error ? error.message : String(error),
      fallback: "computer_act" as const,
    };
  }
}

export async function browserSnapshotFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  void args;
  try {
    const result = await browser.snapshot(computer, { signal: context.signal }, context);
    return formatBrowserResult(result);
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      error: error instanceof Error ? error.message : String(error),
      fallback: "computer_act" as const,
    };
  }
}

export async function browserActFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  targets?: BrowserTargetOptions,
) {
  try {
    if (targets) {
      const steps = parseBrowserActToolSteps(args.actions);
      if (steps.some((step) => "target" in step)) {
        return formatBrowserResult(
          await actWithTargets(browser, computer, context, steps, targets),
        );
      }
    }
    const actions = parseBrowserActions(args.actions);
    const result = await browser.act(computer, { actions, signal: context.signal }, context);
    return formatBrowserResult(result);
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      ok: false,
      uncertain: true,
      error: error instanceof Error ? error.message : String(error),
      fallback: "computer_act" as const,
    };
  }
}

export function parseBrowserActions(value: unknown): BrowserActStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("browser_act requires at least one action");
  }
  if (value.length > MAX_BROWSER_ACTIONS) {
    throw new Error(`browser_act accepts at most ${MAX_BROWSER_ACTIONS} actions`);
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`browser_act action ${index} must be an object`);
    }
    const action = raw as Record<string, unknown>;
    const kind = String(action.kind ?? "") as BrowserActKind;
    if (kind !== "click" && kind !== "fill" && kind !== "type") {
      throw new Error(`browser_act action ${index} has unsupported kind`);
    }
    const ref = String(action.ref ?? "").trim();
    if (!ref) throw new Error(`browser_act action ${index} requires ref`);
    if (kind === "fill" || kind === "type") {
      if (typeof action.text !== "string") {
        throw new Error(`browser_act ${kind} requires text`);
      }
      return { kind, ref, text: String(action.text) };
    }
    return { kind, ref };
  });
}

/** Like parseBrowserActions, but each action carries exactly one of ref or target. */
export function parseBrowserActToolSteps(value: unknown): BrowserActToolStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("browser_act requires at least one action");
  }
  if (value.length > MAX_BROWSER_ACTIONS) {
    throw new Error(`browser_act accepts at most ${MAX_BROWSER_ACTIONS} actions`);
  }
  let targetCount = 0;
  return value.map((raw, index): BrowserActToolStep => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`browser_act action ${index} must be an object`);
    }
    const action = raw as Record<string, unknown>;
    const hasRef = action.ref !== undefined && String(action.ref).trim() !== "";
    const hasTarget = action.target !== undefined && String(action.target).trim() !== "";
    if (hasRef && hasTarget) {
      throw new Error(`browser_act action ${index} takes ref or target, not both`);
    }
    if (!hasTarget) {
      if (targetCount > 0) {
        throw new Error(
          `browser_act action ${index}: put ref actions before target actions; each target takes a fresh snapshot, so later refs are stale`,
        );
      }
      const [step] = parseBrowserActions([raw]);
      return step!;
    }
    targetCount += 1;
    if (targetCount > MAX_BROWSER_TARGET_ACTIONS) {
      throw new Error(`browser_act accepts at most ${MAX_BROWSER_TARGET_ACTIONS} target actions`);
    }
    const kind = String(action.kind ?? "") as BrowserActKind;
    if (kind !== "click" && kind !== "fill" && kind !== "type") {
      throw new Error(`browser_act action ${index} has unsupported kind`);
    }
    const target = String(action.target).trim();
    if (target.length > MAX_TARGET_CHARS) {
      throw new Error(`browser_act action ${index} target is too long`);
    }
    if (kind === "click") return { kind, target };
    if (typeof action.text !== "string") throw new Error(`browser_act ${kind} requires text`);
    return { kind, target, text: action.text };
  });
}

async function actWithTargets(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  steps: BrowserActToolStep[],
  targets: BrowserTargetOptions,
): Promise<BrowserActToolResult> {
  const refSteps = steps.filter((step): step is BrowserActStep => "ref" in step);
  let completed = 0;
  let last: BrowserActResult | undefined;
  if (refSteps.length > 0) {
    last = await browser.act(computer, { actions: refSteps, signal: context.signal }, context);
    if (!last.ok) return last;
    completed = last.completed;
  }
  for (const step of steps) {
    if (!("target" in step)) continue;
    const resolved = await resolveBrowserTarget(browser, computer, context, step, targets);
    if ("returned" in resolved) return { ...resolved.returned, completed };
    const action: BrowserActStep =
      step.kind === "click"
        ? { kind: "click", ref: resolved.ref }
        : { kind: step.kind, ref: resolved.ref, text: step.text };
    // A ref gone stale since the snapshot fails in the provider and is returned, never retargeted.
    last = await browser.act(computer, { actions: [action], signal: context.signal }, context);
    if (!last.ok) return { ...last, completed: completed + last.completed };
    completed += last.completed;
  }
  return { ...last!, completed };
}

/**
 * Snapshot, ask the decision provider which reversible control matches, and
 * return its ref only when confident. Anything else hands the fresh snapshot
 * back to the model, which picks a ref itself exactly as without a provider.
 */
async function resolveBrowserTarget(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  step: BrowserTargetStep,
  targets: BrowserTargetOptions,
): Promise<{ ref: string } | { returned: BrowserActToolResult }> {
  const snapshot = await browser.snapshot(computer, { signal: context.signal }, context);
  if (snapshot.fallback) return { returned: { ok: false, completed: 0, ...snapshot } };
  const limit = Math.min(
    MAX_TARGET_OPTIONS,
    targets.provider.describe().capabilities.maxOptions - 1,
  );
  const candidates = snapshot.elements
    .filter((element) => TARGET_ROLES[step.kind].has(element.role))
    .slice(0, Math.max(0, limit));
  const report = (outcome: BrowserTargetOutcome, fields: Record<string, unknown> = {}) => {
    if (targets.stats) {
      if (outcome === "executed") targets.stats.executed += 1;
      else targets.stats.returned += 1;
    }
    getLogger().info("agent.browser.target", {
      runId: context.runId,
      botId: context.botId,
      kind: step.kind,
      outcome,
      options: candidates.length,
      ...fields,
    });
  };
  if (candidates.length === 0) {
    report("returned_none");
    return { returned: needsRef(snapshot) };
  }
  if (targets.stats) targets.stats.calls += 1;
  const byRef = new Map(candidates.map((element) => [element.ref, element]));
  const decision = await decideWithin(
    targets.provider,
    targetRequest(snapshot, candidates, step.target, targets.secrets),
    context,
    { timeoutMs: TARGET_DECISION_TIMEOUT_MS },
  );
  if (!decision.ok) {
    if (decision.reason === "aborted") context.signal.throwIfAborted();
    report("returned_unavailable", { reason: decision.reason });
    return { returned: needsRef(snapshot, { reason: decision.reason }) };
  }
  const answer = decision.answers.target;
  if (answer?.type !== "choice" || answer.choice === NONE_OPTION) {
    report("returned_none");
    return { returned: needsRef(snapshot) };
  }
  const confidence = Number(answer.confidence.toFixed(3));
  if (answer.confidence < TARGET_CONFIDENCE_HIGH) {
    report("returned_low_confidence", { confidence });
    const ranked = topChoices(answer, TARGET_CANDIDATE_COUNT + 1)
      .filter((choice) => choice.key !== NONE_OPTION)
      .slice(0, TARGET_CANDIDATE_COUNT)
      .map((choice) => ({
        ref: choice.key,
        name: byRef.get(choice.key)?.name ?? "",
        probability: Number(choice.probability.toFixed(3)),
      }));
    return { returned: needsRef(snapshot, { candidates: ranked }) };
  }
  report("executed", { confidence, role: byRef.get(answer.choice)?.role });
  return { ref: answer.choice };
}

function targetRequest(
  snapshot: BrowserSnapshotResult,
  candidates: BrowserSnapshotNode[],
  target: string,
  secrets: string[],
): DecisionRequest {
  const redact = (text: string) => redactSecrets(text, secrets);
  // Role and name only: no field values, and never the page text that opens `tree`.
  const options: Record<string, string> = {};
  for (const element of candidates) {
    options[element.ref] = redact(
      `${element.role} ${JSON.stringify(truncate(element.name, MAX_OPTION_NAME_CHARS))}`,
    );
  }
  options[NONE_OPTION] = "no listed element matches";
  return {
    state: { url: redact(snapshot.url), title: redact(snapshot.title) },
    questions: {
      target: {
        type: "choice",
        instructions: redact(
          `Which element matches: ${target}? Answer none if no listed element does.`,
        ),
        options,
      },
    },
  };
}

function needsRef(
  snapshot: BrowserSnapshotResult,
  extra: Pick<BrowserActToolResult, "candidates" | "reason"> = {},
): BrowserActToolResult {
  return {
    ok: false,
    completed: 0,
    needsRef: true,
    url: snapshot.url,
    title: snapshot.title,
    tree: snapshot.tree,
    elements: snapshot.elements,
    ...(extra.candidates?.length ? { candidates: extra.candidates } : {}),
    ...(extra.reason ? { reason: extra.reason } : {}),
    note: "No element was chosen for the target. Pick a ref from elements or candidates and call browser_act with ref.",
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function formatBrowserResult<T extends { fallback?: "computer_act"; error?: string }>(result: T) {
  if (result.fallback === "computer_act") {
    return {
      ...result,
      note: "Page browser could not complete this step. Inspect the current state before continuing with computer_act if available, otherwise request_takeover. Do not replay completed or uncertain actions.",
    };
  }
  return result;
}
