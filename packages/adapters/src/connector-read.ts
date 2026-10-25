import type { AdapterContext, ConnectorCall, ConnectorProvider } from "@rakazo/adapter-kit";

const CACHE_LIMIT = 500;

/**
 * What a read the gate makes on a connector answered, before a card shows: never approved or
 * logged. Undefined on an error, once the run stops, or after `timeoutMs`.
 */
export async function readConnector(
  connector: Pick<ConnectorProvider, "execute">,
  call: ConnectorCall,
  context: AdapterContext,
  timeoutMs: number,
): Promise<unknown> {
  if (context.signal.aborted) return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  const stopped = new Promise<undefined>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
  const read = (async () => {
    for await (const event of connector.execute(call, { ...context, signal: controller.signal })) {
      if (event.type === "result") return event.data;
      if (event.type === "error") return undefined;
    }
    return undefined;
  })().catch(() => undefined);
  try {
    return await Promise.race([read, stopped]);
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", abort);
  }
}

/** Keeps `value` under `key`, dropping the oldest entry once the cache is full. */
export function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  const oldest = cache.size >= CACHE_LIMIT ? cache.keys().next().value : undefined;
  if (oldest !== undefined) cache.delete(oldest);
  cache.set(key, value);
}

/**
 * The first thing `pick` finds in a connector's result, however the connector wrapped it: in
 * nested data, a batch's per-action responses, or an MCP result's structured or JSON text content.
 */
export function findInResult<T>(
  value: unknown,
  pick: (record: Record<string, unknown>) => T | undefined,
  depth = 0,
): T | undefined {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInResult(item, pick, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const own = pick(value);
  if (own !== undefined) return own;
  if (value.type === "text" && typeof value.text === "string") {
    try {
      return findInResult(JSON.parse(value.text), pick, depth + 1);
    } catch {
      return undefined;
    }
  }
  for (const child of Object.values(value)) {
    const found = findInResult(child, pick, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
