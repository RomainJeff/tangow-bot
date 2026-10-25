import type { ConnectorCall } from "@rakazo/adapter-kit";
/** One action a connector call will perform, in the connector's own tool naming. */
export type ConnectorAction = { toolName: string; args: Record<string, unknown> };

/**
 * What a wrapper call performs. `serialized` items arrived as one JSON string. `opaque` is a
 * wrapper whose items cannot be read.
 */
export type ConnectorCallActions =
  | { kind: "actions"; actions: ConnectorAction[]; serialized: boolean }
  | { kind: "opaque" };

const COMPOSIO_BATCH_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";
const OPAQUE = { kind: "opaque" } as const;

/**
 * The actions a wrapper call performs, so approval judges what runs rather than the wrapper.
 * Today only Composio's batch tool (native or behind a remote MCP server) wraps actions.
 * Undefined means the call is its own action.
 */
export function connectorCallActions(
  toolName: string,
  args: Record<string, unknown>,
): ConnectorCallActions | undefined {
  if (wrapperName(toolName) !== COMPOSIO_BATCH_TOOL) return undefined;
  const tools = parseTools(args.tools);
  if (!tools?.length) return OPAQUE;
  const actions: ConnectorAction[] = [];
  for (const item of tools) {
    if (!isRecord(item) || typeof item.tool_slug !== "string" || !item.tool_slug) return OPAQUE;
    const itemArgs = item.arguments ?? {};
    if (!isRecord(itemArgs)) return OPAQUE;
    actions.push({ toolName: item.tool_slug, args: itemArgs });
  }
  return { kind: "actions", actions, serialized: typeof args.tools === "string" };
}

/** The tool's own name, whether it comes bare, MCP-prefixed or as a catalog id. */
function wrapperName(toolName: string): string {
  const name = decodePercent(toolName.trim().replace(/^mcp__.+?__/, ""));
  return name
    .slice(name.lastIndexOf(":") + 1)
    .trim()
    .toUpperCase();
}

function decodePercent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseTools(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const COMPOSIO_SCHEMA_TOOL = "COMPOSIO_GET_TOOL_SCHEMAS";

/**
 * The call that asks a Composio batch's own server for one item's input schema, through the same
 * route and connection, or undefined when the call is not Composio's batch.
 */
export function batchItemSchemaCall(call: ConnectorCall, slug: string): ConnectorCall | undefined {
  if (wrapperName(call.route?.toolName ?? call.tool) !== COMPOSIO_BATCH_TOOL) return undefined;
  return {
    tool: COMPOSIO_SCHEMA_TOOL,
    args: { tool_slugs: [slug] },
    executionId: `${call.executionId}:schema`,
    ...(call.connectionId ? { connectionId: call.connectionId } : {}),
    ...(call.route ? { route: { ...call.route, toolName: COMPOSIO_SCHEMA_TOOL } } : {}),
  };
}

/**
 * The input schema a schema lookup answered for `slug`, wherever the server put its
 * `tool_schemas`: in the data itself, or in an MCP result's structured or JSON text content.
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
  return isRecord(schema) && isRecord(schema.properties) ? schema : undefined;
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
