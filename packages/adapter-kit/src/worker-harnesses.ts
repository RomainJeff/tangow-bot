import type { HarnessDeclaration } from "./worker-protocol.js";

export const PI_NATIVE_HARNESS: HarnessDeclaration = {
  name: "pi-native",
  capabilities: ["native-loop", "steering", "subagents"],
};

/** What a worker harness calls a Rakazo tool: the controller's MCP server is named `rakazo`. */
export const RAKAZO_TOOL_PREFIX = "mcp__rakazo__";

/** Resolve the controller's selected harness without loading a guest implementation. */
export function workerHarness(name: string): HarnessDeclaration {
  switch (name) {
    case "pi-native":
      return PI_NATIVE_HARNESS;
    default:
      throw new Error(`Unknown worker harness: ${name}`);
  }
}
