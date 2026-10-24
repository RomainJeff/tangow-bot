import type { ConnectorProvider } from "@rakazo/adapter-kit";
import { EncryptedSecretStore, McpConnector, McpOAuthBroker } from "@rakazo/adapters";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import type { Seen } from "./worker-channel-tap.js";
import { tapConnector } from "./worker-channel-tap.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const ENDPOINT = "https://mcp.example.test/mcp";
const ORIGIN = "https://mcp.example.test";
const ACCESS_STALE = "stale-access-token-4f1c";
const ACCESS_FRESH = "fresh-access-token-9b2e";
const REFRESH = "refresh-token-7d3a";
const recap = JSON.stringify({ version: 1, results: ["Done"], references: [] });

/** A remote MCP server with 30 tools whose schemas carry a marker, and an OAuth server that refreshes. */
function fakeMcp(options: { oauth?: boolean } = {}) {
  const state = {
    called: [] as string[],
    initializations: 0,
    refreshes: 0,
    bearers: [] as Array<string | null>,
  };
  const tools = Array.from({ length: 30 }, (_, index) => ({
    name: `tool_${String(index).padStart(2, "0")}`,
    description: `Utility ${index}`,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string", description: `schema-marker-${index}` } },
      required: ["value"],
      additionalProperties: false,
    },
  }));
  const logicalUrl = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? String(input) : input.url,
    );
    const host = new Headers(input instanceof Request ? input.headers : init?.headers).get("host");
    if (host) url.host = host;
    return url;
  };
  const rpc = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
  const network = {
    resolveHostname: async () => [{ address: "8.8.8.8", family: 4 as const }],
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = logicalUrl(input, init);
      if (url.href === `${ORIGIN}/.well-known/oauth-protected-resource/mcp`) {
        return Response.json({ resource: ENDPOINT, authorization_servers: [ORIGIN] });
      }
      if (url.href === `${ORIGIN}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer: ORIGIN,
          authorization_endpoint: `${ORIGIN}/authorize`,
          token_endpoint: `${ORIGIN}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.href === `${ORIGIN}/token`) {
        state.refreshes += 1;
        return Response.json({
          access_token: ACCESS_FRESH,
          refresh_token: REFRESH,
          token_type: "bearer",
          expires_in: 3600,
        });
      }
      if (url.href !== ENDPOINT) throw new Error(`Unexpected request: ${url.href}`);
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const bearer = request.headers.get("authorization");
      state.bearers.push(bearer);
      if (options.oauth && bearer !== `Bearer ${ACCESS_FRESH}`) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }
      const message = JSON.parse(await request.text()) as {
        id?: number;
        method?: string;
        params?: { name?: string };
      };
      if (message.method === "initialize") {
        state.initializations += 1;
        return rpc(message.id, {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1" },
        });
      }
      if (message.method === "tools/list") return rpc(message.id, { tools });
      if (message.method === "tools/call") {
        state.called.push(message.params?.name ?? "");
        return rpc(message.id, { content: [{ type: "text", text: "tool-ran" }] });
      }
      return new Response(null, { status: 202 });
    },
  };
  return { state, network };
}

async function mcpRun(options: { oauth?: boolean; steps: ModelEmulatorStep[] }) {
  const mcp = fakeMcp({ oauth: options.oauth });
  const seen: Seen[] = [];
  const secrets = new EncryptedSecretStore("mcp-fixture-encryption-key");
  let connector!: McpConnector;
  const tools: ConnectorProvider = {
    describe: () => connector.describe(),
    discoverTools: (context) => connector.discoverTools(context),
    resolveCall: (call, context) => connector.resolveCall(call, context),
    execute: (call, context) => connector.execute(call, context),
  };
  const run = await startWorkerRun({
    steps: options.steps,
    tools,
    connector: (provider) => tapConnector(provider, seen, []),
  });
  cleanups.push(async () => {
    await connector.close();
    await run.close();
  });
  const context = {
    operationId: "mcp-fixture",
    traceId: "mcp-fixture",
    spaceId: run.spaceId,
    userId: run.userId,
    signal: new AbortController().signal,
  };
  let secretId: string | null = null;
  if (options.oauth) {
    const sealed = await secrets.put(
      JSON.stringify({
        oauth: {
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
          tokens: { access_token: ACCESS_STALE, refresh_token: REFRESH, token_type: "bearer" },
          obtainedAt: 0,
          clientInformation: { client_id: "client-1" },
        },
      }),
      context,
    );
    await run.prisma.secret.create({
      data: {
        id: sealed.id,
        userId: run.userId,
        spaceId: run.spaceId,
        kind: "mcp",
        ciphertext: sealed.ciphertext,
      },
    });
    secretId = sealed.id;
  }
  connector = new McpConnector(
    run.prisma,
    secrets,
    { network: mcp.network },
    new McpOAuthBroker(run.prisma, secrets, mcp.network),
  );
  const server = await run.prisma.mcpServer.create({
    data: {
      spaceId: run.spaceId,
      userId: run.userId,
      slug: "demo",
      name: "Demo",
      transport: "streamable_http",
      endpoint: ENDPOINT,
      secretId,
    },
  });
  await run.prisma.botMcpServer.create({
    data: { spaceId: run.spaceId, userId: run.userId, botId: run.bot.id, serverId: server.id },
  });
  return { run, mcp, seen, server, secrets };
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  type: "tool" as const,
  id,
  name,
  arguments: args,
});
const toolNames = (request: ModelEmulatorRequest) =>
  (request.tools ?? []).map((tool) => tool.function.name);
