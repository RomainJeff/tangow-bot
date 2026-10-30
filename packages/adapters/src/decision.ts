import type {
  AdapterContext,
  DecisionAnswer,
  DecisionProvider,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
  DecisionResult,
  DecisionUnavailableReason,
  ToolCallTrace,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { combineSignals } from "./connector-safety.js";

const PROBABILITY_TOLERANCE = 1e-3;
/**
 * Providers round each probability (OpenRouter documents two decimals), so the sum of
 * n rounded entries can drift from 1 by up to n × half a unit.
 */
const ROUNDING_TOLERANCE_PER_ENTRY = 0.005;

class DecisionTimeoutError extends Error {}

/** What a call is for, logged only, so each use is measured separately. */
export type DecisionPurpose = "run_step" | "tool_approval" | "model_route";

/** Which validation check rejected a provider answer. Codes only, never content. */
type InvalidCheck =
  | "no_answers"
  | "missing_answer"
  | "wrong_type"
  | "not_in_options"
  | "bad_probability"
  | "bad_confidence"
  | "bad_score"
  | "bad_distribution"
  | "missing_chosen_probability";

interface InvalidAnswer {
  check: InvalidCheck;
  question?: string;
  key?: string;
  sum?: number;
  entries?: number;
}

interface DecisionOutcome {
  result: DecisionResult;
  /** What the provider returned, kept to trace a rejected answer. */
  response?: unknown;
  invalid?: InvalidAnswer;
}

export interface DecideOptions {
  timeoutMs: number;
  purpose?: DecisionPurpose;
  /**
   * Questions whose answer may be malformed without failing the call: an invalid answer
   * to one of them is dropped from the result, never returned. Speculative per-branch
   * questions go here; the question that picks the branch does not.
   */
  optional?: readonly string[];
  /** Observation name in the trace; defaults to `decision <purpose>`. */
  traceName?: string;
  /** Records the call nested under the tool call that made it, when the run is traced. */
  trace?: ToolCallTrace;
  /** Caller facts derived from the result, added to the trace only. */
  traceMetadata?: (result: DecisionResult) => Record<string, string | number | boolean | undefined>;
}

/**
 * The only way callers ask a decision provider anything. Never throws: every
 * failure becomes an `unavailable` reason the caller treats as "carry on as
 * without a provider". After `aborted`, the caller rethrows its own run abort.
 * Logs counters and ids only, never state or option text.
 */
export async function decideWithin(
  provider: DecisionProvider | undefined,
  request: DecisionRequest,
  context: AdapterContext,
  options: DecideOptions,
): Promise<DecisionResult> {
  const started = Date.now();
  const generation = options.trace?.generation(
    options.traceName ?? `decision ${options.purpose ?? "call"}`,
    request,
  );
  const outcome = await decide(provider, request, context, options.timeoutMs, options.optional);
  const call = describeCall(provider, request, outcome, Date.now() - started, options.purpose);
  logDecisionCall(context, call, outcome);
  if (generation) {
    const { result, response, invalid } = outcome;
    const reported = reportedResponse(response);
    generation.end({
      output: result.ok
        ? result.answers
        : {
            unavailable: result.reason,
            ...(result.error ? { error: result.error } : {}),
            ...(invalid
              ? { invalid, answers: (response as { answers?: unknown } | undefined)?.answers }
              : {}),
          },
      model: reported.model,
      usage: reported.usage,
      metadata: { ...call, ...options.traceMetadata?.(result) },
      ...(result.ok ? {} : { error: result.reason }),
    });
  }
  return outcome.result;
}

async function decide(
  provider: DecisionProvider | undefined,
  request: DecisionRequest,
  context: AdapterContext,
  timeoutMs: number,
  optional: readonly string[] = [],
): Promise<DecisionOutcome> {
  if (!provider) return unavailable("no_provider");
  if (context.signal.aborted) return unavailable("aborted");
  let supported: boolean;
  try {
    supported = supportsRequest(provider, request);
  } catch (error) {
    return unavailable("error", errorName(error));
  }
  if (!supported) return unavailable("error", "UnsupportedDecisionRequest");

  const timeout = new AbortController();
  const signal = combineSignals(context.signal, timeout.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeout.abort();
      reject(new DecisionTimeoutError());
    }, timeoutMs);
  });
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  let response: DecisionResponse;
  try {
    // Race so a provider that ignores its signal still cannot hold the caller past the budget.
    const call = Promise.resolve().then(() => provider.decide(request, { ...context, signal }));
    response = await Promise.race([call, timedOut, aborted]);
    call.catch(() => undefined);
  } catch (error) {
    if (context.signal.aborted) return unavailable("aborted");
    if (timeout.signal.aborted || error instanceof DecisionTimeoutError) {
      return unavailable("timeout");
    }
    return unavailable("error", errorName(error));
  } finally {
    clearTimeout(timer);
    timedOut.catch(() => undefined);
    aborted.catch(() => undefined);
  }
  if (context.signal.aborted) return unavailable("aborted");
  const checked = checkResponse(request, response, new Set(optional));
  return "check" in checked
    ? { result: { ok: false, reason: "invalid_answer" }, response, invalid: checked }
    : { result: { ok: true, ...response, answers: checked.answers }, response };
}

