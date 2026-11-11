import { openPgliteDatabase } from "@tangow/db/pglite.test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowlistDrift, McpConnector } from "./mcp-connector.js";
import { type McpOAuthBroker, StoredMcpOAuthProvider } from "./mcp-oauth.js";

afterEach(() => vi.unstubAllGlobals());

const SERVER = {
  id: "server-1",
  slug: "demo",
  name: "Demo",
  transport: "streamable_http",
  endpoint: "https://mcp.example.test/mcp",
  secretId: null,
  args: [],
  revision: 1,
};

const ASSIGNMENT = {
  botId: "bot-1",
  serverId: "server-1",
  spaceId: "w1",
  userId: "u1",
  allowAllTools: true,
  allowedTools: [],
  server: SERVER,
};

const TEST_NETWORK = {
  // Read the global per call so a fetch stubbed after construction still wins.
  fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
  resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }],
};

function logicalHref(input: string | URL | Request, init?: RequestInit): string {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? String(input) : input.url,
  );
  const host = new Headers(input instanceof Request ? input.headers : init?.headers).get("host");
  if (host) url.host = host;
  return url.href;
}

function mcpFetch(
  state: {
    failNext: boolean;
    initializations: number;
    headers?: Record<string, string>[];
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
      annotations?: { readOnlyHint?: boolean };
    }>;
    calls?: string[];
    toolError?: boolean;
  },
  expectedUrl = "https://mcp.example.test/mcp",
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    state.headers?.push(Object.fromEntries(request.headers.entries()));
    if (logicalHref(input, init) !== expectedUrl)
      throw new Error(`Unexpected request: ${logicalHref(input, init)}`);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (state.failNext) return new Response("boom", { status: 500 });
    const message = JSON.parse(await request.text()) as {
      id?: number;
      method?: string;
      params?: { name?: string };
    };
    if (message.method === "initialize") {
      state.initializations += 1;
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "test", version: "1" },
        },
      });
    }
    if (message.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: state.tools ?? [{ name: "echo", inputSchema: { type: "object" } }],
        },
      });
    }
    if (message.method === "tools/call") {
      if (message.params?.name) state.calls?.push(message.params.name);
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: "ok" }],
          ...(state.toolError ? { isError: true } : {}),
        },
      });
    }
    return new Response(null, { status: 202 });
  });
}

