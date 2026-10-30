import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { routeModel, validateConnectedModelChoice } from "./model-selection.js";

type SelectionInput = Parameters<typeof routeModel>[0];

function credential(provider: string, defaultModel: string | null) {
  return {
    id: `credential-${provider}`,
    userId: "user-1",
    provider,
    label: provider,
    secretId: `secret-${provider}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDefault: false,
    defaultModel,
  };
}

const spaceCredential = credential("space-provider", "space-model");
const overrideCredential = credential("bot-provider", "stored-model");
const bot = { modelProvider: "bot-provider", modelId: "bot-model", thinkingLevel: "high" };
const defaults: SelectionInput = {
  routing: { mode: "fixed" },
  bot: null,
  overrideCredential: null,
  defaultCredential: spaceCredential,
  settings: { defaultModelProvider: "settings-provider", defaultModelId: "settings-model" },
  deployment: { provider: "deployment-provider", model: "deployment-model" },
};

describe("configured model selection", () => {
  it.each<{
    name: string;
    input: Partial<SelectionInput>;
    expected: object | null;
  }>([
    {
      name: "uses the bot's model with its own credential",
      input: { bot, overrideCredential },
      expected: {
        credential: overrideCredential,
        decision: {
          mode: "fixed",
          provider: "bot-provider",
          modelId: "bot-model",
          thinkingLevel: "high",
        },
      },
    },
    {
      name: "drops override thinking when its provider has no credential",
      input: { bot },
      expected: {
        credential: spaceCredential,
        decision: {
          mode: "fixed",
          provider: "space-provider",
          modelId: "space-model",
          thinkingLevel: null,
        },
      },
    },
    {
      name: "keeps bot thinking with the Space default",
      input: { bot: { modelProvider: null, modelId: null, thinkingLevel: "high" } },
      expected: {
        credential: spaceCredential,
        decision: {
          mode: "fixed",
          provider: "space-provider",
          modelId: "space-model",
          thinkingLevel: "high",
        },
      },
    },
    {
      name: "does not select an incomplete bot override",
      input: { bot: { ...bot, modelId: null }, overrideCredential },
      expected: {
        credential: spaceCredential,
        decision: {
          mode: "fixed",
          provider: "space-provider",
          modelId: "space-model",
          thinkingLevel: "high",
        },
      },
    },
    {
      name: "uses settings before deployment defaults without inventing a credential",
      input: { defaultCredential: null },
      expected: {
        credential: null,
        decision: {
          mode: "fixed",
          provider: "settings-provider",
          modelId: "settings-model",
          thinkingLevel: null,
        },
      },
    },
    {
      name: "uses deployment defaults when no stored configuration exists",
      input: { defaultCredential: null, settings: null },
      expected: {
        credential: null,
        decision: {
          mode: "fixed",
          provider: "deployment-provider",
          modelId: "deployment-model",
          thinkingLevel: null,
        },
      },
    },
    {
      name: "leaves missing configuration for the caller's runtime fallback or failure path",
      input: { defaultCredential: null, settings: null, deployment: null },
      expected: null,
    },
  ])("$name", ({ input, expected }) => {
    expect(routeModel({ ...defaults, ...input })).toEqual(expected);
  });
});

describe("connected model validation", () => {
  const actor: Pick<Actor, "userId" | "spaceId"> = {
    userId: "user-1",
    spaceId: "space-1",
  };

  it("accepts another Azure model through a saved connection after Pi renames its provider", async () => {
    const prisma = {
      spaceModelPreference: { findFirst: async () => null },
      userModelCredential: {
        findFirst: async () => credential("azure-openai-responses", "gpt-4o"),
      },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(prisma, actor, "azure-openai-responses", "gpt-6.1-sol"),
    ).resolves.toBeUndefined();
  });

  it("accepts catalog and saved free-form models but rejects unavailable choices", async () => {
    const catalogPrisma = {
      spaceModelPreference: { findFirst: async () => null },
      userModelCredential: { findFirst: async () => credential("xai", null) },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(catalogPrisma, actor, "xai", "grok-4.6"),
    ).resolves.toBeUndefined();
    await expect(
      validateConnectedModelChoice(catalogPrisma, actor, "xai", "not-a-model"),
    ).resolves.toBe("Unknown model for that provider");

    const preferenceFindFirst = vi.fn(
      async (args: {
        where: {
          spaceId?: string;
          userId?: string;
          modelId?: string;
          credential?: { provider?: string; userId?: string };
        };
      }) => {
        if (args.where.modelId) {
          if (
            args.where.spaceId === actor.spaceId &&
            args.where.userId === actor.userId &&
            args.where.modelId === "private-model" &&
            args.where.credential?.provider === "openai-compatible" &&
            args.where.credential?.userId === actor.userId
          ) {
            return { id: "saved-private-model" };
          }
          return null;
        }
        if (args.where.credential?.provider === "openai-compatible") {
          return {
            credential: credential("openai-compatible", "newest-model"),
            isDefault: true,
            modelId: "newest-model",
          };
        }
        return null;
      },
    );
    const customPrisma = {
      spaceModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: async () => null },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(customPrisma, actor, "openai-compatible", "private-model"),
    ).resolves.toBeUndefined();
    expect(preferenceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: actor.spaceId,
          userId: actor.userId,
          modelId: "private-model",
          credential: { userId: actor.userId, provider: "openai-compatible" },
        }),
        select: { id: true },
      }),
    );
    await expect(
      validateConnectedModelChoice(customPrisma, actor, "openai-compatible", "missing-model"),
    ).resolves.toBe("Unknown model for that provider");

    const disconnectedPrisma = {
      spaceModelPreference: { findFirst: async () => null },
      userModelCredential: { findFirst: async () => null },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(disconnectedPrisma, actor, "anthropic", "claude-opus-4-6"),
    ).resolves.toBe("Connect that model provider first");
  });
});

describe("category routing", () => {
  const categories: NonNullable<SelectionInput["categories"]> = [
    { category: "fast", modelId: "fast-model", thinkingLevel: "low", credential: spaceCredential },
    {
      category: "everyday",
      modelId: "daily-model",
      thinkingLevel: null,
      credential: spaceCredential,
    },
    {
      category: "complex",
      modelId: "deep-model",
      thinkingLevel: "high",
      credential: spaceCredential,
    },
  ];
  it.each<{ name: string; input: Partial<SelectionInput>; expected: object | null }>([
    {
      name: "Auto fast",
      input: { routing: { mode: "auto", classification: { category: "fast" } } },
      expected: {
        mode: "auto",
        requestedCategory: "fast",
        category: "fast",
        provider: "space-provider",
        modelId: "fast-model",
        thinkingLevel: "low",
      },
    },
    {
      name: "explicit category with Auto off",
      input: { routing: { mode: "category", category: "complex" }, bot, overrideCredential },
      expected: {
        mode: "category",
        requestedCategory: "complex",
        category: "complex",
        provider: "space-provider",
        modelId: "deep-model",
        thinkingLevel: "high",
      },
    },
    ...(["no_decision_provider", "decision_failed"] as const).map((fallback) => ({
      name: fallback,
      input: {
        routing: { mode: "auto", classification: { fallback } },
      } satisfies Partial<SelectionInput>,
      expected: {
        mode: "auto",
        category: "everyday",
        provider: "space-provider",
        modelId: "daily-model",
        thinkingLevel: null,
        fallback,
      },
    })),
    {
      name: "unassigned category uses everyday",
      input: { categories: [categories[1]!] },
      expected: {
        mode: "auto",
        requestedCategory: "fast",
        category: "everyday",
        provider: "space-provider",
        modelId: "daily-model",
        thinkingLevel: null,
        fallback: "category_unassigned",
      },
    },
    {
      name: "unassigned everyday uses fixed",
      input: { categories: [] },
      expected: {
        mode: "auto",
        requestedCategory: "fast",
        provider: "space-provider",
        modelId: "space-model",
        thinkingLevel: null,
        fallback: "category_unassigned",
      },
    },
    {
      name: "unavailable bot never activates Auto",
      input: { bot },
      expected: {
        mode: "fixed",
        provider: "space-provider",
        modelId: "space-model",
        thinkingLevel: null,
      },
    },
    {
      name: "available bot wins",
      input: { bot, overrideCredential },
      expected: {
        mode: "fixed",
        provider: "bot-provider",
        modelId: "bot-model",
        thinkingLevel: "high",
      },
    },
    {
      name: "image mismatch uses everyday",
      input: {
        hasImages: true,
        categories: [
          categories[0]!,
          {
            category: "everyday",
            modelId: "gpt-4o",
            thinkingLevel: null,
            credential: credential("openai", "gpt-4o"),
          },
        ],
      },
      expected: {
        mode: "auto",
        requestedCategory: "fast",
        category: "everyday",
        provider: "openai",
        modelId: "gpt-4o",
        thinkingLevel: null,
        fallback: "capability_mismatch",
      },
    },
    {
      name: "image mismatch uses compatible fixed",
      input: { hasImages: true, defaultCredential: credential("openai", "gpt-4o") },
      expected: {
        mode: "auto",
        requestedCategory: "fast",
        provider: "openai",
        modelId: "gpt-4o",
        thinkingLevel: null,
        fallback: "capability_mismatch",
      },
    },
    { name: "no compatible model fails", input: { hasImages: true }, expected: null },
  ])("$name", ({ input, expected }) => {
    expect(
      routeModel({
        ...defaults,
        categories,
        routing: { mode: "auto", classification: { category: "fast" } },
        ...input,
      })?.decision ?? null,
    ).toEqual(expected);
  });
});