function supportsRequest(provider: DecisionProvider, request: DecisionRequest): boolean {
  const capabilities = provider.describe().capabilities;
  const questions = Object.values(request.questions);
  if (questions.length === 0) return false;
  return questions.every((question) => {
    if (!capabilities[question.type]) return false;
    if (question.type === "choice") {
      const count = Object.keys(question.options).length;
      return count > 0 && count <= capabilities.maxOptions;
    }
    if (question.type === "score") return question.levels.length >= 2;
    return true;
  });
}

/** The validated answers, keyed by question, or the first issue with a required one. */
function checkResponse(
  request: DecisionRequest,
  response: unknown,
  optional: ReadonlySet<string>,
): InvalidAnswer | { answers: Record<string, DecisionAnswer> } {
  const answers =
    response && typeof response === "object"
      ? (response as { answers?: unknown }).answers
      : undefined;
  if (!answers || typeof answers !== "object") return { check: "no_answers" };
  const valid: Record<string, DecisionAnswer> = {};
  for (const [name, question] of Object.entries(request.questions)) {
    const raw = (answers as Record<string, unknown>)[name];
    const issue = answerIssue(question, raw);
    if (!issue) valid[name] = raw as DecisionAnswer;
    else if (!optional.has(name)) return { ...issue, question: name };
  }
  return { answers: valid };
}

function answerIssue(question: DecisionQuestion, raw: unknown): InvalidAnswer | undefined {
  if (!raw || typeof raw !== "object") return { check: "missing_answer" };
  const answer = raw as DecisionAnswer;
  if (answer.type !== question.type) return { check: "wrong_type" };
  if (answer.type === "noul") {
    return isProbability(answer.probability) ? undefined : { check: "bad_probability" };
  }
  if (answer.type === "choice" && question.type === "choice") {
    if (!Object.hasOwn(question.options, answer.choice)) return { check: "not_in_options" };
    if (!isProbability(answer.confidence)) return { check: "bad_confidence" };
    const issue = distributionIssue(answer.probabilities, Object.keys(question.options));
    if (issue) return issue;
    return Object.hasOwn(answer.probabilities, answer.choice)
      ? undefined
      : { check: "missing_chosen_probability" };
  }
  if (answer.type === "score" && question.type === "score") {
    if (
      typeof answer.score !== "number" ||
      answer.score < 0 ||
      answer.score > question.levels.length - 1
    ) {
      return { check: "bad_score" };
    }
    if (!isProbability(answer.confidence)) return { check: "bad_confidence" };
    return distributionIssue(
      answer.probabilities,
      question.levels.map((_, index) => String(index)),
    );
  }
  return { check: "wrong_type" };
}

