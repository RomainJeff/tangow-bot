import { RPCHandler } from "@orpc/server/fetch";
import { COMPUTER_SCREEN_UNAVAILABLE, ComputerScreenUnavailableError } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";
import { openScreenCapability } from "@rakazo/core/node/screen-capability";
import type { PrismaClient } from "@rakazo/db";
import { InvalidAnswerError } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

describe("account preferences", () => {
  function preferencesDeps(avatarStyle: string) {
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      user: {
        update,
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle,
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    return { update, deps, actor, handler: new RPCHandler(createRouter(deps)) };
  }

  it("keeps an unconfigured catalog offline unless explicitly requested", async () => {
    const { actor, deps } = preferencesDeps("robot");
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    deps.remoteConnectors = { fetch } as RouterDeps["remoteConnectors"];
    const handler = new RPCHandler(createRouter(deps));
    const request = async (usePublicCatalog?: boolean) =>
      handler.handle(
        new Request("http://127.0.0.1/rpc/capabilities/catalogSearch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { query: "notion", usePublicCatalog } }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
    const { response } = await request();
    await expect(response.json()).resolves.toEqual({ json: { enabled: false, results: [] } });
    expect(fetch).not.toHaveBeenCalled();
    await request(true);
    expect(fetch).toHaveBeenCalled();
  });

  it("persists and returns the selected avatar style", async () => {
    const { update, actor, handler } = preferencesDeps("organic");

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/preferences/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { avatarStyle: "organic" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { avatarStyle: "organic" },
    });
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ avatarStyle: "organic" }),
    });
  });

  it("rejects avatar styles outside robot|organic", async () => {
    const { update, actor, handler } = preferencesDeps("robot");

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/preferences/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { avatarStyle: "dicebear" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("coerces unknown stored avatar styles to organic on me", async () => {
    const { actor, handler } = preferencesDeps("custom-cdn");

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/me", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ avatarStyle: "organic" }),
    });
  });
});

describe("model setup gate", () => {
  function modelGateDeps(options: {
    agentRuntime: string;
    deploymentModelKey?: string;
    deploymentModelCredentialCipher?: string;
  }) {
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle: "robot",
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            options.deploymentModelCredentialCipher
              ? { deploymentModelCredentialCipher: options.deploymentModelCredentialCipher }
              : null,
          ),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        agentRuntime: options.agentRuntime,
        defaultProvider: "openrouter",
        defaultModel: "test-model",
        deploymentModelKey: options.deploymentModelKey,
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    return { actor, handler: new RPCHandler(createRouter(deps)) };
  }

  async function call(handler: RPCHandler<never>, actor: Actor, path: string, body: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  it("refuses to start a run when no model is configured", async () => {
    const { actor, handler } = modelGateDeps({ agentRuntime: "pi" });

    const response = await call(handler, actor, "threads/send", {
      botId: "bot-1",
      text: "hello",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Connect a model to start a run.",
      }),
    });
  });

  it("does not require a model credential for the scripted test runtime", async () => {
    const { actor, handler } = modelGateDeps({ agentRuntime: "scripted" });

    const response = await call(handler, actor, "me", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ needsModel: false }),
    });
  });

  it("accepts a deployment model key as model configuration", async () => {
    const { actor, handler } = modelGateDeps({
      agentRuntime: "pi",
      deploymentModelKey: "fake-deployment-key",
    });

    const response = await call(handler, actor, "me", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ needsModel: false }),
    });
  });

  it("does not accept a stored deployment cipher the executor cannot use", async () => {
    const { actor, handler } = modelGateDeps({
      agentRuntime: "pi",
      deploymentModelCredentialCipher: "legacy-ciphertext",
    });

    const response = await call(handler, actor, "me", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ needsModel: true }),
    });
  });

  it("rejects a reply quote without a reply target", async () => {
    const { actor, handler } = modelGateDeps({ agentRuntime: "scripted" });

    const response = await call(handler, actor, "threads/send", {
      botId: "bot-1",
      text: "hello",
      replyQuote: "just this span",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        data: expect.objectContaining({
          issues: expect.arrayContaining([expect.objectContaining({ path: ["replyQuote"] })]),
        }),
      }),
    });
  });

  it("rejects an over-length reply quote", async () => {
    const { actor, handler } = modelGateDeps({ agentRuntime: "scripted" });

    const response = await call(handler, actor, "threads/send", {
      botId: "bot-1",
      text: "hello",
      replyToMessageId: "parent-1",
      replyQuote: "x".repeat(REPLY_QUOTE_MAX_LENGTH + 1),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        data: expect.objectContaining({
          issues: expect.arrayContaining([expect.objectContaining({ path: ["replyQuote"] })]),
        }),
      }),
    });
  });
});

