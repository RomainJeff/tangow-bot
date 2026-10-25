import type { AdapterContext, ConnectorCall, ConnectorEvent } from "@rakazo/adapter-kit";
import { batchItemSchemaCall, batchItemSchemaIn } from "./connector-actions.js";

/** How long a draft waits for its batch item's schema before showing only what its call holds. */
export const BATCH_ITEM_SCHEMA_TIMEOUT_MS = 1_500;
const CACHE_LIMIT = 500;

/** Input schemas already looked up, by route, revision and slug. */
export type BatchItemSchemaCache = Map<string, Record<string, unknown>>;

/**
 * The input schema of the one tool a Composio batch runs, asked of the batch's own server through
 * its route: a read with no effect, never approved or logged. Undefined on any failure or after
 * `timeoutMs`, and then not cached, so the next draft asks again.
 */
export async function lookUpBatchItemSchema(
  execute: (call: ConnectorCall, context: AdapterContext) => AsyncIterable<ConnectorEvent>,
  call: ConnectorCall,
  slug: string,
  context: AdapterContext,
  cache: BatchItemSchemaCache,
  timeoutMs = BATCH_ITEM_SCHEMA_TIMEOUT_MS,
): Promise<Record<string, unknown> | undefined> {
  const lookup = batchItemSchemaCall(call, slug);
  if (!lookup) return undefined;
  const { route } = call;
  const key = [
    route?.connectorId,
    route?.resourceId,
    route?.resourceRevision,
    slug.toUpperCase(),
  ].join("\0");
  const cached = cache.get(key);
  if (cached) return cached;
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  const stopped = new Promise<undefined>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
  const read = (async () => {
    for await (const event of execute(lookup, { ...context, signal: controller.signal })) {
      if (event.type === "result") return batchItemSchemaIn(event.data, slug);
      if (event.type === "error") return undefined;
    }
    return undefined;
  })().catch(() => undefined);
  try {
    const schema = await Promise.race([read, stopped]);
    if (schema) {
      const oldest = cache.size >= CACHE_LIMIT ? cache.keys().next().value : undefined;
      if (oldest !== undefined) cache.delete(oldest);
      cache.set(key, schema);
    }
    return schema;
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", abort);
  }
}
