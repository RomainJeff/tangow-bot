import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpBridgeDeps } from "./rakazo-mcp-bridge.js";
import { createRakazoMcpServer } from "./rakazo-mcp-server.js";

/**
 * The process a native runtime spawns for one attempt (`endpoint.command`
 * from `createNativeToolServer`). It reads its ticket from
 * `RAKAZO_MCP_TICKET` — never from the MCP tool schema the model sees — and
 * refuses to start without it, with a constant message that never echoes an
 * environment value (there is nothing to leak: the ticket, when present, is
 * never printed either).
 */
export function readTicketFromEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  const ticket = env.RAKAZO_MCP_TICKET;
  if (!ticket) {
    throw new Error("RAKAZO_MCP_TICKET is required to start the Rakazo native MCP stdio endpoint");
  }
  return ticket;
}

export async function runNativeToolServerStdio(deps: McpBridgeDeps, ticket: string): Promise<void> {
  const server = createRakazoMcpServer(deps, { ticket });
  await server.connect(new StdioServerTransport());
}

async function main(): Promise<void> {
  // Reading the ticket (and refusing without it) is the only thing this
  // entry point does on its own. Real production wiring (Postgres-backed
  // NativeSessionHost, the real callback) is composed by the native
  // runtime, not by this entry point in this loop — see the receipt's
  // "besoin transmis au coordinateur". This binary never falls back to a
  // fixture: a test that needs one spawns its own launcher
  // (`test/rakazo-mcp-stdio.fixture.ts`), which reuses
  // `runNativeToolServerStdio` below but supplies fixture deps itself.
  readTicketFromEnvironment();
  process.stderr.write(
    "rakazo-mcp-stdio: no production dependencies wired for this entry point yet\n",
  );
  process.exitCode = 1;
}

const isMainModule =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(`rakazo-mcp-stdio: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
