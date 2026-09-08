import { redactSecrets } from "@rakazo/core";

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => Boolean(signal)));
}

/**
 * undici collapses every network failure to "fetch failed"; the cause names the host and
 * errno, which is the only part worth acting on. Walk the chain so it reaches the caller.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  let cause: unknown = error.cause;
  for (let depth = 0; depth < 3 && cause instanceof Error; depth += 1) {
    const code = "code" in cause && typeof cause.code === "string" ? ` (${cause.code})` : "";
    const detail = `${cause.message}${code}`;
    if (!parts.includes(detail)) parts.push(detail);
    cause = cause.cause;
  }
  return parts.join(": ");
}

export function sanitizeConnectorError(error: unknown, secrets: string[] = []): string {
  const message = describeError(error);
  return redactSecrets(
    message
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/trg_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted]"),
    secrets,
  ).slice(0, 2_000);
}

export function redactConnectorPayload(value: unknown, secrets: string[]): unknown {
  if (secrets.length === 0) return value;
  try {
    return redactPayloadValue(JSON.parse(JSON.stringify(value)), secrets);
  } catch {
    return { ok: true };
  }
}

function redactPayloadValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactPayloadValue(item, secrets));
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    const serialized = String(value);
    return redactSecrets(serialized, secrets) === serialized ? value : "[redacted]";
  }
  if (typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redactSecrets(key, secrets),
      redactPayloadValue(item, secrets),
    ]),
  );
}
