import { DEFAULT_MODEL_MAX_TOKENS } from "@rakazo/contracts";

/** Hung completions must fail before the typical 5-minute run lease. */
export const MODEL_STREAM_TIMEOUT_MS = 120_000;
/** One retry keeps a transient blip from killing the turn without outliving the lease. */
export const MODEL_STREAM_MAX_RETRIES = 1;

export const TOOL_RESULT_TEXT_LIMIT = 12_000;

const cutNotice = (omitted: number) => `\n[${omitted} more characters cut]`;

/** A prefix that never ends in half a surrogate pair. */
const head = (text: string, chars: number) => Buffer.from(text.slice(0, chars)).toString();

/** Text kept from `total` characters so the kept text and its notice fit `limit` together. */
const keptChars = (total: number, limit: number) => Math.max(0, limit - cutNotice(total).length);

/** Kept text and notice fit `limit`, so clipping clipped text changes nothing. */
export function clipToolResultText(text: string, limit: number = TOOL_RESULT_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const kept = keptChars(text.length, limit);
  return `${head(text, kept)}${cutNotice(text.length - kept)}`;
}

const isTextPart = (part: unknown): part is { type: "text"; text: unknown } =>
  Boolean(part) &&
  typeof part === "object" &&
  (part as { type?: unknown }).type === "text" &&
  "text" in (part as object);

/**
 * Share one character budget across all text parts. Later text is omitted once it is spent, and
 * the last text kept says how much; non-text parts stay.
 */
export function clipToolResultContent<T>(
  content: T[],
  limit: number = TOOL_RESULT_TEXT_LIMIT,
): T[] {
  const total = content.reduce(
    (sum, part) => sum + (isTextPart(part) ? String(part.text).length : 0),
    0,
  );
  if (total <= limit) return content;
  let remaining = keptChars(total, limit);
  let lastText = -1;
  const clipped: T[] = [];
  for (const part of content) {
    if (!isTextPart(part)) {
      clipped.push(part);
      continue;
    }
    const text = String(part.text);
    const kept = text.length <= remaining ? text : head(text, remaining);
    remaining -= kept.length;
    if (!kept && text) continue;
    lastText = clipped.length;
    clipped.push(kept === text ? part : { ...part, text: kept });
  }
  const shown = keptChars(total, limit) - remaining;
  const notice = cutNotice(total - shown);
  if (lastText >= 0) {
    const part = clipped[lastText] as T & { text: string };
    clipped[lastText] = { ...part, text: `${part.text}${notice}` };
  }
  return clipped;
}

/** Prompt tokens providers bill, including cache read/write rather than the uncached remainder. */
export function billedPromptTokens(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens:
      nonNegativeCount(usage.input) +
      nonNegativeCount(usage.cacheRead) +
      nonNegativeCount(usage.cacheWrite),
    outputTokens: nonNegativeCount(usage.output),
  };
}

/**
 * Provider cache counters, passed through untouched. A provider that reports nothing keeps the
 * fields absent: a zero here would read as "the cache was cold", which is a different claim.
 */
export function providerCacheTokens(usage: { cacheRead?: number; cacheWrite?: number }): {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
} {
  return {
    ...(isCount(usage.cacheRead) ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(isCount(usage.cacheWrite) ? { cacheWriteTokens: usage.cacheWrite } : {}),
  };
}

function isCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Completions default to a modest output cap so OpenRouter-style providers do not
 * hold credit for a model card's 128k ceiling. A configured maxTokens is the escape.
 */
export function resolveCompletionMaxTokens(
  modelMaxTokens?: number,
  configuredMaxTokens?: number,
  optionsMaxTokens?: number,
): number {
  const userCap =
    typeof configuredMaxTokens === "number" && configuredMaxTokens >= 1
      ? configuredMaxTokens
      : DEFAULT_MODEL_MAX_TOKENS;
  const optionCap =
    typeof optionsMaxTokens === "number" && optionsMaxTokens >= 1
      ? Math.min(optionsMaxTokens, userCap)
      : userCap;
  if (typeof modelMaxTokens === "number" && modelMaxTokens >= 1) {
    return Math.min(modelMaxTokens, optionCap);
  }
  return optionCap;
}

function nonNegativeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
