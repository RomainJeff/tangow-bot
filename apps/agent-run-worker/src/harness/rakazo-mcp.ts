import type { McpTransportFactory } from "@earendil-works/pi-coding-agent";
import type { GuestTool } from "@rakazo/adapter-kit";
import type { HarnessHost } from "../harness.js";
import { rakazoMcpServer } from "../rakazo-mcp.js";

type Transport = ReturnType<McpTransportFactory>;

/** The Rakazo MCP server for Pi's MCP client, whose `tool_search` loads the deferred tools. */
export function rakazoMcpTransport(
  tools: readonly GuestTool[],
  host: HarnessHost,
  screensDir: string,
  nativeCallId?: () => string | undefined,
): Transport {
  return rakazoMcpServer(tools, host, screensDir, { nativeToolSearch: true, nativeCallId });
}
