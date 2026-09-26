import type { ConnectorTool } from "@rakazo/adapter-kit";

const PROVIDER_DIRECT_MEMORY_TOOL_NAMES = new Set(["save_memory", "forget_memory"]);

export function selectMemoryTools(
  tools: ConnectorTool[],
  _semanticMemoryConfigured: boolean,
): ConnectorTool[] {
  // An optional provider may accelerate a future canonical index, but it never
  // becomes a direct model write/read channel. `remember` is handled by the
  // canonical store, which records a proposal until a human accepts it.
  return tools.filter((tool) => !PROVIDER_DIRECT_MEMORY_TOOL_NAMES.has(tool.name));
}
