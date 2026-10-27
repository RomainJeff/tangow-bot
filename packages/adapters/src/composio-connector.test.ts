import type { AdapterContext, ConnectorEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvalReplayResourceError,
  approvedReplayArgs,
  boundDirectApprovalRequest,
  createApprovedEffectReplayQueue,
} from "./approval-effect.js";
import { composioToolkitDirectory, composioToolSchemas } from "./composio-catalog-cache.js";
import {
  ComposioConnector,
  CompositeConnector,
  collectLogIds,
  collectPages,
  composioEntityId,
  filterCatalog,
  isComposioEnabled,
  isNoAuthToolkitError,
  mergeConnectedPlugins,
  needsLivePluginSync,
  planLiveConnectionSync,
  sanitizeComposioError,
} from "./composio-connector.js";
import { DestinationEmulator } from "./destination-emulator.js";
import { catalogEntries } from "./lazy-tool-catalog.js";

const composioSdkState = vi.hoisted(() => ({
  created: [] as Array<{ userId: string; config: Record<string, unknown> }>,
  directoryFails: false,
  directorySlug: "GITHUB",
  rawTools:
    vi.fn<
      (_query: { toolkits: string[]; important?: boolean; limit: number }) => Promise<
        Array<{
          slug: string;
          description: string;
          version?: string;
          isDeprecated?: boolean;
          tags?: string[];
          inputParameters: Record<string, unknown>;
        }>
      >
    >(),
  execute:
    vi.fn<
      (
        tool: string,
        options: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: string | null; logId: string }>
    >(),
  connectedAccounts: {
    list: async (_query?: Record<string, unknown>) => ({ items: [] as Array<{ id: string }> }),
    waitForConnection: async (id: string, _timeout?: number) => ({ id: `resolved-${id}` }),
    get: async (id: string) => ({ id, userId: "user-1" }),
    delete: async (_id: string) => undefined,
  },
  sessions: new Map<
    string,
    {
      sessionId: string;
      toolkits?: () => Promise<{
        items: Array<{
          slug: string;
          name: string;
          logo: string | null;
          isNoAuth: boolean;
          connection?: { isActive?: boolean; connectedAccount?: { id: string } };
        }>;
        cursor?: string;
      }>;
    }
  >(),
}));

vi.mock("@composio/core", () => ({
  Composio: class {
    readonly sessions = {
      use: async (sessionId: string) => {
        const session = composioSdkState.sessions.get(sessionId);
        if (!session) throw new Error(`unknown session ${sessionId}`);
        return session;
      },
    };

    readonly tools = {
      getRawComposioTools: composioSdkState.rawTools,
      execute: composioSdkState.execute,
    };

    readonly connectedAccounts = {
      list: (query?: Record<string, unknown>) => composioSdkState.connectedAccounts.list(query),
      waitForConnection: (id: string, timeout?: number) =>
        composioSdkState.connectedAccounts.waitForConnection(id, timeout),
      get: (id: string) => composioSdkState.connectedAccounts.get(id),
      delete: (id: string) => composioSdkState.connectedAccounts.delete(id),
    };

    async create(userId: string, config: Record<string, unknown>) {
      composioSdkState.created.push({ userId, config });
      const toolkits = Array.isArray(config.toolkits) ? config.toolkits : [];
      if (toolkits.length === 0) {
        const session = {
          sessionId: "catalog-session",
          toolkits: async () => {
            if (composioSdkState.directoryFails) throw new Error("directory unavailable");
            return {
              items: [
                {
                  slug: composioSdkState.directorySlug,
                  name: "GitHub",
                  logo: null,
                  isNoAuth: false,
                  connection: { isActive: true, connectedAccount: { id: "ca-github" } },
                },
              ],
            };
          },
        };
        composioSdkState.sessions.set(session.sessionId, session);
        return session;
      }
    }
  },
}));

function rawTool(slug = "GITHUB_GET_REPOS") {
  return {
    slug,
    description: "List repositories",
    version: "20261023_00",
    tags: ["readOnlyHint"],
    inputParameters: {
      type: "object",
      properties: { owner: { type: "string" } },
      required: ["owner"],
    },
  };
}