describe("thread answer delivery", () => {
  it("accepts a durable answer when the immediate worker wake fails", async () => {
    const answerRunInput = vi.fn().mockResolvedValue(true);
    const enqueue = vi.fn().mockRejectedValue(new Error("job broker unavailable"));
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { answerRunInput },
      jobs: { enqueue },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/threads/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            botId: "bot-1",
            runId: "run-1",
            messageId: "message-1",
            answer: "Paris",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(answerRunInput).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
    expect(sink.events.some((event) => event.message === "thread answer enqueue")).toBe(true);
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });

  describe("edits on a Create bot card", () => {
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    function setup(answerRunInput: ReturnType<typeof vi.fn>) {
      const prisma = {
        bot: {
          findFirst: vi.fn().mockResolvedValue({
            id: "bot-1",
            thread: { id: "thread-1" },
            computer: null,
          }),
        },
      } as unknown as PrismaClient;
      const deps = {
        prisma,
        events: { answerRunInput },
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fake-test-secret",
          sandboxProvider: "fake",
        },
        dataDir: "/tmp/rakazo-router-test",
      } as unknown as RouterDeps;
      const handler = new RPCHandler(createRouter(deps));
      return (json: Record<string, unknown>) =>
        handler.handle(
          new Request("http://127.0.0.1/rpc/threads/answer", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              json: { botId: "bot-1", runId: "run-1", messageId: "message-1", ...json },
            }),
          }),
          { prefix: "/rpc", context: { actor } },
        );
    }

    it("passes the edits to the answer transaction", async () => {
      const answerRunInput = vi.fn().mockResolvedValue(true);
      const post = setup(answerRunInput);
      const { response } = await post({
        answer: "allow",
        edits: { name: "Radar", instructions: "" },
      });
      expect(response.status).toBe(200);
      expect(answerRunInput).toHaveBeenCalledWith(
        expect.objectContaining({
          answeredByUserId: "user-1",
          answer: "allow",
          edits: { name: "Radar", instructions: "" },
        }),
      );
    });

    it("answers without edits as before", async () => {
      const answerRunInput = vi.fn().mockResolvedValue(true);
      const post = setup(answerRunInput);
      const { response } = await post({ answer: "allow" });
      expect(response.status).toBe(200);
      expect(answerRunInput.mock.calls[0]![0].edits).toBeUndefined();
    });

    it.each([
      ["an unknown field", { edits: { title: "x" } }],
      ["a name over 200 characters", { edits: { name: "n".repeat(201) } }],
      ["instructions over 4000 characters", { edits: { instructions: "i".repeat(4001) } }],
    ])("CA7 and CA20 reject %s before touching the run", async (_label, extra) => {
      const answerRunInput = vi.fn().mockResolvedValue(true);
      const post = setup(answerRunInput);
      const { response } = await post({ answer: "allow", ...extra });
      expect(response.status).toBe(400);
      expect(answerRunInput).not.toHaveBeenCalled();
    });

    it("reports a refused edit as a bad request, not a stale prompt", async () => {
      const answerRunInput = vi
        .fn()
        .mockRejectedValue(new InvalidAnswerError('A bot named "Radar" already exists.'));
      const post = setup(answerRunInput);
      const { response } = await post({ answer: "allow", edits: { name: "Radar" } });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        json: { code: "BAD_REQUEST", message: 'A bot named "Radar" already exists.' },
      });
    });
  });
});

describe("MCP server deletion", () => {
  it("does not fail when a concurrent credential rotation already removed the old secret", async () => {
    const deleteServer = vi.fn().mockResolvedValue({ id: "server-1" });
    const deleteSecrets = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({ id: "server-1", secretId: "old-secret" }),
        delete: deleteServer,
      },
      secret: { deleteMany: deleteSecrets },
      $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/mcp/servers/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { id: "server-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(deleteServer).toHaveBeenCalledWith({ where: { id: "server-1" } });
    expect(deleteSecrets).toHaveBeenCalledWith({
      where: {
        id: "old-secret",
        spaceId: "workspace-1",
        userId: "user-1",
      },
    });
  });
});

