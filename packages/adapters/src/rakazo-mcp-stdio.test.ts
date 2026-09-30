import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

/**
 * A real `Client` (SDK) drives these tests over a real spawned process
 * (`StdioClientTransport`) running `rakazo-mcp-stdio.ts` via `tsx` — the
 * genuine entry point a native runtime's `endpoint.command` would launch,
 * not an in-process stand-in. The effect of a tool call is observed through
 * a resource external to the child process (an append-only log file), never
 * a spy on it.
 */
const entryPointPath = fileURLToPath(new URL("./rakazo-mcp-stdio.ts", import.meta.url));
const fixtureLauncherPath = fileURLToPath(
  new URL("./test/rakazo-mcp-stdio.fixture.ts", import.meta.url),
);
// `node --import tsx/esm` registers tsx's TypeScript loader hook without
// spawning tsx's own CLI watch-mode IPC server (which the sandbox refuses to
// bind a unix socket for).
const tsxEsmSpecifier = createRequire(import.meta.url).resolve("tsx/esm");

const tmpLogPaths: string[] = [];

afterEach(() => {
  for (const p of tmpLogPaths.splice(0)) {
    rmSync(p, { force: true });
  }
});

function fixtureLogPath(): string {
  const p = `${process.env.TMPDIR ?? "/tmp"}/rakazo-mcp-stdio-fixture-${randomUUID()}.log`;
  tmpLogPaths.push(p);
  return p;
}

describe("rakazo-mcp-stdio entry point (real spawned process)", () => {
  it("refuses to start without RAKAZO_MCP_TICKET: non-zero exit, no secret in the message", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", tsxEsmSpecifier, entryPointPath],
      env: { ...processEnvAsStrings() },
      stderr: "pipe",
    });

    const stderrChunks: Buffer[] = [];
    transport.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const client = new Client({ name: "t02-refuse-test-client", version: "0.0.0" });
    await expect(client.connect(transport)).rejects.toBeTruthy();

    const stderrText = Buffer.concat(stderrChunks).toString("utf8");
    expect(stderrText).toContain("RAKAZO_MCP_TICKET is required");
    // No ticket was ever given, so there is nothing to leak; the message
    // must stay the constant string above, never an interpolated value.
    expect(stderrText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  });

  it("routes a real client's tool call through the spawned process, with no ticket or callId in the tool input", async () => {
    const ticket = randomUUID();
    const logPath = fixtureLogPath();

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", tsxEsmSpecifier, fixtureLauncherPath],
      env: {
        ...processEnvAsStrings(),
        RAKAZO_MCP_TICKET: ticket,
        RAKAZO_MCP_STDIO_FIXTURE_LOG: logPath,
      },
    });

    const client = new Client({ name: "t02-stdio-test-client", version: "0.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "resource.write",
        arguments: { args: { value: "hello" } },
      });

      expect(result.isError).not.toBe(true);
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual({ args: { value: "hello" }, botId: "fixture-bot" });
    } finally {
      await client.close();
    }
  });
});

function processEnvAsStrings(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  return env;
}