function contextWith(
  accounts: Array<{ name: string; ref?: string; toolkit?: string }> = [
    { name: "Work", ref: "ca-work" },
  ],
): AdapterContext {
  return {
    operationId: "test",
    traceId: "test",
    spaceId: "workspace",
    userId: "user-1",
    signal: new AbortController().signal,
    connectedConnections: accounts.map((account, index) => ({
      id: `connection-${index}`,
      connectorId: "composio",
      externalId: account.toolkit ?? "github",
      displayName: account.name,
      providerRef: account.ref,
    })),
  };
}

function approvalRoute(tool: ConnectorTool) {
  const route = tool.route;
  if (!route?.resourceId) throw new Error("Expected a bound connector route");
  return { ...route, resourceId: route.resourceId };
}

async function executeEvents(
  connector: ComposioConnector,
  tool: ConnectorTool,
  args: Record<string, unknown>,
  context = contextWith(),
) {
  const events: ConnectorEvent[] = [];
  for await (const event of connector.execute(
    { tool: tool.name, route: tool.route, args, executionId: "test" },
    context,
  ))
    events.push(event);
  return events;
}

beforeEach(() => {
  composioToolkitDirectory.invalidate();
  composioToolSchemas.clear();
  composioSdkState.directoryFails = false;
  composioSdkState.directorySlug = "GITHUB";
  composioSdkState.rawTools.mockReset().mockResolvedValue([rawTool()]);
  composioSdkState.execute
    .mockReset()
    .mockResolvedValue({ data: { ok: true }, error: null, logId: "log-result" });
});

