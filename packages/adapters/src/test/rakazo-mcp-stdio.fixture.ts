import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { NativeSessionHost, ReserveResult } from "../native-session-host.js";
import type { McpBridgeDeps } from "../rakazo-mcp-bridge.js";
import { readTicketFromEnvironment, runNativeToolServerStdio } from "../rakazo-mcp-stdio.js";

/**
 * Test-only launcher: a real process, spawned by
 * `rakazo-mcp-stdio.test.ts` over a real stdio transport, that reuses the
 * production `runNativeToolServerStdio`/`readTicketFromEnvironment` but
 * wires a fixture `NativeSessionHost`/callback instead of the
 * Postgres-backed one (which belongs to the composed runtime, out of
 * scope here). The production entry point (`rakazo-mcp-stdio.ts`) never
 * offers this fixture mode itself — B5: a binary a native runtime can
 * actually spawn must refuse to start without real composition, not fall
 * back to a fixture behind an environment flag. It observes effects
 * through a resource external to the process — an append-only log file
 * named by `RAKAZO_MCP_STDIO_FIXTURE_LOG` — never a spy on internal calls.
 */
function buildFixtureDeps(env: NodeJS.ProcessEnv, ticket: string): McpBridgeDeps {
  const logPath = env.RAKAZO_MCP_STDIO_FIXTURE_LOG;
  if (!logPath) {
    throw new Error("RAKAZO_MCP_STDIO_FIXTURE_LOG is required to run this test launcher");
  }
  const seenCallIds = new Set<string>();
  const binding = { botId: "fixture-bot", threadId: "fixture-thread", generation: 0 };
  const host: NativeSessionHost = {
    async ensureBinding() {
      return { generation: binding.generation };
    },
    async advanceGeneration() {
      binding.generation += 1;
      return { generation: binding.generation };
    },
    async issueTicket() {
      return { ticket, generation: binding.generation };
    },
    async revokeTicket() {
      // Not exercised by this fixture: the fixture process serves a single,
      // already-issued ticket for its whole lifetime.
    },
    async reserveCall(callTicket, callId): Promise<ReserveResult> {
      if (callTicket !== ticket) return { ok: false, reason: "stale_attempt" };
      if (seenCallIds.has(callId)) return { ok: false, reason: "duplicate_call" };
      seenCallIds.add(callId);
      return { ok: true, ...binding };
    },
  };
  return {
    host,
    catalog: new Set(["resource.write"]),
    async callTool(_name, args, resolvedBinding) {
      appendFileSync(logPath, `${JSON.stringify({ args, botId: resolvedBinding.botId })}\n`);
      return { applied: args.value };
    },
  };
}

async function main(): Promise<void> {
  const ticket = readTicketFromEnvironment();
  await runNativeToolServerStdio(buildFixtureDeps(process.env, ticket), ticket);
}

const isMainModule =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(
      `rakazo-mcp-stdio.fixture: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
