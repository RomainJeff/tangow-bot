import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { applyBotProfile, listBotProfiles, loadBotProfile } from "./bot-profiles.js";

const scope = { userId: "owner", spaceId: "space" };
const profile = {
  modelProvider: "provider",
  modelId: "fixed-model",
  thinkingLevel: "low",
  instructions: "Explain each recommendation.",
  notifyOnFinish: false,
  skills: [
    { skillKey: "user:handoff", enabled: true },
    { skillKey: "user:technical", enabled: false },
  ],
  mcpServers: [{ serverId: "server", allowAllTools: false, allowedTools: ["read_document"] }],
};

describe("equipped bot profiles", () => {
  it("does not expose profile instructions in the public profile catalog", async () => {
    const findMany = vi.fn().mockResolvedValue([]);

    await listBotProfiles({ bot: { findMany } } as unknown as PrismaClient, scope);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ instructions: true }),
      }),
    );
  });

  it("requires a live profile scoped to the same owner and space", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await expect(
      loadBotProfile({ bot: { findFirst } } as unknown as PrismaClient, scope, "profile"),
    ).rejects.toThrow("owner and space");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...scope, id: "profile", archivedAt: null } }),
    );
  });
  it("resolves an inherited model selection from the Space default", async () => {
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          ...profile,
          modelProvider: null,
          modelId: null,
          thinkingLevel: null,
        }),
      },
      spaceModelPreference: {
        findFirst: vi.fn().mockResolvedValue({
          credential: {
            id: "credential",
            userId: scope.userId,
            provider: "openai-codex",
            label: "ChatGPT",
            secretId: "secret",
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
          isDefault: true,
          modelId: "gpt-5.6",
        }),
      },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    await expect(loadBotProfile(prisma, scope, "profile")).resolves.toMatchObject({
      modelProvider: "openai-codex",
      modelId: "gpt-5.6",
      thinkingLevel: "medium",
    });
  });
  it("uses the effective connection thinking preference when the profile has none", async () => {
    const resolveConnectionThinkingLevel = vi.fn().mockResolvedValue("high");
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          ...profile,
          modelProvider: null,
          modelId: null,
          thinkingLevel: null,
        }),
      },
      spaceModelPreference: {
        findFirst: vi.fn().mockResolvedValue({
          credential: {
            id: "credential",
            userId: scope.userId,
            provider: "openai-compatible",
            label: "Compatible server",
            secretId: "secret",
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
          isDefault: true,
          modelId: "private-model",
        }),
      },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;

    await expect(
      loadBotProfile(prisma, scope, "profile", {
        resolveConnectionThinkingLevel,
      } as never),
    ).resolves.toMatchObject({
      modelProvider: "openai-compatible",
      modelId: "private-model",
      thinkingLevel: "high",
    });
    expect(resolveConnectionThinkingLevel).toHaveBeenCalledOnce();
  });
  it("resolves the coordinator's own choices for direct delegation without a live model snapshot", async () => {
    const findFirst = vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id === "coordinator"
        ? {
            ...profile,
            modelProvider: "openai-codex",
            modelId: "coordinator-model",
            thinkingLevel: "high",
          }
        : { ...profile, modelProvider: null, modelId: null, thinkingLevel: null },
    );
    const prisma = {
      bot: { findFirst },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const options = { inheritFrom: { botId: "coordinator" }, deployment: null };
    await expect(loadBotProfile(prisma, scope, "profile", options)).resolves.toMatchObject({
      modelProvider: "openai-codex",
      modelId: "coordinator-model",
      thinkingLevel: "high",
      instructions: profile.instructions,
      skills: profile.skills,
      mcpServers: profile.mcpServers,
    });
    expect(findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { ...scope, id: "coordinator", archivedAt: null },
      }),
    );
  });
  it("explains how to proceed when no effective model exists", async () => {
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          ...profile,
          modelProvider: null,
          modelId: null,
          thinkingLevel: null,
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;

    await expect(loadBotProfile(prisma, scope, "profile")).rejects.toThrow(
      "No model is configured for this profile or as the Space default",
    );
  });
  it("preserves fixed effort, excluded skills and restricted MCP tools", async () => {
    const tx = {
      bot: { update: vi.fn() },
      botSkill: { upsert: vi.fn() },
      botMcpServer: { upsert: vi.fn() },
    };
    const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
    await applyBotProfile(prisma, scope, "child", profile);
    expect(tx.bot.update).toHaveBeenCalledWith({
      where: { id: "child" },
      data: {
        modelProvider: "provider",
        modelId: "fixed-model",
        thinkingLevel: "low",
        notifyOnFinish: false,
      },
    });
    expect(tx.botMcpServer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          ...scope,
          botId: "child",
          serverId: "server",
          allowAllTools: false,
          allowedTools: ["read_document"],
        },
        update: { serverId: "server", allowAllTools: false, allowedTools: ["read_document"] },
      }),
    );
    expect(tx.botSkill.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { enabled: false } }),
    );
  });
});
