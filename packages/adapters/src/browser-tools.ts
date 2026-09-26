import type {
  AdapterContext,
  BrowserActKind,
  BrowserActResult,
  BrowserActStep,
  BrowserProvider,
  BrowserSnapshotNode,
  BrowserSnapshotResult,
  ComputerRef,
  DecisionAnswer,
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
 * with the chosen option's probability, not the answer's `confidence`, which measures
 * how peaked the whole distribution is (documented example: 0.75 for a 0.84 pick) and
 * is only logged.
 */
const TARGET_PROBABILITY_HIGH = 0.8;
const TARGET_DECISION_TIMEOUT_MS = 1_000;
const TARGET_CANDIDATE_COUNT = 3;
const NONE_OPTION = "none";
/** Controls added or removed by an action, each way, sent to verify its outcome. */
const MAX_OUTCOME_DIFF = 20;
/** Starting value before offline calibration (ticket 06); below it the outcome is uncertain. */
const OUTCOME_PROBABILITY_LOW = 0.5;
const OUTCOME_DECISION_TIMEOUT_MS = 1_000;
const OUTCOME_OPTIONS = {
  landed: "the page changed as the action intended",
  dialog: "a dialog, modal, or popup opened",
  error: "an error or validation message appeared",
  auth: "the page asks to sign in, solve a challenge, or prove the user is human",
  unchanged: "nothing visible changed",
} as const;
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
  verifyCalls: number;
  verifyAnswered: number;
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
  /** Advisory classification of the last target action; never acted on by the backend. */
  outcome?: { kind: keyof typeof OUTCOME_OPTIONS | "uncertain"; probability: number };
};

/** The last executed target action, kept to verify what it did. */
interface ExecutedTarget {
  kind: BrowserActKind;
  element: BrowserSnapshotNode;
  before: BrowserSnapshotResult;
}

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
function parseBrowserActToolSteps(value: unknown): BrowserActToolStep[] {
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
  let executed: ExecutedTarget | undefined;
  if (refSteps.length > 0) {
    last = await browser.act(computer, { actions: refSteps, signal: context.signal }, context);
    if (!last.ok) return last;
    completed = last.completed;
  }
  for (const step of steps) {
    if (!("target" in step)) continue;
    const resolved = await resolveBrowserTarget(browser, computer, context, step, targets);
    if ("returned" in resolved) return { ...resolved.returned, completed };
    const { ref } = resolved.element;
    const action: BrowserActStep =
      step.kind === "click" ? { kind: "click", ref } : { kind: step.kind, ref, text: step.text };
    // A ref gone stale since the snapshot fails in the provider and is returned, never retargeted.
    last = await browser.act(computer, { actions: [action], signal: context.signal }, context);
    if (!last.ok) return { ...last, completed: completed + last.completed };
    completed += last.completed;
    executed = { kind: step.kind, element: resolved.element, before: resolved.snapshot };
  }
  const result: BrowserActToolResult = { ...last!, completed };
  // Only after a confirmed success: a failed or uncertain act has already returned above.
  if (executed && last!.elements) {
    const outcome = await verifyBrowserOutcome(executed, last!, targets, context);
    if (outcome) result.outcome = outcome;
  }
  return result;
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
): Promise<
  | { element: BrowserSnapshotNode; snapshot: BrowserSnapshotResult }
  | { returned: BrowserActToolResult }
> {
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
    { timeoutMs: TARGET_DECISION_TIMEOUT_MS, purpose: "target" },
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
  // decideWithin rejects a choice missing from its own probabilities.
  const probability = answer.probabilities[answer.choice]!;
  if (probability < TARGET_PROBABILITY_HIGH) {
    report("returned_low_confidence", { confidence, probability: Number(probability.toFixed(3)) });
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
  const element = byRef.get(answer.choice)!;
  report("executed", {
    confidence,
    probability: Number(probability.toFixed(3)),
    role: element.role,
  });
  return { element, snapshot };
}

/**
 * Classify what the last target action produced from the before and after
 * snapshots. Advisory only: the result is annotated, never replayed or escalated.
 */
async function verifyBrowserOutcome(
  executed: ExecutedTarget,
  after: BrowserActResult,
  targets: BrowserTargetOptions,
  context: AdapterContext,
): Promise<BrowserActToolResult["outcome"]> {
  const report = (outcome: string, fields: Record<string, unknown> = {}) => {
    getLogger().info("agent.browser.outcome", {
      runId: context.runId,
      botId: context.botId,
      kind: executed.kind,
      outcome,
      options: Object.keys(OUTCOME_OPTIONS).length,
      ...fields,
    });
  };
  if (targets.stats) targets.stats.verifyCalls += 1;
  const decision = await decideWithin(
    targets.provider,
    outcomeRequest(executed, after, targets.secrets),
    context,
    { timeoutMs: OUTCOME_DECISION_TIMEOUT_MS, purpose: "verify" },
  );
  if (!decision.ok) {
    if (decision.reason === "aborted") context.signal.throwIfAborted();
    report(decision.reason);
    return undefined;
  }
  // decideWithin guarantees a choice from the offered options with its probability.
  const answer = decision.answers.outcome as Extract<DecisionAnswer, { type: "choice" }>;
  if (targets.stats) targets.stats.verifyAnswered += 1;
  const probability = Number(answer.probabilities[answer.choice]!.toFixed(3));
  const kind =
    probability < OUTCOME_PROBABILITY_LOW
      ? "uncertain"
      : (answer.choice as keyof typeof OUTCOME_OPTIONS);
  report(kind, { probability, confidence: Number(answer.confidence.toFixed(3)) });
  return { kind, probability };
}

function outcomeRequest(
  executed: ExecutedTarget,
  after: BrowserActResult,
  secrets: string[],
): DecisionRequest {
  const redact = (text: string) => redactSecrets(text, secrets);
  // Redact before truncating so a cut can never leave part of a secret behind.
  const name = (element: BrowserSnapshotNode) =>
    truncate(redact(element.name), MAX_OPTION_NAME_CHARS);
  const label = (element: BrowserSnapshotNode) =>
    `${element.role} ${JSON.stringify(name(element))}`;
  const before = executed.before;
  const afterElements = after.elements ?? [];
  // Refs are renumbered on every snapshot, so compare controls by role and name.
  const { added, removed } = multisetDiff(before.elements.map(label), afterElements.map(label));
  // Counts and control names only: never `tree` (page text) or field values.
  return {
    state: {
      action: { kind: executed.kind, role: executed.element.role, name: name(executed.element) },
      before: {
        url: redact(before.url),
        title: redact(before.title),
        elements: before.elements.length,
      },
      after: { url: redact(after.url), title: redact(after.title), elements: afterElements.length },
      added: added.slice(0, MAX_OUTCOME_DIFF),
      removed: removed.slice(0, MAX_OUTCOME_DIFF),
    },
    questions: {
      outcome: {
        type: "choice",
        instructions: "What did the action produce?",
        options: { ...OUTCOME_OPTIONS },
      },
    },
  };
}

function multisetDiff(from: string[], to: string[]): { added: string[]; removed: string[] } {
  const extra = new Map<string, number>();
  for (const item of to) extra.set(item, (extra.get(item) ?? 0) + 1);
  const removed: string[] = [];
  for (const item of from) {
    const count = extra.get(item) ?? 0;
    if (count > 0) extra.set(item, count - 1);
    else removed.push(item);
  }
  const added: string[] = [];
  for (const item of to) {
    const count = extra.get(item) ?? 0;
    if (count > 0) {
      added.push(item);
      extra.set(item, count - 1);
    }
  }
  return { added, removed };
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
