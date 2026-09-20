const REDACTED = "[Redacted]";
const REDACT_KEYS = new Set([
  "email",
  "prompt",
  "message",
  "messages",
  "body",
  "query",
  "rawheaders",
  "headers",
  "passwd",
  "api_key",
]);
const SECRET_KEY = /password|secret|token|authorization|cookie|credential|apikey/;
/**
 * Usage counters, not credentials. `SECRET_KEY` matches any key containing "token", which was
 * silently redacting the token counts that usage and context log lines exist to report. An exact
 * name list went stale the moment a new counter was logged, so the allowlist is value-aware
 * instead: a token counter is a number, a credential is a string. A key is kept only when it both
 * reads like a counter (a qualified `…tokens…` name — never the bare `tokens`, which can hold a
 * credential string) and carries a counter's value: a number, or a container whose leaves are all
 * numbers, as `historyTokensByRole` is. The numeric value, not the name, is what makes this safe —
 * anything that could carry a secret is a string, so it never takes this path and falls through to
 * `SECRET_KEY` as before.
 */
const TOKEN_COUNTER_KEY = /^[a-z0-9_]+tokens[a-z0-9_]*$/;
/** Bounded so a self-referencing binding cannot spin here; over the limit we fail closed. */
const TOKEN_COUNTER_MAX_DEPTH = 4;

function isTokenCount(value: unknown, depth = 0): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (value === null || typeof value !== "object") return false;
  if (value instanceof Date || value instanceof Error) return false;
  if (depth >= TOKEN_COUNTER_MAX_DEPTH) return false;
  const leaves = Array.isArray(value) ? value : Object.values(value);
  return leaves.every((leaf) => isTokenCount(leaf, depth + 1));
}

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (value instanceof Error) {
    const output: Record<string, unknown> = {
      name: value.name || "Error",
      message: redactSensitiveText(value.message),
    };
    if (typeof value.stack === "string" && value.stack.length > 0) {
      output.stack = redactSensitiveText(value.stack);
    }
    if (value.cause !== undefined) {
      output.cause =
        typeof value.cause === "string"
          ? redactSensitiveText(value.cause)
          : redactValue(value.cause, seen);
    }
    return output;
  }
  if (value instanceof Date) return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = shouldRedactKey(key, nested) ? REDACTED : redactValue(nested, seen);
  }
  return output;
}

export function redactBindings(bindings: Record<string, unknown>): Record<string, unknown> {
  return redactValue(bindings) as Record<string, unknown>;
}

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER = /\bBearer\s+[^\s"',;&]+/gi;
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:password|secret|token|authorization|apikey|api_key)[A-Za-z0-9_]*)\s*[:=]\s*\S+/gi;
const JSON_SECRET_FIELD =
  /"(password|passwd|secret|token|authorization|apikey|api_key|accesstoken|refreshtoken|email|cookie)"\s*:\s*"(?:\\.|[^"\\])*"/gi;
const BARE_SECRET =
  /\b(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:ak_|ck_)[A-Za-z0-9]+)\b/g;

export function redactSensitiveText(text: string): string {
  return text
    .replace(EMAIL, REDACTED)
    .replace(JSON_SECRET_FIELD, `"$1":"${REDACTED}"`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(BARE_SECRET, REDACTED);
}

function shouldRedactKey(key: string, value: unknown): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (TOKEN_COUNTER_KEY.test(normalized) && isTokenCount(value)) return false;
  return REDACT_KEYS.has(normalized) || SECRET_KEY.test(normalized);
}