describe("connections.complete", () => {
  it("forwards an optional code to the managed connector", async () => {
    const complete = vi.fn().mockResolvedValue({ connectionRef: "gmail" });
    const connectionReady = vi.fn().mockResolvedValue(true);
    const update = vi.fn().mockResolvedValue({
      id: "conn-1",
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
      status: "connected",
      createdAt: new Date("2026-08-26T00:00:00.000Z"),
    });
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          displayName: "Gmail",
          providerRef: "gmail-state",
          status: "pending",
          createdAt: new Date("2026-08-26T00:00:00.000Z"),
        }),
        findMany: vi.fn().mockResolvedValue([]),
        update,
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const row = {
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          displayName: "Gmail",
          providerRef: "gmail-state",
          status: "pending",
          createdAt: new Date("2026-08-26T00:00:00.000Z"),
        };
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          connection: {
            findFirst: vi.fn().mockResolvedValueOnce(row).mockResolvedValueOnce(null),
            findMany: vi.fn().mockResolvedValue([]),
            update: vi
              .fn()
              .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
                ...row,
                ...data,
              })),
          },
        };
        return fn(tx);
      }),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      connectors: {
        managed: vi.fn(() => ({ complete, connectionReady })),
      },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/connections/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            connectionId: "conn-1",
            code: "123456",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    expect(complete).toHaveBeenCalledWith(
      { state: "gmail-state", code: "123456" },
      expect.objectContaining({ spaceId: "workspace-1", userId: "user-1" }),
    );
    expect(connectionReady).toHaveBeenCalled();
  });
});

describe("updater owner gate", () => {
  function updaterDeps() {
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle: "robot",
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
        gitSha: "deadbeef",
        updaterUrl: undefined,
        updaterToken: undefined,
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    return { deps, handler: new RPCHandler(createRouter(deps)) };
  }

  it("forbids non-owners from updater status", async () => {
    const { handler } = updaterDeps();
    const actor = {
      spaceId: "workspace-1",
      userId: "user-2",
      email: "member@rakazo.test",
      isDeploymentOwner: false,
    } satisfies Actor;

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/updater/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(403);
  });

  it("lets the deployment owner read status without applying git", async () => {
    const { handler } = updaterDeps();
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "owner@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/updater/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.json.supported).toBe(false);
    expect(["source", "compose"]).toContain(body.json.installKind);
    expect(Array.isArray(body.json.manualCommands)).toBe(true);
  });

  it("refuses apply when the sidecar is not configured", async () => {
    const { handler } = updaterDeps();
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "owner@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/updater/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.json();
    const message = JSON.stringify(body);
    expect(message).toMatch(/sidecar/i);
    expect(message).not.toMatch(/git (fetch|merge|pull)/i);
  });
});

