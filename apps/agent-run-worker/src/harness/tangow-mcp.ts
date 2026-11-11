import type { McpTransportFactory } from "@earendil-works/pi-coding-agent";
import type { GuestTool } from "@tangow/adapter-kit";
import type { HarnessHost } from "../harness.js";
import { rakazoMcpServer } from "../tangow-mcp.js";

type Transport = ReturnType<McpTransportFactory>;

/** The Tangow MCP server for Pi's MCP client, whose `tool_search` loads the deferred tools. */
export function rakazoMcpTransport(
  tools: readonly GuestTool[],
  host: HarnessHost,
  screensDir: string,
  nativeCallId?: () => string | undefined,
): Transport {
  return rakazoMcpServer(tools, host, screensDir, { nativeToolSearch: true, nativeCallId });
}