describe("native Composio tools", () => {
  it("discovers versioned native schemas, hints and featured tools without deprecated actions", async () => {
    composioSdkState.rawTools.mockImplementation(async (query) =>
      query.important
        ? [rawTool()]
        : [
            rawTool(),
            { ...rawTool("GITHUB_OLD"), isDeprecated: true },
            { ...rawTool("GITHUB_UNVERSIONED"), version: undefined },
            { ...rawTool("GITHUB_CREATE_ISSUE"), tags: [] },
          ],
    );
    const tools = await new ComposioConnector().discoverTools(contextWith());
    expect(tools).toEqual([
      {
        name: "GITHUB_GET_REPOS",
        description: "List repositories",
        inputSchema: rawTool().inputParameters,
        appName: "GitHub",
        readOnly: true,
        featured: true,
        route: {
          connectorId: "composio",
          resourceId: "github",
          resourceRevision: "ca-work",
          toolName: "GITHUB_GET_REPOS",
          catalogGroup: "github",
        },
      },
      expect.objectContaining({
        name: "GITHUB_CREATE_ISSUE",
        readOnly: undefined,
        featured: undefined,
      }),
    ]);
    expect(composioSdkState.rawTools.mock.calls).toEqual([
      [{ toolkits: ["GITHUB"], limit: 1000 }],
      [{ toolkits: ["GITHUB"], important: true, limit: 1000 }],
    ]);
  });

  it("searches, loads and resolves large catalogs to the real versioned tool", async () => {
    composioSdkState.rawTools.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => rawTool(`GITHUB_ACTION_${index}`)),
    );
    const connector = new ComposioConnector();
    const context = contextWith();
    const tools = await connector.discoverTools(context);
    expect(tools.map((tool) => tool.name)).toEqual([
      "composio_search_tools",
      "composio_load_tool",
      "composio_execute_tool",
    ]);
    const search = await executeEvents(connector, tools[0]!, { query: "GITHUB_ACTION_20" });
    expect(search).toContainEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          tools: expect.arrayContaining([expect.objectContaining({ name: "GITHUB_ACTION_20" })]),
        }),
      }),
    );
    const loaded = await executeEvents(connector, tools[1]!, { id: "github:GITHUB_ACTION_20" });
    expect(loaded[0]).toMatchObject({ type: "result" });
    const resolved = await connector.resolveCall(
      {
        tool: tools[2]!.name,
        route: tools[2]!.route,
        args: { id: "github:GITHUB_ACTION_20", arguments: { owner: "example" } },
        executionId: "test",
      },
      context,
    );
    expect(resolved).toMatchObject({
      tool: { name: "GITHUB_ACTION_20" },
      call: {
        tool: "GITHUB_ACTION_20",
        args: { owner: "example" },
        route: { resourceId: "github", resourceRevision: "ca-work" },
      },
    });
    await executeEvents(connector, resolved!.tool, resolved!.call.args, context);
    expect(composioSdkState.execute).toHaveBeenCalledWith("GITHUB_ACTION_20", {
      userId: "workspace__user-1",
      connectedAccountId: "ca-work",
      arguments: { owner: "example" },
      version: "20261023_00",
    });
  });

  it("adds account labels without changing the shared schema and strips the selected account", async () => {
    const raw = rawTool();
    composioSdkState.rawTools.mockResolvedValue([raw]);
    const connector = new ComposioConnector();
    const context = contextWith([
      { name: "Work", ref: "ca-1111" },
      { name: "Work", ref: "ca-2222" },
      { name: "Personal", ref: "ca-personal" },
      { name: "Duplicate row", ref: "ca-1111" },
      { name: "Legacy", ref: "github" },
    ]);
    const [tool] = await connector.discoverTools(context);
    expect(tool!.inputSchema).toMatchObject({
      properties: {
        composio_account: { type: "string", enum: ["Work (1111)", "Work (2222)", "Personal"] },
      },
      required: ["owner", "composio_account"],
    });
    expect(raw.inputParameters).toEqual({
      type: "object",
      properties: { owner: { type: "string" } },
      required: ["owner"],
    });
    const [single] = await new ComposioConnector().discoverTools({
      ...contextWith(),
      userId: "user-2",
    });
    expect(single!.inputSchema).toEqual(raw.inputParameters);
    expect(
      await executeEvents(
        connector,
        tool!,
        { owner: "example", composio_account: "Work (2222)" },
        context,
      ),
    ).toEqual([{ type: "result", data: { data: { ok: true }, logId: "log-result" } }]);
    expect(composioSdkState.execute).toHaveBeenCalledWith("GITHUB_GET_REPOS", {
      userId: "workspace__user-1",
      connectedAccountId: "ca-2222",
      arguments: { owner: "example" },
      version: "20261023_00",
    });
    composioSdkState.execute.mockClear();
    for (const args of [{ owner: "example", composio_account: "Unknown" }, { owner: "example" }]) {
      expect(await executeEvents(connector, tool!, args, context)).toEqual([
        expect.objectContaining({
          type: "error",
          kind: "invalid_arguments",
          message: expect.stringContaining("account"),
        }),
      ]);
    }
    expect(composioSdkState.execute).not.toHaveBeenCalled();
  });

  it.each([undefined, "github"])(
    "omits connectedAccountId for no-auth or legacy ref %s",
    async (ref) => {
      const connector = new ComposioConnector();
      const context = contextWith([{ name: "Public", ref }]);
      const [tool] = await connector.discoverTools(context);
      expect(tool!.route).not.toHaveProperty("resourceRevision");
      await executeEvents(connector, tool!, { owner: "example" }, context);
      expect(composioSdkState.execute).toHaveBeenCalledWith("GITHUB_GET_REPOS", {
        userId: "workspace__user-1",
        arguments: { owner: "example" },
        version: "20261023_00",
      });
    },
  );

  it("replays an approved action after schema version A refreshes to version B", async () => {
    const connector = new ComposioConnector();
    const context = contextWith();
    composioSdkState.rawTools.mockResolvedValue([{ ...rawTool(), version: "version-A" }]);
    const [before] = await connector.discoverTools(context);
    const marker = "__rakazoCatalogTool";
    const request = boundDirectApprovalRequest(
      approvalRoute(before!),
      { owner: "example" },
      marker,
    );
    const queue = createApprovedEffectReplayQueue([{ kind: before!.name, request }]);
    composioToolSchemas.clear();
    composioSdkState.rawTools.mockResolvedValue([{ ...rawTool(), version: "version-B" }]);
    const restarted = new ComposioConnector();
    const [after] = await restarted.discoverTools(context);
    expect(
      approvalReplayResourceError(
        after!.name,
        false,
        queue.nextRequest(),
        approvalRoute(after!),
        marker,
      ),
    ).toBeUndefined();
    const args = approvedReplayArgs(queue.take(after!.name), {}, marker);
    expect(await executeEvents(restarted, after!, args, context)).toContainEqual(
      expect.objectContaining({ type: "result" }),
    );
    expect(queue.assertDrained).not.toThrow();
    expect(composioSdkState.execute).toHaveBeenCalledWith("GITHUB_GET_REPOS", {
      userId: "workspace__user-1",
      connectedAccountId: "ca-work",
      arguments: { owner: "example" },
      version: "version-B",
    });
  });

  it("refuses approval replay when the connected account set changes", async () => {
    const connector = new ComposioConnector();
    const accounts = [
      { name: "Work", ref: "ca-work" },
      { name: "Personal", ref: "ca-personal" },
    ];
    const [before] = await connector.discoverTools(contextWith(accounts));
    const marker = "__rakazoCatalogTool";
    const request = boundDirectApprovalRequest(
      approvalRoute(before!),
      { owner: "example", composio_account: "Work" },
      marker,
    );
    const [reordered] = await connector.discoverTools(contextWith([...accounts].reverse()));
    expect(
      approvalReplayResourceError(before!.name, false, request, approvalRoute(reordered!), marker),
    ).toBeUndefined();
    const [changed] = await connector.discoverTools(
      contextWith([{ name: "Work", ref: "ca-replaced" }, accounts[1]!]),
    );
    expect(
      approvalReplayResourceError(before!.name, false, request, approvalRoute(changed!), marker),
    ).toContain("different connector resource");
    expect(composioSdkState.execute).not.toHaveBeenCalled();
  });

  it("preserves a tool's own account argument while selecting the Composio connection", async () => {
    composioSdkState.rawTools.mockResolvedValue([
      {
        ...rawTool("STRIPE_GET_ACCOUNT_PERSONS"),
        inputParameters: {
          type: "object",
          properties: { account: { type: "string" } },
          required: ["account"],
        },
      },
    ]);
    const connector = new ComposioConnector();
    const context = contextWith([
      { name: "Work", ref: "ca-work", toolkit: "stripe" },
      { name: "Personal", ref: "ca-personal", toolkit: "stripe" },
    ]);
    const [tool] = await connector.discoverTools(context);
    expect(tool!.inputSchema).toMatchObject({
      properties: {
        account: { type: "string" },
        composio_account: { type: "string", enum: ["Work", "Personal"] },
      },
      required: ["account", "composio_account"],
    });
    await executeEvents(
      connector,
      tool!,
      { account: "acct-example", composio_account: "Personal" },
      context,
    );
    expect(composioSdkState.execute).toHaveBeenCalledWith("STRIPE_GET_ACCOUNT_PERSONS", {
      userId: "workspace__user-1",
      connectedAccountId: "ca-personal",
      arguments: { account: "acct-example" },
      version: "20261023_00",
    });
  });

  it("keeps route, cache and catalog identities stable when the directory recovers with different casing", async () => {
    composioSdkState.directoryFails = true;
    const connector = new ComposioConnector();
    const [before] = await connector.discoverTools(contextWith());
    composioSdkState.directoryFails = false;
    composioSdkState.directorySlug = "github";
    const [after] = await connector.discoverTools(contextWith());
    expect(approvalRoute(before!).resourceId).toBe("github");
    expect(approvalRoute(after!)).toEqual(approvalRoute(before!));
    expect(catalogEntries([before!])[0]?.id).toBe("github:GITHUB_GET_REPOS");
    expect(catalogEntries([after!])[0]?.id).toBe("github:GITHUB_GET_REPOS");
    expect(composioSdkState.rawTools).toHaveBeenCalledTimes(2);
  });

  it("keeps toolkit actions available when the optional important list fails", async () => {
    composioSdkState.rawTools.mockImplementation(async (query) => {
      if (query.important) throw new Error("important unavailable");
      return [rawTool()];
    });
    const connector = new ComposioConnector();
    const [tool] = await connector.discoverTools(contextWith());
    expect(tool).toMatchObject({ name: "GITHUB_GET_REPOS", featured: undefined });
    expect(await executeEvents(connector, tool!, { owner: "example" })).toContainEqual(
      expect.objectContaining({ type: "result" }),
    );
  });

  it("loads a tool's version on an execution cache miss", async () => {
    const connector = new ComposioConnector();
    const [tool] = await connector.discoverTools(contextWith());
    composioToolSchemas.clear();
    composioSdkState.rawTools.mockResolvedValue([{ ...rawTool(), version: "version-B" }]);
    await executeEvents(new ComposioConnector(), tool!, { owner: "example" });
    expect(composioSdkState.execute).toHaveBeenCalledWith(
      "GITHUB_GET_REPOS",
      expect.objectContaining({ version: "version-B" }),
    );
  });

  it("keeps other toolkit tools when one toolkit fails", async () => {
    composioSdkState.rawTools.mockImplementation(async (query) => {
      if (query.toolkits[0] === "GMAIL") throw new Error("offline failure");
      return [rawTool()];
    });
    const tools = await new ComposioConnector().discoverTools(
      contextWith([
        { name: "Mail", toolkit: "gmail" },
        { name: "Code", toolkit: "github" },
      ]),
    );
    expect(tools.map((tool) => tool.name)).toEqual(["GITHUB_GET_REPOS"]);
  });

  it("requires a toolkit route before executing", async () => {
    const connector = new ComposioConnector();
    for (const route of [undefined, { connectorId: "composio", toolName: "GITHUB_GET_REPOS" }]) {
      expect(
        await executeEvents(
          connector,
          { name: "GITHUB_GET_REPOS", description: "", inputSchema: {}, route },
          {},
        ),
      ).toEqual([expect.objectContaining({ type: "error", kind: "invalid_arguments" })]);
    }
    expect(composioSdkState.execute).not.toHaveBeenCalled();
  });

  it("sanitizes SDK errors and successful payloads while retaining log ids", async () => {
    const connector = new ComposioConnector();
    const [tool] = await connector.discoverTools(contextWith());
    composioSdkState.execute.mockResolvedValueOnce({
      data: { secret: "ak_testvalue", nested: { log_id: "nested-log" } },
      error: null,
      logId: "",
    });
    expect(await executeEvents(connector, tool!, {})).toEqual([
      {
        type: "result",
        data: {
          data: { secret: "[redacted]", nested: { log_id: "nested-log" } },
          logId: "nested-log",
        },
      },
    ]);
    composioSdkState.execute.mockResolvedValueOnce({
      data: null,
      error: "denied Bearer test-token",
      logId: "",
    });
    expect(await executeEvents(connector, tool!, {})).toEqual([
      expect.objectContaining({
        type: "error",
        message: "denied Bearer [redacted]",
        details: { successful: false, error: "denied Bearer [redacted]" },
      }),
    ]);
    composioSdkState.execute.mockRejectedValueOnce(new Error("denied Bearer test-token"));
    expect(await executeEvents(connector, tool!, {})).toEqual([
      expect.objectContaining({ type: "error", message: "denied Bearer [redacted]" }),
    ]);
  });
  it("marks an app-reported failure in the error's details, so a send it refused is known unsent", async () => {
    const connector = new ComposioConnector();
    const [tool] = await connector.discoverTools(contextWith());
    composioSdkState.execute.mockResolvedValueOnce({
      data: null,
      error: "Invalid recipient",
      logId: "",
    });
    expect(await executeEvents(connector, tool!, {})).toEqual([
      {
        type: "error",
        kind: "unknown",
        message: "Invalid recipient",
        details: { successful: false, error: "Invalid recipient" },
      },
    ]);
  });
});

