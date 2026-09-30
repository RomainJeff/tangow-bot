/**
 * Codex and Claude already own shell, files, and computer control. MCP must never
 * duplicate those capabilities or expose a control flow that parks a run.
 */
const DENIED_NATIVE_MCP_TOOL_NAMES = new Set([
  "shell",
  "read_file",
  "write_file",
  "list_files",
  // A nested run_subagent turn parks its caller and cannot complete through this relay.
  "run_subagent",
  "ask_user",
  "request_takeover",
  "request_secret",
  "create_space",
]);

export function nativeMcpToolsForRun<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter(
    (tool) => !DENIED_NATIVE_MCP_TOOL_NAMES.has(tool.name) && !tool.name.startsWith("computer_"),
  );
}