function distributionIssue(value: unknown, keys: string[]): InvalidAnswer | undefined {
  if (!value || typeof value !== "object") return { check: "bad_distribution" };
  const allowed = new Set(keys);
  const entries = Object.entries(value);
  let total = 0;
  for (const [key, probability] of entries) {
    if (!allowed.has(key)) return { check: "not_in_options", key };
    if (!isProbability(probability)) return { check: "bad_distribution", key };
    total += probability;
  }
  const tolerance = PROBABILITY_TOLERANCE + ROUNDING_TOLERANCE_PER_ENTRY * entries.length;
  if (Math.abs(total - 1) <= tolerance) return undefined;
  return { check: "bad_distribution", sum: Number(total.toFixed(6)), entries: entries.length };
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Highest-probability options of a validated `choice` answer, best first. */
export function topChoices(
  answer: Extract<DecisionAnswer, { type: "choice" }>,
  count: number,
): Array<{ key: string; probability: number }> {
  return Object.entries(answer.probabilities)
    .map(([key, probability]) => ({ key, probability }))
    .sort((a, b) => b.probability - a.probability || a.key.localeCompare(b.key))
    .slice(0, count);
}

function unavailable(reason: DecisionUnavailableReason, error?: string): DecisionOutcome {
  return { result: error ? { ok: false, reason, error } : { ok: false, reason } };
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name || "Error";
  return "Error";
}

/** Model and usage the provider reported, read defensively since a rejected answer is untyped. */
function reportedResponse(response: unknown): {
  model?: string;
  usage?: { inputTokens?: number; cost?: number };
} {
  if (!response || typeof response !== "object") return {};
  const { model, usage } = response as { model?: unknown; usage?: unknown };
  const reported: { model?: string; usage?: { inputTokens?: number; cost?: number } } = {};
  if (typeof model === "string") reported.model = model;
  if (usage && typeof usage === "object") {
    const { inputTokens, cost } = usage as { inputTokens?: unknown; cost?: unknown };
    reported.usage = {
      ...(typeof inputTokens === "number" ? { inputTokens } : {}),
      ...(typeof cost === "number" ? { cost } : {}),
    };
  }
  return reported;
}

/** Counters and ids shared by the log line and the trace; never state or option text. */
function describeCall(
  provider: DecisionProvider | undefined,
  request: DecisionRequest,
  outcome: DecisionOutcome,
  durationMs: number,
  purpose: DecisionPurpose | undefined,
) {
  const questions = Object.values(request.questions);
  const options = questions.reduce(
    (total, question) =>
      total + (question.type === "choice" ? Object.keys(question.options).length : 0),
    0,
  );
  let providerId: string | undefined;
  try {
    providerId = provider?.describe().id;
  } catch {
    providerId = undefined;
  }
  const { result } = outcome;
  return {
    provider: providerId,
    purpose,
    durationMs,
    outcome: result.ok ? "answered" : result.reason,
    questions: questions.length,
    options,
    invalidDetail: outcome.invalid?.check,
  };
}

function logDecisionCall(
  context: AdapterContext,
  call: ReturnType<typeof describeCall>,
  outcome: DecisionOutcome,
): void {
  const { result } = outcome;
  const confidences = result.ok
    ? Object.values(result.answers).flatMap((answer) =>
        answer.type === "noul" ? [] : [Number(answer.confidence.toFixed(3))],
      )
    : [];
  getLogger().info("agent.decision.call", {
    runId: context.runId,
    botId: context.botId,
    spaceId: context.spaceId,
    provider: call.provider,
    purpose: call.purpose,
    durationMs: call.durationMs,
    outcome: call.outcome,
    invalidDetail: call.invalidDetail,
    errorClass: result.ok ? undefined : result.error,
    questions: call.questions,
    options: call.options,
    confidence: confidences.length === 1 ? confidences[0] : undefined,
    model: result.ok ? result.model : undefined,
    inputTokens: result.ok ? result.usage?.inputTokens : undefined,
    cost: result.ok ? result.usage?.cost : undefined,
  });
}