describe("composio tool mapping", () => {
  it("retains provider route metadata independently of the tool name", async () => {
    const destination = new DestinationEmulator();
    const events: ConnectorEvent[] = [];
    const composio = {
      describe: () => ({ ...destination.describe(), id: "composio" }),
      discoverTools: async () => [
        {
          name: "destination.write",
          description: "shadow",
          inputSchema: {},
          route: { connectorId: "composio", toolName: "destination.write" },
        } satisfies ConnectorTool,
      ],
      execute: async function* () {
        yield { type: "result", data: { provider: "composio" } } as ConnectorEvent;
      },
    } as never;
    const connector = new CompositeConnector(destination, [composio]);
    const context = { userId: "u" } as AdapterContext;
    for await (const event of connector.execute(
      {
        tool: "destination.write",
        args: {},
        executionId: "x",
        route: { connectorId: "composio", toolName: "destination.write" },
      },
      context,
    ))
      events.push(event);
    expect(events).toEqual([{ type: "result", data: { provider: "composio" } }]);
  });

  it("logs sanitized connector discovery failures", async () => {
    const destination = new DestinationEmulator();
    const failing = {
      describe: () => ({ ...destination.describe(), id: "failing" }),
      discoverTools: async () => {
        throw new Error("denied ak_secretvaluehere");
      },
      execute: async function* () {},
    } as never;
    const connector = new CompositeConnector(destination, [failing]);
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));

    try {
      await expect(connector.discoverTools({ userId: "u" } as AdapterContext)).resolves.toEqual([
        expect.objectContaining({ name: "destination.write" }),
      ]);
      expect(sink.events[0]).toMatchObject({
        message: "connector discovery failed",
        "connector.id": "failing",
      });
      const logged = JSON.stringify(sink.events);
      expect(logged).toContain("[redacted]");
      expect(logged).not.toContain("ak_secretvaluehere");
    } finally {
      installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
    }
  });

  it("redacts project keys from errors", () => {
    expect(sanitizeComposioError("denied ak_secretvaluehere")).toContain("[redacted]");
    expect(sanitizeComposioError("denied ak_secretvaluehere")).not.toContain("ak_secret");
    expect(sanitizeComposioError("COMPOSIO_API_KEY=ak_shouldnotleak")).not.toContain(
      "ak_shouldnotleak",
    );
  });

  it("paginates until the cursor ends", async () => {
    const pages = [
      { items: ["gmail", "github"], cursor: "page-2" },
      { items: ["slack"], cursor: undefined },
    ];
    const items = await collectPages(async (cursor) => {
      if (!cursor) return pages[0]!;
      return pages[1]!;
    });
    expect(items).toEqual(["gmail", "github", "slack"]);
  });

  it("treats Composio no-auth toolkit errors as in-app connect", () => {
    expect(
      isNoAuthToolkitError(
        new Error(
          '400 {"error":{"message":"Toolkit hackernews does not require authentication.","slug":"ToolRouterV2_ToolkitsIsNoAuth"}}',
        ),
      ),
    ).toBe(true);
    expect(isNoAuthToolkitError(new Error("redirect required"))).toBe(false);
  });

  it("collects nested Composio log ids", () => {
    expect(
      collectLogIds({
        logId: "",
        data: { results: [{ log_id: "log_abc123", slug: "HACKERNEWS_GET_USER" }] },
      }),
    ).toEqual(["log_abc123"]);
  });

  it("scopes the Composio entity id to the space, not just the user", () => {
    expect(composioEntityId({ spaceId: "workspace", userId: "user-1" })).toBe("workspace__user-1");
    expect(composioEntityId({ spaceId: "workspace-b", userId: "user-1" })).not.toBe(
      composioEntityId({ spaceId: "workspace-a", userId: "user-1" }),
    );
  });

  it("opens a distinct Composio session per space for the same user", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.sessions.clear();
    composioToolkitDirectory.invalidate();

    const connector = new ComposioConnector();
    const contextFor = (spaceId: string): AdapterContext => ({
      operationId: "composio-space-isolation",
      traceId: "composio-space-isolation",
      spaceId,
      userId: "user-1",
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: "connection-github",
          connectorId: "composio",
          externalId: "github",
          displayName: "GitHub",
        },
      ],
    });

    await connector.listConnectedSlugs(contextFor("workspace-a"));
    await connector.listConnectedSlugs(contextFor("workspace-b"));

    expect(
      composioSdkState.created
        .map(({ userId }) => userId)
        .filter((userId) => userId !== "__rakazo_catalog__"),
    ).toEqual(["workspace-a__user-1", "workspace-b__user-1"]);
  });

  it("resolves connection-request ids to connected-account ids and skips sibling refs", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.sessions.clear();
    composioToolkitDirectory.invalidate();
    composioSdkState.connectedAccounts.list = async () => ({
      items: [{ id: "ca-personal" }, { id: "ca-work" }],
    });
    composioSdkState.connectedAccounts.waitForConnection = async (id: string) => {
      if (id === "req-work") return { id: "ca-work" };
      if (id === "req-missing") throw new Error("timeout");
      return { id: `resolved-${id}` };
    };

    const connector = new ComposioConnector();
    await expect(
      connector.resolveConnectedAccountId("user-1", "gmail", "req-work", ["ca-personal"]),
    ).resolves.toBe("ca-work");
    await expect(
      connector.resolveConnectedAccountId("user-1", "gmail", "gmail", ["ca-personal"]),
    ).resolves.toBe("ca-work");
    await expect(
      connector.resolveConnectedAccountId("user-1", "gmail", "req-missing", [
        "ca-personal",
        "ca-work",
      ]),
    ).resolves.toBeUndefined();
  });

  it("cancels pending authorization requests by request id without waiting", async () => {
    const deleted: string[] = [];
    const waited: string[] = [];
    composioSdkState.connectedAccounts.waitForConnection = async (id: string) => {
      waited.push(id);
      throw new Error(`should not wait for ${id}`);
    };
    composioSdkState.connectedAccounts.delete = async (id: string) => {
      deleted.push(id);
    };
    const connector = new ComposioConnector();
    await connector.cancelAuthorizationRequest("req-pending-1", {
      operationId: "test",
      traceId: "test",
      spaceId: "workspace",
      userId: "user-1",
      signal: new AbortController().signal,
    });
    expect(waited).toEqual([]);
    expect(deleted).toEqual(["req-pending-1"]);
  });

  it.each([{ status: 404 }, { statusCode: 404 }])(
    "ignores missing authorization requests during cancellation (%o)",
    async (notFound) => {
      composioSdkState.connectedAccounts.delete = async () => {
        throw Object.assign(new Error("not found"), notFound);
      };
      const connector = new ComposioConnector();

      await expect(
        connector.cancelAuthorizationRequest("req-missing", {
          operationId: "test",
          traceId: "test",
          spaceId: "workspace",
          userId: "user-1",
          signal: new AbortController().signal,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("surfaces authorization cancellation failures for router fallback", async () => {
    composioSdkState.connectedAccounts.delete = async () => {
      throw Object.assign(new Error("service unavailable"), { status: 503 });
    };
    const connector = new ComposioConnector();

    await expect(
      connector.cancelAuthorizationRequest("req-pending-1", {
        operationId: "test",
        traceId: "test",
        spaceId: "workspace",
        userId: "user-1",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("service unavailable");
  });

  it("resolves authorization-request ids before deleting on revoke", async () => {
    const deleted: string[] = [];
    const waited: string[] = [];
    composioSdkState.connectedAccounts.list = async () => ({ items: [] });
    composioSdkState.connectedAccounts.waitForConnection = async (id: string) => {
      waited.push(id);
      return { id: `ca-from-${id}` };
    };
    composioSdkState.connectedAccounts.delete = async (id: string) => {
      deleted.push(id);
    };
    const connector = new ComposioConnector();
    await connector.revoke("req-oauth-1", {
      operationId: "test",
      traceId: "test",
      spaceId: "workspace",
      userId: "user-1",
      signal: new AbortController().signal,
    });
    expect(waited).toEqual(["req-oauth-1"]);
    expect(deleted).toEqual(["ca-from-req-oauth-1"]);
  });

  it("uses Composio slug casing when the toolkit directory is unavailable", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.sessions.clear();
    composioSdkState.directoryFails = true;
    composioToolkitDirectory.invalidate();

    try {
      const connector = new ComposioConnector();
      const context = {
        operationId: "composio-directory-fallback",
        traceId: "composio-directory-fallback",
        spaceId: "workspace",
        userId: "user-1",
        signal: new AbortController().signal,
        connectedConnections: [
          {
            id: "connection-github",
            connectorId: "composio",
            externalId: "github",
            displayName: "GitHub",
          },
        ],
      } satisfies AdapterContext;

      await expect(connector.discoverTools(context)).resolves.toContainEqual(
        expect.objectContaining({ name: "GITHUB_GET_REPOS" }),
      );
      expect(composioSdkState.rawTools).toHaveBeenCalledWith({ toolkits: ["GITHUB"], limit: 1000 });
    } finally {
      composioSdkState.directoryFails = false;
      composioToolkitDirectory.invalidate();
    }
  });

  it("merges live Composio slugs onto pending DB plugin rows", () => {
    const merged = mergeConnectedPlugins(
      [
        { provider: "github", displayName: "GitHub", status: "connected" },
        { provider: "gmail", displayName: "Gmail", status: "pending" },
        { provider: "linear", displayName: "Linear", status: "revoked" },
      ],
      ["gmail", "github", "notion"],
    );
    expect(merged).toEqual([
      { provider: "github", displayName: "GitHub" },
      { provider: "gmail", displayName: "Gmail" },
    ]);
  });

  it("reconciles Composio slugs without case sensitivity", () => {
    expect(
      mergeConnectedPlugins(
        [{ provider: "github", displayName: "GitHub", status: "pending" }],
        ["GITHUB"],
      ),
    ).toEqual([{ provider: "github", displayName: "GitHub" }]);
    expect(
      planLiveConnectionSync(
        [{ id: "row-gh", provider: "github", status: "pending", displayName: "GitHub" }],
        ["GITHUB"],
      ),
    ).toEqual({ connectIds: ["row-gh"], revokeIds: [] });
  });

  it("only fetches live Composio slugs when a Rakazo row is still pending or errored", () => {
    expect(needsLivePluginSync([{ status: "connected" }, { status: "revoked" }])).toBe(false);
    expect(needsLivePluginSync([{ status: "pending" }])).toBe(true);
    expect(needsLivePluginSync([{ status: "error" }])).toBe(true);
  });

  it("keeps DB-connected plugins when live Composio listing is empty", () => {
    expect(
      mergeConnectedPlugins(
        [{ provider: "github", displayName: "GitHub", status: "connected" }],
        [],
      ),
    ).toEqual([{ provider: "github", displayName: "GitHub" }]);
  });

  it("plans DB sync when Composio is connected but Rakazo is still pending", () => {
    expect(
      planLiveConnectionSync(
        [
          { id: "row-gmail", provider: "gmail", status: "pending", displayName: "Gmail" },
          { id: "row-gh", provider: "github", status: "connected", displayName: "GitHub" },
        ],
        ["gmail", "slack"],
      ),
    ).toEqual({
      connectIds: ["row-gmail"],
      revokeIds: [],
    });
  });

  it("does not create connection rows for live slugs that have no workspace row", () => {
    expect(
      planLiveConnectionSync(
        [{ id: "row-gh", provider: "github", status: "connected", displayName: "GitHub" }],
        ["github", "slack"],
      ),
    ).toEqual({ connectIds: [], revokeIds: [] });
  });

  it("reconnects existing error or revoked rows instead of inserting duplicates", () => {
    expect(
      planLiveConnectionSync(
        [
          { id: "row-err", provider: "gmail", status: "error", displayName: "Gmail" },
          { id: "row-old", provider: "slack", status: "revoked", displayName: "Slack" },
          { id: "row-gh", provider: "github", status: "connected", displayName: "GitHub" },
        ],
        ["gmail", "slack", "github", "slack"],
      ),
    ).toEqual({
      connectIds: ["row-err", "row-old"],
      revokeIds: [],
    });
  });

  it("revokes abandoned pending or error rows after a successful live listing", () => {
    expect(
      planLiveConnectionSync(
        [
          { id: "row-gmail", provider: "gmail", status: "pending", displayName: "Gmail" },
          { id: "row-dup", provider: "gmail", status: "pending", displayName: "Gmail" },
          { id: "row-err", provider: "slack", status: "error", displayName: "Slack" },
          { id: "row-gh", provider: "github", status: "connected", displayName: "GitHub" },
        ],
        ["gmail"],
      ),
    ).toEqual({
      connectIds: ["row-gmail"],
      revokeIds: ["row-dup", "row-err"],
    });
  });

  it("clears failed additional-account error rows while keeping in-flight pendings", () => {
    expect(
      planLiveConnectionSync(
        [
          { id: "row-gmail", provider: "gmail", status: "connected", displayName: "Personal" },
          { id: "row-work", provider: "gmail", status: "pending", displayName: "Work" },
          { id: "row-fail", provider: "gmail", status: "error", displayName: "Gmail" },
          { id: "row-err", provider: "slack", status: "error", displayName: "Slack" },
        ],
        ["gmail"],
      ),
    ).toEqual({
      connectIds: [],
      revokeIds: ["row-fail", "row-err"],
    });
  });

  it("keeps an in-flight additional account when the provider is already connected", () => {
    expect(
      planLiveConnectionSync(
        [
          { id: "row-gmail", provider: "gmail", status: "connected", displayName: "Personal" },
          { id: "row-work", provider: "gmail", status: "pending", displayName: "Work" },
          { id: "row-err", provider: "slack", status: "error", displayName: "Slack" },
        ],
        ["gmail"],
      ),
    ).toEqual({
      connectIds: [],
      revokeIds: ["row-err"],
    });
  });

  it("filters the catalog by name or slug", () => {
    const items = [
      { slug: "github", name: "GitHub", logo: null, connected: false, noAuth: false },
      { slug: "hackernews", name: "Hacker News", logo: null, connected: false, noAuth: true },
    ];
    expect(filterCatalog(items, "hacker").map((item) => item.slug)).toEqual(["hackernews"]);
  });
});

describe("Composio during pnpm test", () => {
  it("does not construct a live Platform client under Vitest", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(isComposioEnabled("ck_must_not_call_live")).toBe(false);
  });

  it.each(["0", "false"])("does not treat VITEST=%s as an active test runner", (value) => {
    vi.stubEnv("VITEST", value);
    expect(isComposioEnabled("ck_configured")).toBe(true);
    vi.unstubAllEnvs();
  });
});