const lastToolResult = (request: ModelEmulatorRequest) =>
  JSON.stringify(request.messages.filter((message) => message.role === "tool").at(-1)?.content);

/** The lazy flow a model follows: find the tool with Pi's tool search, then call it. */
function lazySteps(seen: { executed?: string }, between: () => Promise<void> = async () => {}) {
  return [
    {
      expect(request) {
        expect(toolNames(request)).toContain("tool_search");
        expect(toolNames(request).some((name) => name.includes("mcp__demo__"))).toBe(false);
        expect(JSON.stringify(request.tools)).not.toContain("schema-marker");
      },
      response: call("search", "tool_search", { query: "Utility 29", limit: 1 }),
    },
    {
      async expect(request) {
        expect(toolNames(request)).toContain("mcp__rakazo__mcp__demo__tool_29");
        expect(JSON.stringify(request.tools)).toContain("schema-marker-29");
        await between();
      },
      response: call("exec", "mcp__demo__tool_29", { value: "x" }),
    },
    {
      expect(request) {
        seen.executed = lastToolResult(request);
      },
      response: call("say", "message_user", { message: "Done." }),
    },
    { expect() {}, response: { type: "text", text: recap } },
  ] satisfies ModelEmulatorStep[];
}

function workerStartTools(seen: Seen[]) {
  for (const { from, frame } of seen) {
    if (from !== "controller") continue;
    const message = JSON.parse(Buffer.from(frame).toString()) as {
      kind: string;
      run?: { tools: unknown[] };
    };
    if (message.kind === "worker.start") return message.run!.tools;
  }
  throw new Error("The controller never sent worker.start");
}

describe("lazy MCP through a worker run", () => {
  it("finds a tool with Pi's tool search and executes it on the controller once, with a small initial tool set", async () => {
    const outcome: { executed?: string } = {};
    const { run, mcp, seen, server } = await mcpRun({ steps: lazySteps(outcome) });
    const runId = await run.send("Use the demo server.");
    await run.continueRun(runId);

    run.model.assertComplete();
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "completed",
    );
    expect(mcp.state.called).toEqual(["tool_29"]);
    expect(outcome.executed).toContain("tool-ran");

    const initial = JSON.stringify(workerStartTools(seen));
    const started = workerStartTools(seen) as Array<{ name: string; catalog?: unknown }>;
    const mcpTools = started.filter((tool) => tool.catalog === "fallback");
    expect(mcpTools).toEqual([
      expect.objectContaining({ name: "mcp_execute_tool", where: "controller" }),
      expect.objectContaining({ name: "mcp_load_tool", where: "controller" }),
      expect.objectContaining({ name: "mcp_search_tools", where: "controller" }),
    ]);
    const entries = started.filter((tool) => typeof tool.catalog === "object");
    expect(entries).toHaveLength(30);
    expect(entries[29]).toEqual(
      expect.objectContaining({
        name: "mcp__demo__tool_29",
        where: "controller",
        catalog: { via: "mcp_execute_tool", id: `${server.id}:tool_29` },
      }),
    );
    expect(JSON.stringify(entries[29])).toContain("schema-marker-29");
    const bytes = Buffer.byteLength(JSON.stringify(mcpTools));
    console.log(
      `initial MCP tool definitions for 30 tools: ${bytes} bytes, about ${Math.ceil(bytes / 4)} tokens (bytes / 4, as history-compaction estimates); all worker.start tools: ${Buffer.byteLength(initial)} bytes`,
    );
  });

  it("refuses an execute after the server is disabled, and no call reaches it", async () => {
    const outcome: { executed?: string } = {};
    let disable = async () => {};
    const { run, mcp, server } = await mcpRun({
      steps: lazySteps(outcome, () => disable()),
    });
    disable = async () => {
      await run.prisma.mcpServer.update({ where: { id: server.id }, data: { enabled: false } });
    };
    const runId = await run.send("Use the demo server.");
    await run.continueRun(runId);

    run.model.assertComplete();
    expect(mcp.state.called).toEqual([]);
    expect(outcome.executed).toContain("unknown or not authorized");
  });

  it("refreshes an expired OAuth token on the controller and keeps every token off the guest", async () => {
    const outcome: { executed?: string } = {};
    const { run, mcp, seen, server, secrets } = await mcpRun({
      oauth: true,
      steps: lazySteps(outcome),
    });
    const runId = await run.send("Use the demo server.");
    await run.continueRun(runId);

    run.model.assertComplete();
    expect(mcp.state.called).toEqual(["tool_29"]);
    expect(mcp.state.refreshes).toBe(1);
    expect(mcp.state.bearers[0]).toBe(`Bearer ${ACCESS_STALE}`);
    expect(mcp.state.bearers.at(-1)).toBe(`Bearer ${ACCESS_FRESH}`);

    const frames = seen.map(({ frame }) => Buffer.from(frame).toString()).join("\n");
    expect(frames).toContain("tool-ran");
    for (const token of [ACCESS_STALE, ACCESS_FRESH, REFRESH]) {
      expect(frames).not.toContain(token);
      expect(JSON.stringify(run.model.requests)).not.toContain(token);
    }
    expect(outcome.executed).toContain("tool-ran");

    const stored = await run.prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
    const secret = await run.prisma.secret.findUniqueOrThrow({ where: { id: stored.secretId! } });
    expect(JSON.parse(secrets.load(secret.ciphertext, secret.id)).oauth.tokens.access_token).toBe(
      ACCESS_FRESH,
    );
  });
});
