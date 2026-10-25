import type { AdapterContext, ConnectorCall, ConnectorProvider } from "@rakazo/adapter-kit";
import { isRecipientField } from "@rakazo/core";
import { isComposioBatch } from "./connector-actions.js";

/** How long a draft waits for its batch item's schema before showing only what its call holds. */
const TIMEOUT_MS = 1_500;
const CACHE_LIMIT = 500;
const SCHEMA_TOOL = "COMPOSIO_GET_TOOL_SCHEMAS";

/** The recipient lines of input schemas already looked up, by route, revision and slug. */
export type BatchItemSchemaCache = Map<string, Record<string, unknown>>;

/**
 * The recipient lines of the one tool a Composio batch runs, asked of the batch's own server
 * through its route: a read with no effect, never approved or logged. Undefined on any failure or
 * after a short wait, and then not cached, so the next draft asks again.
 */
export async function lookUpBatchItemSchema(
  connector: Pick<ConnectorProvider, "execute">,
  call: ConnectorCall,
  slug: string,
  context: AdapterContext,
  cache: BatchItemSchemaCache,
): Promise<Record<string, unknown> | undefined> {
  const lookup = batchItemSchemaCall(call, slug);
  if (!lookup || context.signal.aborted) return undefined;
  const { route } = call;
  // An MCP server answers each bot by its own assignment, so one bot's answer is not another's.
  const key = [
    route?.connectorId,
    route?.resourceId,
    route?.resourceRevision,
    route?.connectorId === "mcp" ? context.botId : "",
    slug.toUpperCase(),
  ].join("\0");
  const cached = cache.get(key);
  if (cached) return cached;
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT_MS);
  const stopped = new Promise<undefined>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
  const read = (async () => {
    for await (const event of connector.execute(lookup, {
      ...context,
      signal: controller.signal,
    })) {
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

/**
 * The call that asks a Composio batch's own server for one item's input schema, through the same
 * route and connection, or undefined when the call is not Composio's batch.
 */
export function batchItemSchemaCall(call: ConnectorCall, slug: string): ConnectorCall | undefined {
  if (!isComposioBatch(call.route?.toolName ?? call.tool)) return undefined;
  return {
    tool: SCHEMA_TOOL,
    args: { tool_slugs: [slug] },
    executionId: `${call.executionId}:schema`,
    ...(call.connectionId ? { connectionId: call.connectionId } : {}),
    ...(call.route ? { route: { ...call.route, toolName: SCHEMA_TOOL } } : {}),
  };
}

/**
 * The recipient lines of the input schema a lookup answered for `slug`, wherever the server put
 * its `tool_schemas`: in the data itself, or in an MCP result's structured or JSON text content.
 * Only `type` and the recipient properties are kept: they are all a draft reads.
 */
export function batchItemSchemaIn(
  result: unknown,
  slug: string,
): Record<string, unknown> | undefined {
  const schemas = toolSchemasIn(result, 0);
  if (!schemas) return undefined;
  const key = Object.keys(schemas).find((each) => each.toUpperCase() === slug.toUpperCase());
  const entry = key === undefined ? undefined : schemas[key];
  if (!isRecord(entry)) return undefined;
  const schema = entry.input_schema ?? entry.inputSchema ?? entry.input_parameters;
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
  const recipients = Object.entries(schema.properties).filter(([name]) => isRecipientField(name));
  return recipients.length
    ? { type: schema.type, properties: Object.fromEntries(recipients) }
    : undefined;
}

function toolSchemasIn(value: unknown, depth: number): Record<string, unknown> | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = toolSchemasIn(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const own = value.tool_schemas ?? value.toolSchemas;
  if (isRecord(own)) return own;
  if (value.type === "text" && typeof value.text === "string") {
    try {
      return toolSchemasIn(JSON.parse(value.text), depth + 1);
    } catch {
      return undefined;
    }
  }
  for (const key of ["data", "structuredContent", "content"]) {
    const found = toolSchemasIn(value[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