describe("MCP connector session cache", () => {
  it("keeps large MCP schemas out of the initial runtime tool catalog", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      tools: Array.from({ length: 30 }, (_, index) => ({
        name: `tool_${String(index).padStart(2, "0")}`,
        description: `Tool ${index}`,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string", description: `schema-marker-${index}` } },
          required: ["value"],
        },
      })),
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;

    const tools = await connector.discoverTools(context);

    expect(tools).toHaveLength(3);
    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp_search_tools",
      "mcp_load_tool",
      "mcp_execute_tool",
    ]);
    const declared = tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
    expect(JSON.stringify(declared)).not.toContain("schema-marker");
    expect(tools[2]!.catalog?.map((entry) => entry.tool.name)).toHaveLength(30);
    await connector.close();
  });

  it("exposes 20 MCP tools directly and switches at 21", async () => {
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    for (const count of [20, 21]) {
      const state = {
        failNext: false,
        initializations: 0,
        tools: Array.from({ length: count }, (_, index) => ({
          name: `tool_${index}`,
          inputSchema: { type: "object" },
        })),
      };
      vi.stubGlobal("fetch", mcpFetch(state));
      const connector = new McpConnector(
        {
          botMcpServer: {
            findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
          },
        } as never,
        {} as never,
        { network: TEST_NETWORK },
      );
      const tools = await connector.discoverTools(context);
      if (count === 20) {
        expect(tools).toHaveLength(20);
        expect(tools[0]?.name).toMatch(/^mcp__demo__/);
        expect(tools[0]?.appName).toBe("Demo");
      } else {
        expect(tools.map((tool) => tool.name)).toEqual([
          "mcp_search_tools",
          "mcp_load_tool",
          "mcp_execute_tool",
        ]);
      }
      await connector.close();
    }
  });

  it("keeps a server's readOnlyHint absent, true or false", async () => {
    vi.stubGlobal(
      "fetch",
      mcpFetch({
        failNext: false,
        initializations: 0,
        tools: [
          { name: "unhinted", inputSchema: { type: "object" } },
          { name: "reads", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          { name: "writes", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
        ],
      }),
    );
    const connector = new McpConnector(
      { botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) } } as never,
      {} as never,
      { network: TEST_NETWORK },
    );
    const tools = await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);
    expect(tools.map((tool) => [tool.name, tool.readOnly])).toEqual([
      ["mcp__demo__unhinted", undefined],
      ["mcp__demo__reads", true],
      ["mcp__demo__writes", false],
    ]);
    await connector.close();
  });

  it("returns no tools when the MCP catalog is empty", async () => {
    const connector = new McpConnector(
      { botMcpServer: { findMany: vi.fn().mockResolvedValue([]) } } as never,
      {} as never,
    );
    await expect(
      connector.discoverTools({
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: new AbortController().signal,
      } as never),
    ).resolves.toEqual([]);
    await connector.close();
  });

  it("searches, loads, validates, authorizes, and executes one large-catalog tool", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      calls: [] as string[],
      tools: Array.from({ length: 30 }, (_, index) => ({
        name: `tool_${String(index).padStart(2, "0")}`,
        description: index === 29 ? "Find the final report" : `Utility ${index}`,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      })),
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const [search, load, execute] = await connector.discoverTools(context);
    const collect = async (call: Parameters<McpConnector["execute"]>[0]) => {
      const events: unknown[] = [];
      for await (const event of connector.execute(call as never, context)) events.push(event);
      return events;
    };

    const searched = await collect({
      tool: search!.name,
      args: { query: "final report", limit: 2 },
      executionId: "search",
      route: search!.route,
    });
    expect(searched).toEqual([
      {
        type: "result",
        data: {
          tools: [
            {
              id: "server-1:tool_29",
              name: "mcp__demo__tool_29",
              description: "Find the final report",
              readOnly: false,
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(searched)).not.toContain("inputSchema");

    const indexed = await collect({
      tool: search!.name,
      args: {},
      executionId: "index",
      route: search!.route,
    });
    expect(indexed).toEqual([
      {
        type: "result",
        data: {
          index: [
            {
              group: "demo",
              names: Array.from(
                { length: 30 },
                (_, index) => `tool_${String(index).padStart(2, "0")}`,
              ),
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(indexed)).not.toContain("inputSchema");
    expect(search!.description).not.toContain("tool_00");

    const expanded = await collect({
      tool: search!.name,
      args: { group: "demo" },
      executionId: "group",
      route: search!.route,
    });
    expect(expanded).toEqual([
      {
        type: "result",
        data: {
          group: "demo",
          names: Array.from({ length: 30 }, (_, index) => `tool_${String(index).padStart(2, "0")}`),
        },
      },
    ]);

    const loaded = await collect({
      tool: load!.name,
      args: { id: "server-1:tool_29" },
      executionId: "load",
      route: load!.route,
    });
    expect(loaded).toEqual([
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          id: "server-1:tool_29",
          inputSchema: expect.objectContaining({ required: ["value"] }),
        }),
      }),
    ]);

    await expect(
      connector.resolveCall(
        {
          tool: execute!.name,
          args: { id: "mcp__demo__missing", arguments: { value: "x" } },
          executionId: "unknown",
          route: execute!.route,
        },
        context,
      ),
    ).rejects.toThrow("unknown or not authorized");
    await expect(
      connector.resolveCall(
        {
          tool: execute!.name,
          args: { id: "server-1:tool_29", arguments: {} },
          executionId: "invalid",
          route: execute!.route,
        },
        context,
      ),
    ).rejects.toThrow("arguments are invalid");

    const resolved = await connector.resolveCall(
      {
        tool: execute!.name,
        args: { id: "server-1:tool_29", arguments: { value: "ok" } },
        executionId: "execute",
        route: execute!.route,
      },
      context,
    );
    expect(resolved).toMatchObject({
      tool: { name: "mcp__demo__tool_29" },
      call: {
        tool: "mcp__demo__tool_29",
        args: { value: "ok" },
        route: { connectorId: "mcp", resourceId: "server-1", toolName: "tool_29" },
      },
    });
    expect(await collect(resolved!.call)).toMatchObject([{ type: "result" }]);
    expect(state.calls).toEqual(["tool_29"]);
    await connector.close();
  });

  it("executes authoritative MCP tools whose names match catalog controls", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      calls: [] as string[],
      tools: ["__catalog_search", "__catalog_load", "__catalog_execute"].map((name) => ({
        name,
        inputSchema: { type: "object" },
      })),
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;

    for (const tool of await connector.discoverTools(context)) {
      const call = { tool: tool.name, args: {}, executionId: tool.name, route: tool.route };
      await expect(connector.resolveCall(call, context)).resolves.toBeUndefined();
      const events = [];
      for await (const event of connector.execute(call, context)) events.push(event);
      expect(events).toMatchObject([{ type: "result" }]);
    }
    expect(state.calls).toEqual(["__catalog_search", "__catalog_load", "__catalog_execute"]);
    await connector.close();
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "blocks OAuth rediscovery to HTTP %s after invalid_client from a public server",
    async (host) => {
      const requests: Array<{ method: string; url: string }> = [];
      const metadataUrl = `http://${host}:8123/private-probe`;
      const provider = new StoredMcpOAuthProvider(
        "server-1",
        {
          oauth: {
            redirectUri: "https://app.example.test/mcp/oauth/callback",
            tokens: {
              access_token: "fake-stale-access",
              refresh_token: "fake-refresh",
              token_type: "bearer",
            },
            clientInformation: { client_id: "fake-client" },
            discoveryState: {
              authorizationServerUrl: "https://auth.example.test",
              resourceMetadata: {
                resource: SERVER.endpoint,
                authorization_servers: ["https://auth.example.test"],
              },
              authorizationServerMetadata: {
                issuer: "https://auth.example.test",
                authorization_endpoint: "https://auth.example.test/authorize",
                token_endpoint: "https://auth.example.test/token",
                response_types_supported: ["code"],
              },
            },
          },
        },
        async () => undefined,
      );
      const invalidate = vi.spyOn(provider, "invalidateCredentials");
      const connector = new McpConnector(
        { botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) } } as never,
        {} as never,
        {
          network: {
            resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }],
            fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
              const request = new Request(input, init);
              const url = logicalHref(input, init);
              requests.push({ method: request.method, url });
              if (url === SERVER.endpoint) {
                return new Response(null, {
                  status: 401,
                  headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"` },
                });
              }
              if (url === "https://auth.example.test/token") {
                return Response.json({ error: "invalid_client" }, { status: 400 });
              }
              return new Response(null, { status: 404 });
            }),
          },
        },
        { providerFor: vi.fn().mockResolvedValue(provider) } as unknown as McpOAuthBroker,
      );

      try {
        await expect(
          connector.discoverTools({
            spaceId: "w1",
            userId: "u1",
            botId: "bot-1",
            signal: new AbortController().signal,
          } as never),
        ).resolves.toEqual([]);

        expect(requests.slice(0, 2).map((request) => `${request.method} ${request.url}`)).toEqual([
          `POST ${SERVER.endpoint}`,
          "POST https://auth.example.test/token",
        ]);
        expect(invalidate).toHaveBeenCalledWith("all");
        expect(requests.some((request) => request.url === metadataUrl)).toBe(false);
        // The endpoint-origin compatibility retry remains allowed, through remote policy.
        expect(
          requests.some((request) => request.url === "https://mcp.example.test/private-probe"),
        ).toBe(true);
        expect(requests.every((request) => new URL(request.url).protocol === "https:")).toBe(true);
      } finally {
        await connector.close();
      }
    },
  );

  it("connects to an explicitly configured localhost HTTP server", async () => {
    const state = { failNext: false, initializations: 0 };
    const localAssignment = {
      ...ASSIGNMENT,
      server: { ...SERVER, endpoint: "http://localhost:8123/api/mcp" },
    };
    vi.stubGlobal("fetch", mcpFetch(state, "http://localhost:8123/api/mcp"));
    const prisma = {
      botMcpServer: { findMany: vi.fn().mockResolvedValue([localAssignment]) },
    };
    const connector = new McpConnector(prisma as never, {} as never);

    const tools = await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);

    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    await connector.close();
  });

  it("sends stored credentials to an explicitly configured localhost HTTP server", async () => {
    const state = { failNext: false, initializations: 0, headers: [] as Record<string, string>[] };
    const localAssignment = {
      ...ASSIGNMENT,
      server: { ...SERVER, endpoint: "http://localhost:8123/api/mcp", secretId: "secret-1" },
    };
    vi.stubGlobal("fetch", mcpFetch(state, "http://localhost:8123/api/mcp"));
    const prisma = {
      botMcpServer: { findMany: vi.fn().mockResolvedValue([localAssignment]) },
      secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "encrypted" }) },
    };
    const connector = new McpConnector(
      prisma as never,
      {
        load: vi
          .fn()
          .mockReturnValue(
            JSON.stringify({ secret: "local-token", headers: { "X-Api-Key": "local-key" } }),
          ),
      } as never,
    );

    await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);

    expect(state.headers[0]?.authorization).toBe("Bearer local-token");
    expect(state.headers[0]?.["x-api-key"]).toBe("local-key");
    await connector.close();
  });

  it("evicts a session after a failed call so the next call reconnects instead of reusing a dead session", async () => {
    const state = { failNext: false, initializations: 0, toolError: false };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const call = {
      tool: "mcp__demo__echo",
      args: {},
      route: { connectorId: "mcp", resourceId: "server-1", toolName: "echo" },
    } as never;

    const tools = await connector.discoverTools(context);
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    expect(state.initializations).toBe(1);

    state.failNext = true;
    const failed: unknown[] = [];
    for await (const event of connector.execute(call, context)) failed.push(event);
    expect(failed).toMatchObject([{ type: "error", kind: "transient" }]);

    state.failNext = false;
    const events: unknown[] = [];
    for await (const event of connector.execute(call, context)) events.push(event);
    expect(events).toMatchObject([{ type: "result" }]);
    expect(state.initializations).toBe(2);

    state.toolError = true;
    const toolFailed = [];
    for await (const event of connector.execute(call, context)) toolFailed.push(event);
    expect(toolFailed).toMatchObject([
      {
        type: "error",
        kind: "unknown",
        details: { isError: true, content: [{ type: "text", text: "ok" }] },
      },
    ]);
    expect(state.initializations).toBe(2);

    await connector.close();
  });

  it("refuses a call once the assignment is gone and reconnects after a revision bump", async () => {
    const state = { failNext: false, initializations: 0, calls: [] as string[] };
    vi.stubGlobal("fetch", mcpFetch(state));
    const findMany = vi.fn().mockResolvedValue([ASSIGNMENT]);
    const connector = new McpConnector({ botMcpServer: { findMany } } as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const call = {
      tool: "mcp__demo__echo",
      args: {},
      route: { connectorId: "mcp", resourceId: "server-1", toolName: "echo" },
    } as never;
    const run = async () => {
      const events: unknown[] = [];
      for await (const event of connector.execute(call, context)) events.push(event);
      return events;
    };

    await connector.discoverTools(context);
    expect(await run()).toMatchObject([{ type: "result" }]);
    expect(state.calls).toEqual(["echo"]);

    findMany.mockResolvedValue([]);
    expect(await run()).toEqual([
      { type: "error", kind: "permission_denied", message: "MCP tool is not assigned to this bot" },
    ]);
    expect(state.calls).toEqual(["echo"]);

    const bumped = { ...ASSIGNMENT, server: { ...SERVER, revision: 2 } };
    findMany.mockResolvedValue([bumped]);
    expect(await run()).toMatchObject([{ type: "result" }]);
    expect(state.initializations).toBe(2);
    await connector.close();
  });

  it("does not reuse one session across workspaces", async () => {
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const contextFor = (spaceId: string, userId: string) =>
      ({ spaceId, userId, botId: "bot-1", signal: new AbortController().signal }) as never;

    await connector.discoverTools(contextFor("w1", "u1"));
    expect(state.initializations).toBe(1);

    await connector.discoverTools(contextFor("w1", "u2"));
    expect(state.initializations).toBe(2);

    await connector.discoverTools(contextFor("w2", "u1"));
    expect(state.initializations).toBe(3);

    await connector.discoverTools(contextFor("w1", "u1"));
    expect(state.initializations).toBe(3);

    await connector.close();
  });
});

