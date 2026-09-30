import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { UpdateBotInput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "workspace-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

const storedBot = {
  id: "bot-1",
  spaceId: "workspace-1",
  userId: "user-1",
  name: "Bot",
  title: "",
  description: "",
  instructions: "",
  color: "#000000",
  shapeSeed: null,
  notifyOnFinish: true,
  pinned: false,
  position: 0,
  sectionId: null,
  archivedAt: null,
  parentBotId: null,
  memoryScope: null,
  createdAt: new Date("2026-09-25T00:00:00.000Z"),
  updatedAt: new Date("2026-09-25T00:00:00.000Z"),
  harnessChoice: null as string | null,
  choiceVersion: null as number | null,
  modelProvider: "openai-codex" as string | null,
  modelId: "gpt-5.6" as string | null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  webhookSecretId: null,
  spawnKey: null,
  thread: { id: "thread-1", unread: false, messages: [] },
  runs: [],
  computer: { id: "computer-1", scope: "dedicated", kind: "docker" } as unknown,
};

function harnessDeps(overrides: Partial<typeof storedBot> = {}) {
  const bot = { ...storedBot, ...overrides };
  const botUpdate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    // Prisma ignores undefined fields; mirror that so the stored row stays realistic.
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) (bot as Record<string, unknown>)[key] = value;
    }
    return {
      id: bot.id,
      name: bot.name,
      title: bot.title,
      description: bot.description,
    };
  });
  const prisma = {
    bot: {
      findFirst: vi.fn().mockResolvedValue(bot),
      update: botUpdate,
      findMany: vi.fn().mockResolvedValue([bot]),
    },
    spaceModelPreference: {
      findFirst: vi.fn().mockResolvedValue({
        credential: {
          id: "credential-1",
          userId: "user-1",
          provider: "openai-codex",
          label: "ChatGPT",
          secretId: "secret-1",
          createdAt: new Date("2026-09-25T00:00:00.000Z"),
          updatedAt: new Date("2026-09-25T00:00:00.000Z"),
        },
        isDefault: true,
        modelId: "gpt-5.6",
      }),
    },
    deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    computerExecutionLease: { findUnique: vi.fn().mockResolvedValue(null) },
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "docker",
    },
    dataDir: "/tmp/rakazo-bot-harness-test",
  } as unknown as RouterDeps;
  return { botUpdate, deps, handler: new RPCHandler(createRouter(deps)) };
}

function update(handler: RPCHandler, input: Record<string, unknown>) {
  return handler.handle(
    new Request("http://127.0.0.1/rpc/bots/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
}

describe("bots.update harness choice", () => {
  it("records codex-native with a bumped choiceVersion", async () => {
    const { botUpdate, handler } = harnessDeps();
    const { response } = await update(handler, { botId: "bot-1", harness: "codex-native" });

    expect(response.status).toBe(200);
    expect(botUpdate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: { id: "bot-1" },
        data: expect.objectContaining({ harnessChoice: "codex-native", choiceVersion: 1 }),
      }),
    );
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ harness: "codex-native" }),
    });
  });

  it("clears a saved choice back to the default harness and bumps the version again", async () => {
    const { botUpdate, handler } = harnessDeps({
      harnessChoice: "codex-native",
      choiceVersion: 3,
    });
    const { response } = await update(handler, { botId: "bot-1", harness: "default" });

    expect(response.status).toBe(200);
    expect(botUpdate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        data: expect.objectContaining({ harnessChoice: null, choiceVersion: 4 }),
      }),
    );
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ harness: "default" }),
    });
  });

  it("refuses codex-native for a bot without a Computer", async () => {
    const { botUpdate, handler } = harnessDeps({ computer: null });
    const { response } = await update(handler, { botId: "bot-1", harness: "codex-native" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Attach a Computer to this bot before choosing Codex",
      }),
    });
    expect(botUpdate).not.toHaveBeenCalled();
  });

  it("refuses codex-native when the bot's effective model is not the ChatGPT subscription", async () => {
    const { botUpdate, handler } = harnessDeps({
      modelProvider: "anthropic",
      modelId: "claude-sonnet-5",
    });
    const { response } = await update(handler, { botId: "bot-1", harness: "codex-native" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message:
          "Choosing Codex requires the bot's effective model to use its connected subscription",
      }),
    });
    expect(botUpdate).not.toHaveBeenCalled();
  });

  it("records claude-native when the bot has a Computer and an Anthropic effective model", async () => {
    const { botUpdate, handler } = harnessDeps({
      modelProvider: "anthropic",
      modelId: "claude-sonnet-5",
    });
    const { response } = await update(handler, { botId: "bot-1", harness: "claude-native" });

    expect(response.status).toBe(200);
    expect(botUpdate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        data: expect.objectContaining({ harnessChoice: "claude-native", choiceVersion: 1 }),
      }),
    );
  });

  it("resolves the effective ChatGPT model through the Space default for a bot without its own model", async () => {
    const { botUpdate, handler } = harnessDeps({ modelProvider: null, modelId: null });
    const { response } = await update(handler, { botId: "bot-1", harness: "codex-native" });

    expect(response.status).toBe(200);
    expect(botUpdate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        data: expect.objectContaining({ harnessChoice: "codex-native", choiceVersion: 1 }),
      }),
    );
  });

  it("leaves the saved choice untouched when the update carries no harness", async () => {
    const { botUpdate, handler } = harnessDeps({ harnessChoice: "codex-native", choiceVersion: 1 });
    const { response } = await update(handler, { botId: "bot-1", pinned: true });

    expect(response.status).toBe(200);
    expect(botUpdate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ harnessChoice: expect.anything() }),
      }),
    );
  });
});

describe("computer.status native harness availability", () => {
  function status(handler: RPCHandler) {
    return handler.handle(
      new Request("http://127.0.0.1/rpc/computer/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
  }

  it("offers only the harness whose subscription the bot's effective model uses", async () => {
    const { handler } = harnessDeps();
    const { response } = await status(handler);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        nativeHarnesses: { "codex-native": true, "claude-native": false },
      }),
    });
  });

  it("offers neither harness without a Computer", async () => {
    const { handler } = harnessDeps({ computer: null });
    const { response } = await status(handler);

    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        nativeHarnesses: { "codex-native": false, "claude-native": false },
      }),
    });
  });
});

describe("bot harness contract", () => {
  it("accepts each selectable native harness in UpdateBotInput", () => {
    expect(UpdateBotInput.safeParse({ botId: "bot-1", harness: "codex-native" }).success).toBe(
      true,
    );
    expect(UpdateBotInput.safeParse({ botId: "bot-1", harness: "default" }).success).toBe(true);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", harness: "claude-native" }).success).toBe(
      true,
    );
  });
});