describe("computer screen url", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const computerRow = {
    id: "computer-1",
    screenGeneration: 3,
    kind: "e2b",
    scope: "team",
    state: "running",
    providerRef: "sandbox-ref-1",
    homeKey: "home-1",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    controlRunId: null,
  };

  const callScreenUrl = async (connectScreen: () => Promise<unknown>, updateMany = vi.fn()) => {
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          screenGeneration: 2,
          thread: { id: "thread-1" },
          computer: computerRow,
        }),
      },
      computer: { updateMany },
      computerExecutionLease: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      sandbox: { connectScreen },
      jobs: { enqueue: vi.fn().mockResolvedValue(undefined) },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "e2b",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/computer/screenUrl", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { response, updateMany };
  };

  it("issues lifecycle-bound capabilities for managed-provider screens too", async () => {
    const { response } = await callScreenUrl(async () => ({
      url: "https://screen.example/vnc.html?token=fake-token",
    }));
    expect(response.status).toBe(200);
    const { json } = await response.json();
    const url = new URL(json.url);
    expect(url.origin).toBe("http://127.0.0.1:5173");
    expect(openScreenCapability(url.pathname, "fake-test-secret")).toMatchObject({
      scope: {
        botId: "bot-1",
        computerId: "computer-1",
        botGeneration: 2,
        computerGeneration: 3,
        controlLeaseId: null,
      },
      target: { hostname: "screen.example", interactive: false },
    });
  });

  it("returns desktop provider screen URLs without sealing them", async () => {
    const { response } = await callScreenUrl(async () => ({
      url: "desktop://screen/computer-1",
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: { url: "desktop://screen/computer-1?view_only=true" },
    });
  });

  it("clears the row instead of 500ing when the provider says the sandbox is gone", async () => {
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(
        Object.assign(new Error("Sandbox is probably not running anymore"), {
          name: "SandboxNotFoundError",
        }),
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { url: null } });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", providerRef: "sandbox-ref-1" },
      data: { state: "stopped", providerRef: null },
    });
  });

  it("keeps a transport blip an error and leaves the row alone", async () => {
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })),
    );
    expect(response.status).toBe(500);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("returns a recoverable conflict when the screen is temporarily busy", async () => {
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(new ComputerScreenUnavailableError()),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "CONFLICT",
        message: COMPUTER_SCREEN_UNAVAILABLE,
      }),
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("thread rewind", () => {
  function rewindDeps(role: string | null) {
    const rewindThread = vi.fn().mockResolvedValue({
      event: { seq: 20 },
      cancelledRunIds: ["run-1"],
      historyCompactionGeneration: 3,
      fromSeq: 4,
      compactionReset: false,
    });
    const cancel = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
      message: { findFirst: vi.fn().mockResolvedValue(role ? { role } : null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { rewindThread },
      jobs: { cancel },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    return { rewindThread, cancel, actor, handler: new RPCHandler(createRouter(deps)) };
  }

  function rewindRequest(messageId: string) {
    return new Request("http://127.0.0.1/rpc/threads/rewind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId: "bot-1", messageId } }),
    });
  }

  it("truncates the thread and cancels the run jobs it stopped", async () => {
    const { rewindThread, cancel, actor, handler } = rewindDeps("user");

    const { response } = await handler.handle(rewindRequest("message-4"), {
      prefix: "/rpc",
      context: { actor },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(rewindThread).toHaveBeenCalledWith({
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      messageId: "message-4",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("refuses to rewind to a bot message", async () => {
    const { rewindThread, actor, handler } = rewindDeps("bot");

    const { response } = await handler.handle(rewindRequest("message-5"), {
      prefix: "/rpc",
      context: { actor },
    });

    expect(response.status).toBe(400);
    expect(rewindThread).not.toHaveBeenCalled();
  });

  it("reports a missing target as not found", async () => {
    const { rewindThread, actor, handler } = rewindDeps(null);

    const { response } = await handler.handle(rewindRequest("message-gone"), {
      prefix: "/rpc",
      context: { actor },
    });

    expect(response.status).toBe(404);
    expect(rewindThread).not.toHaveBeenCalled();
  });
});

describe("thread stop", () => {
  it("settles a routine card the user approved but the stopped run never created", async () => {
    const run = { id: "run-1", spaceId: "workspace-1", threadId: "thread-1", botId: "bot-1" };
    // A run the user started: no routine woke it.
    const matchesRun = (where: { status: unknown; routineId?: unknown }) =>
      where.routineId === undefined && (where.status !== "cancelled" || runStatus === "cancelled");
    let runStatus = "running";
    const effects = [{ id: "effect-1", status: "approved", result: null as unknown }];
    const card = {
      id: "message-2",
      blocks: [{ kind: "ask", approvalEffectId: "effect-1", status: "answered", answer: "allow" }],
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
      run: {
        findMany: vi.fn(async ({ where }: { where: { status: unknown; routineId?: unknown } }) =>
          matchesRun(where) ? [run] : [],
        ),
        updateManyAndReturn: vi.fn(async () => {
          runStatus = "cancelled";
          return [{ id: run.id }];
        }),
        findUnique: vi.fn(async () => ({ status: runStatus, startedAt: null })),
      },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computerExecutionLease: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computer: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      externalEffect: {
        findMany: vi.fn(async () => effects.filter((effect) => effect.status === "approved")),
        updateMany: vi.fn(
          async ({ where, data }: { where: { status: string }; data: { result: unknown } }) => {
            if (effects[0]!.status !== where.status) return { count: 0 };
            Object.assign(effects[0]!, data);
            return { count: 1 };
          },
        ),
      },
      message: {
        findMany: vi.fn(async () => [card]),
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn(async ({ data }: { data: { blocks: typeof card.blocks } }) => {
          card.blocks = data.blocks;
        }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number } }) => data),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    (prisma as unknown as { $transaction: unknown }).$transaction = vi.fn(
      async (fn: (tx: typeof prisma) => unknown) => fn(prisma),
    );
    const notify = vi.fn().mockResolvedValue(undefined);
    const deps = {
      prisma,
      events: { notify },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const { response } = await new RPCHandler(createRouter(deps)).handle(
      new Request("http://127.0.0.1/rpc/threads/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    expect(card.blocks[0]).toEqual({
      kind: "ask",
      approvalEffectId: "effect-1",
      status: "answered",
      answer: "allow",
      failed: true,
    });
    expect(effects[0]).toEqual({
      id: "effect-1",
      status: "completed",
      result: { error: "The run ended before this routine was created." },
    });
    expect(notify).toHaveBeenCalledWith("thread-1", 7);
  });
});

describe("integration setup authorization", () => {
  it.each([
    { owner: false, configured: false, needsSetup: false },
    { owner: true, configured: false, needsSetup: true },
    { owner: true, configured: true, needsSetup: false },
  ])(
    "offers server setup only to an owner without configured providers: %j",
    async ({ owner, configured, needsSetup }) => {
      const lookup = vi.fn(async () => configured);
      const deps = {
        prisma: {},
        env: { webOrigin: "https://example.test" },
        integrationSettings: { configured: lookup },
      } as unknown as RouterDeps;
      const handler = new RPCHandler(createRouter(deps));
      const { response } = await handler.handle(
        new Request("https://example.test/rpc/integrationSetup/get", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: null }),
        }),
        {
          prefix: "/rpc",
          context: {
            actor: {
              userId: "user",
              spaceId: "space",
              email: "user@rakazo.test",
              isDeploymentOwner: owner,
            },
          },
        },
      );
      const result = (await response.json()).json;
      expect(result).toMatchObject({ canConfigure: owner, needsSetup });
      if (!owner) {
        expect(result.providers).toEqual([]);
        expect(lookup).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects provider credentials from a non-owner before verification or persistence", async () => {
    const save = vi.fn();
    const deps = {
      prisma: {},
      env: { webOrigin: "https://example.test" },
      integrationSettings: { save },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const { response } = await handler.handle(
      new Request("https://example.test/rpc/integrationSetup/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { provider: "composio", apiKey: "fake-key" } }),
      }),
      {
        prefix: "/rpc",
        context: {
          actor: {
            userId: "member",
            spaceId: "space",
            email: "member@rakazo.test",
            isDeploymentOwner: false,
          },
        },
      },
    );
    expect(response.status).toBe(403);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("interrupted computer reservation release", () => {
  function fixture() {
    const order: string[] = [];
    const computerUpdate = {
      findFirst: vi.fn(async () => ({ id: "update-1", computerId: "computer-1" })),
      updateMany: vi.fn(async () => {
        order.push("operation");
        return { count: 1 };
      }),
    };
    const computer = {
      updateMany: vi.fn(async () => {
        order.push("computer");
        return { count: 1 };
      }),
    };
    const prisma = { computer, computerUpdate, $transaction: vi.fn(async (fn) => fn(prisma)) };
    const handler = new RPCHandler(
      createRouter({ prisma, env: { sandboxProvider: "fake" } } as unknown as RouterDeps),
    );
    const call = async (owner: boolean, workersStopped?: boolean) =>
      handler.handle(
        new Request("http://127.0.0.1/rpc/computer/releaseInterrupted", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { id: "update-1", workersStopped } }),
        }),
        {
          prefix: "/rpc",
          context: {
            actor: {
              spaceId: "space-1",
              userId: "user-1",
              email: "user@rakazo.test",
              isDeploymentOwner: owner,
            },
          },
        },
      );
    return { prisma, computer, computerUpdate, order, call };
  }
  it.each([
    { owner: false, stopped: true, status: 403 },
    { owner: true, stopped: false, status: 400 },
    { owner: true, stopped: undefined, status: 400 },
  ])(
    "requires owner authorization and an explicit stopped-workers assertion: %j",
    async ({ owner, stopped, status }) => {
      const { call, prisma } = fixture();
      const { response } = await call(owner, stopped);
      expect(response.status).toBe(status);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it("atomically releases only an interrupted reservation in the owner's workspace", async () => {
    const { call, computer, computerUpdate, order } = fixture();
    const { response } = await call(true, true);
    expect(response.status).toBe(200);
    expect(computerUpdate.findFirst).toHaveBeenCalledWith({
      where: {
        id: "update-1",
        status: "interrupted",
        computer: { spaceId: "space-1", bots: { some: { userId: "user-1", archivedAt: null } } },
      },
    });
    expect(computerUpdate.updateMany).toHaveBeenCalledWith({
      where: { id: "update-1", status: "interrupted" },
      data: { status: "failed" },
    });
    expect(computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", maintenanceId: "update-1" },
      data: { maintenanceId: null, state: "error" },
    });
    expect(order).toEqual(["operation", "computer"]);
  });
});

describe("routine update triggers", () => {
  const NO_TRIGGER_MESSAGE = "Add a schedule, webhook, GitHub, or message trigger";

  function updateDeps(existing: Record<string, unknown>) {
    const row = {
      id: "routine-1",
      botId: "bot-1",
      name: "Digest",
      prompt: "Check",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: true,
      notify: false,
      webhookEnabled: false,
      githubEnabled: false,
      messageProvider: null,
      requireToolApproval: true,
      lastRunAt: null,
      nextRunAt: new Date("2026-10-07T09:00:00.000Z"),
      createdAt: new Date("2026-10-01T09:00:00.000Z"),
      ...existing,
    };
    const routineUpdate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...row,
      ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    }));
    const prisma = {
      routine: { findFirst: vi.fn().mockResolvedValue(row), update: routineUpdate },
      bot: { findFirst: vi.fn().mockResolvedValue({ id: "bot-1", thread: null }) },
    } as unknown as PrismaClient;
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const deps = {
      prisma,
      jobs: { enqueue, cancel },
      events: { append: vi.fn().mockResolvedValue(undefined) },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));
    const update = async (patch: Record<string, unknown>) => {
      const { response } = await handler.handle(
        new Request("http://127.0.0.1/rpc/routines/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { routineId: "routine-1", ...patch } }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      return response;
    };
    return { routineUpdate, update, enqueue, cancel };
  }

  const editorForm = {
    name: "Digest",
    prompt: "Check",
    crons: ["0 9 * * *"],
    active: true,
    notify: false,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    requireToolApproval: true,
  };

  async function savedRoutine(response: Response) {
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      json: { name: string; active: boolean; nextRunAt: string | null };
    };
    return body.json;
  }

  const at = async (now: string, test: () => Promise<void>) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    try {
      await test();
    } finally {
      vi.useRealTimers();
    }
  };

  async function refusal(response: Response) {
    expect(response.status).toBe(400);
    const body = (await response.json()) as { json: { code: string; message: string } };
    return body.json;
  }

  it("refuses to clear the only schedule", async () => {
    const { routineUpdate, update } = updateDeps({});

    const error = await refusal(await update({ crons: [] }));

    expect(error).toMatchObject({ code: "BAD_REQUEST", message: NO_TRIGGER_MESSAGE });
    expect(routineUpdate).not.toHaveBeenCalled();
  });

  it("arms a one-shot that never ran at the time the editor gives", async () => {
    const { update, enqueue } = updateDeps({ crons: ["@once"], nextRunAt: null });

    const response = await update({ runAt: "2999-01-01T09:00:00.000Z" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { json: { nextRunAt: string | null } };
    expect(body.json.nextRunAt).toBe("2999-01-01T09:00:00.000Z");
    expect(enqueue.mock.calls.map(([job]) => job.availableAt)).toEqual([
      new Date("2999-01-01T09:00:00.000Z"),
    ]);
  });

  it("keeps a reminder that already ran from resuming without a new time", async () => {
    const { routineUpdate, update } = updateDeps({
      crons: ["@once"],
      active: false,
      nextRunAt: null,
      lastRunAt: new Date("2026-10-06T08:00:00.000Z"),
    });

    const error = await refusal(await update({ active: true }));

    expect(error).toMatchObject({ code: "BAD_REQUEST", message: "This one-shot already ran." });
    expect(routineUpdate).not.toHaveBeenCalled();
  });

  it("refuses to turn a recurring routine into a one-shot from the app", async () => {
    const { routineUpdate, update } = updateDeps({});

    const error = await refusal(
      await update({ crons: ["@once"], runAt: "2999-01-01T09:00:00.000Z" }),
    );

    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      message: "One-shot schedules must be created from chat.",
    });
    expect(routineUpdate).not.toHaveBeenCalled();
  });

  it("refuses to move an armed one-shot from the app", async () => {
    const { routineUpdate, update } = updateDeps({
      crons: ["@once"],
      nextRunAt: new Date("2999-01-01T08:00:00.000Z"),
    });

    const error = await refusal(await update({ runAt: "2999-01-02T09:00:00.000Z" }));

    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      message: "A run time is only for one-shots that have not run yet.",
    });
    expect(routineUpdate).not.toHaveBeenCalled();
  });

  it("refuses to re-arm a one-shot that already ran from the app", async () => {
    const { routineUpdate, update } = updateDeps({
      crons: ["@once"],
      active: false,
      nextRunAt: null,
      lastRunAt: new Date("2026-10-06T08:00:00.000Z"),
    });

    const error = await refusal(await update({ active: true, runAt: "2999-01-01T09:00:00.000Z" }));

    expect(error).toMatchObject({ code: "BAD_REQUEST", message: "This one-shot already ran." });
    expect(routineUpdate).not.toHaveBeenCalled();
  });

  it("moves the next run and its wake-up when the editor changes the schedule", () =>
    at("2026-10-07T10:00:00.000Z", async () => {
      const { update, enqueue, cancel } = updateDeps({});

      const saved = await savedRoutine(await update({ ...editorForm, crons: ["30 7 * * *"] }));

      expect(saved.nextRunAt).toBe("2026-10-08T07:30:00.000Z");
      expect(enqueue.mock.calls.map(([job]) => job.availableAt)).toEqual([
        new Date("2026-10-08T07:30:00.000Z"),
      ]);
      expect(cancel.mock.calls).toEqual([]);
    }));

  it("clears the next run and cancels its wake-up when the editor pauses a routine", () =>
    at("2026-10-07T10:00:00.000Z", async () => {
      const { update, enqueue, cancel } = updateDeps({});

      const saved = await savedRoutine(await update({ ...editorForm, active: false }));

      expect(saved).toMatchObject({ active: false, nextRunAt: null });
      expect(cancel.mock.calls).toEqual([["routine:routine-1"]]);
      expect(enqueue.mock.calls).toEqual([]);
    }));

  it("schedules the next run when the editor resumes a paused routine", () =>
    at("2026-10-07T10:00:00.000Z", async () => {
      const { update, enqueue, cancel } = updateDeps({ active: false, nextRunAt: null });

      const saved = await savedRoutine(await update(editorForm));

      expect(saved).toMatchObject({ active: true, nextRunAt: "2026-10-08T09:00:00.000Z" });
      expect(enqueue.mock.calls.map(([job]) => job.availableAt)).toEqual([
        new Date("2026-10-08T09:00:00.000Z"),
      ]);
      expect(cancel.mock.calls).toEqual([]);
    }));

  it("still renames, pauses and resumes a routine stored with an old time zone, on UTC", () =>
    at("2026-10-07T10:00:00.000Z", async () => {
      const legacy = { timezone: "Paris" };

      const renamed = await savedRoutine(
        await updateDeps(legacy).update({ ...editorForm, name: "Morning digest" }),
      );
      const paused = await savedRoutine(
        await updateDeps(legacy).update({ ...editorForm, active: false }),
      );
      const resumed = await savedRoutine(
        await updateDeps({ ...legacy, active: false, nextRunAt: null }).update(editorForm),
      );

      expect(renamed).toMatchObject({
        name: "Morning digest",
        active: true,
        nextRunAt: "2026-10-07T09:00:00.000Z",
      });
      expect(paused).toMatchObject({ active: false, nextRunAt: null });
      expect(resumed).toMatchObject({ active: true, nextRunAt: "2026-10-08T09:00:00.000Z" });
    }));

  it("refuses a time zone sent in an old format, even the one already stored", async () => {
    const { routineUpdate, update } = updateDeps({ timezone: "Paris" });

    const error = await refusal(await update({ ...editorForm, timezone: "Paris" }));

    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      message: "timezone must be an IANA time zone, such as Europe/Paris.",
    });
    expect(routineUpdate).not.toHaveBeenCalled();
  });
});