describe("MCP servers on a shared bot", () => {
  /** An owner's bot with Linear and GitHub, and a member's own copy of the owner's Linear. */
  async function sharedBot(offered = ["echo"]) {
    const database = await openPgliteDatabase();
    const { prisma } = database;
    for (const id of ["owner", "member"]) {
      await prisma.user.create({ data: { id, name: id, email: `${id}@tangow.test` } });
    }
    await prisma.organization.create({
      data: { id: "org-mcp", name: "Org", slug: "org-mcp", createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: "w1", organizationId: "org-mcp", name: "Team" } });
    const bot = await prisma.bot.create({
      data: { spaceId: "w1", userId: "owner", name: "Notes", color: "#00C46A" },
    });
    const give = async (userId: string, slug: string, declaredServerId?: string) => {
      const server = await prisma.mcpServer.create({
        data: {
          spaceId: "w1",
          userId,
          slug,
          name: slug,
          transport: "streamable_http",
          endpoint: "https://mcp.example.test/mcp",
        },
      });
      const assignment = await prisma.botMcpServer.create({
        data: { spaceId: "w1", userId, botId: bot.id, serverId: server.id, declaredServerId },
      });
      return { server, assignment };
    };
    const linear = await give("owner", "linear");
    await give("owner", "github");
    const copy = await give("member", "linear", linear.server.id);
    const declare = (serverIds: string[]) =>
      prisma.bot.update({
        where: { id: bot.id },
        data: { connectors: serverIds.map((serverId) => ({ kind: "mcp", serverId })) },
      });
    vi.stubGlobal(
      "fetch",
      mcpFetch({
        failNext: false,
        initializations: 0,
        tools: offered.map((name) => ({ name, inputSchema: { type: "object" } })),
      }),
    );
    const connector = new McpConnector(prisma, {} as never, { network: TEST_NETWORK });
    const context = (userId: string) =>
      ({
        spaceId: "w1",
        botId: bot.id,
        userId,
        ...(userId === "owner" ? {} : { memberId: userId }),
        signal: new AbortController().signal,
      }) as never;
    const tools = async (userId: string) =>
      (await connector.discoverTools(context(userId))).map((tool) => tool.name).sort();
    const close = async () => {
      await connector.close();
      await database.close();
    };
    return { prisma, linear, copy, declare, connector, context, tools, close };
  }

  it("gives a member's run only their own copies of the servers still declared", async () => {
    const { declare, linear, tools, close } = await sharedBot();

    await declare([linear.server.id]);
    expect(await tools("member")).toEqual(["mcp__linear__echo"]);
    expect(await tools("owner")).toEqual(["mcp__github__echo", "mcp__linear__echo"]);

    await declare([]);
    expect(await tools("member")).toEqual([]);
    expect(await tools("owner")).toEqual(["mcp__github__echo", "mcp__linear__echo"]);
    await close();
  });

  it("follows the owner's server on the bot as it is now: its tools, enabled, given", async () => {
    const { prisma, declare, linear, copy, connector, context, tools, close } = await sharedBot([
      "echo",
      "upper",
    ]);
    await declare([linear.server.id]);
    expect(await tools("member")).toEqual(["mcp__linear__echo", "mcp__linear__upper"]);

    await prisma.botMcpServer.update({
      where: { id: linear.assignment.id },
      data: { allowAllTools: false, allowedTools: ["echo"] },
    });
    expect(await tools("member")).toEqual(["mcp__linear__echo"]);
    const call = {
      tool: "mcp__linear__upper",
      args: {},
      route: { connectorId: "mcp", resourceId: copy.server.id, toolName: "upper" },
    } as never;
    const events: unknown[] = [];
    for await (const event of connector.execute(call, context("member"))) events.push(event);
    expect(events).toMatchObject([{ type: "error", kind: "permission_denied" }]);

    await prisma.mcpServer.update({ where: { id: linear.server.id }, data: { enabled: false } });
    expect(await tools("member")).toEqual([]);

    await prisma.mcpServer.update({ where: { id: linear.server.id }, data: { enabled: true } });
    await prisma.botMcpServer.delete({ where: { id: linear.assignment.id } });
    expect(await tools("member")).toEqual([]);
    await close();
  });
});

describe("allowlistDrift", () => {
  it("names the allowed tools the server no longer offers", () => {
    const offered = [{ name: "echo" }, { name: "upper" }];
    expect(allowlistDrift(["echo", "vanished_tool"], offered)).toEqual({
      missing: ["vanished_tool"],
      offered: 2,
      stringAllowedCount: 2,
    });
    expect(allowlistDrift(["echo"], offered).missing).toEqual([]);
    // allowedTools is a Json column, so it can hold anything: it must not throw.
    expect(allowlistDrift(null, offered)).toEqual({
      missing: [],
      offered: 2,
      stringAllowedCount: 0,
    });
    // Non-string JSON values are ignored for both missing and the warning ratio.
    expect(allowlistDrift([42, "vanished_tool"], offered)).toEqual({
      missing: ["vanished_tool"],
      offered: 2,
      stringAllowedCount: 1,
    });
  });
});
