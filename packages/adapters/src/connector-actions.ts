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
  if (!isComposioBatch(toolName)) return undefined;
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

/** Whether a tool is Composio's batch, whether named bare, MCP-prefixed or as a catalog id. */
export function isComposioBatch(toolName: string): boolean {
  return wrapperName(toolName) === COMPOSIO_BATCH_TOOL;
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
