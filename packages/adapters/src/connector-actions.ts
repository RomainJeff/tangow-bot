/** One action a connector call will perform, in the connector's own tool naming. */
export type ConnectorAction = { toolName: string; args: Record<string, unknown> };

const COMPOSIO_BATCH_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";

/**
 * The actions a wrapper call performs, so approval judges what runs rather than the wrapper.
 * Today only Composio's batch tool (native or behind a remote MCP server) wraps actions.
 * Undefined means the call is its own action, or an envelope we cannot read: the gate then
 * judges the wrapper as before.
 */
export function connectorCallActions(
  toolName: string,
  args: Record<string, unknown>,
): ConnectorAction[] | undefined {
  if (toolName.replace(/^mcp__.+?__/, "") !== COMPOSIO_BATCH_TOOL) return undefined;
  const tools = parseTools(args.tools);
  if (!tools?.length) return undefined;
  const actions: ConnectorAction[] = [];
  for (const item of tools) {
    if (!isRecord(item) || typeof item.tool_slug !== "string" || !item.tool_slug) return undefined;
    const itemArgs = item.arguments ?? {};
    if (!isRecord(itemArgs)) return undefined;
    actions.push({ toolName: item.tool_slug, args: itemArgs });
  }
  return actions;
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
