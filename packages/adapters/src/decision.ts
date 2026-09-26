import type {
  AdapterContext,
  DecisionAnswer,
  DecisionProvider,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
  DecisionResult,
  DecisionUnavailableReason,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { combineSignals } from "./connector-safety.js";

const PROBABILITY_TOLERANCE = 1e-3;

class DecisionTimeoutError extends Error {}

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
  options: { timeoutMs: number },
): Promise<DecisionResult> {
  const started = Date.now();
  const result = await decide(provider, request, context, options.timeoutMs);
  logDecisionCall(provider, request, context, result, Date.now() - started);
  return result;
}

async function decide(
  provider: DecisionProvider | undefined,
  request: DecisionRequest,
  context: AdapterContext,
  timeoutMs: number,
): Promise<DecisionResult> {
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
  return validResponse(request, response)
    ? { ok: true, ...response }
    : unavailable("invalid_answer");
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

function validResponse(request: DecisionRequest, response: unknown): response is DecisionResponse {
  if (!response || typeof response !== "object") return false;
  const answers = (response as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object") return false;
  return Object.entries(request.questions).every(([name, question]) =>
    validAnswer(question, (answers as Record<string, unknown>)[name]),
  );
}

function validAnswer(question: DecisionQuestion, raw: unknown): raw is DecisionAnswer {
  if (!raw || typeof raw !== "object") return false;
  const answer = raw as DecisionAnswer;
  if (answer.type !== question.type) return false;
  if (answer.type === "noul") return isProbability(answer.probability);
  if (answer.type === "choice" && question.type === "choice") {
    return (
      Object.hasOwn(question.options, answer.choice) &&
      isProbability(answer.confidence) &&
      validDistribution(answer.probabilities, Object.keys(question.options))
    );
  }
  if (answer.type === "score" && question.type === "score") {
    const levels = question.levels.map((_, index) => String(index));
    return (
      typeof answer.score === "number" &&
      answer.score >= 0 &&
      answer.score <= question.levels.length - 1 &&
      isProbability(answer.confidence) &&
      validDistribution(answer.probabilities, levels)
    );
  }
  return false;
}

function validDistribution(value: unknown, keys: string[]): boolean {
  if (!value || typeof value !== "object") return false;
  const allowed = new Set(keys);
  let total = 0;
  for (const [key, probability] of Object.entries(value)) {
    if (!allowed.has(key) || !isProbability(probability)) return false;
    total += probability;
  }
  return Math.abs(total - 1) <= PROBABILITY_TOLERANCE;
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

function unavailable(reason: DecisionUnavailableReason, error?: string): DecisionResult {
  return error ? { ok: false, reason, error } : { ok: false, reason };
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name || "Error";
  return "Error";
}

function logDecisionCall(
  provider: DecisionProvider | undefined,
  request: DecisionRequest,
  context: AdapterContext,
  result: DecisionResult,
  durationMs: number,
): void {
  const questions = Object.values(request.questions);
  const options = questions.reduce(
    (total, question) =>
      total + (question.type === "choice" ? Object.keys(question.options).length : 0),
    0,
  );
  const confidences = result.ok
    ? Object.values(result.answers).flatMap((answer) =>
        answer.type === "noul" ? [] : [Number(answer.confidence.toFixed(3))],
      )
    : [];
  let providerId: string | undefined;
  try {
    providerId = provider?.describe().id;
  } catch {
    providerId = undefined;
  }
  getLogger().info("agent.decision.call", {
    runId: context.runId,
    botId: context.botId,
    spaceId: context.spaceId,
    provider: providerId,
    durationMs,
    outcome: result.ok ? "answered" : result.reason,
    errorClass: result.ok ? undefined : result.error,
    questions: questions.length,
    options,
    confidence: confidences.length === 1 ? confidences[0] : undefined,
    model: result.ok ? result.model : undefined,
    inputTokens: result.ok ? result.usage?.inputTokens : undefined,
  });
}
