import type { ConnectorTool } from "@rakazo/adapter-kit";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set(["recall_memory", "save_memory", "forget_memory"]);

/** With `keepRemember`, a shared bot keeps `remember` for its team beside semantic memory. */
export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
  keepRemember = false,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools.filter((tool) => keepRemember || tool.name !== "remember")
    : tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
}
