import { AI_CONSENT_REQUIRED, AI_DISCLOSURE_VERSION } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { FakeDecisionProvider } from "./fake-decision.js";
import { resolveMemoryBotClassifier } from "./memory-method-classification.js";

const actor = { userId: "user", spaceId: "space" };
const method = { provider: "openrouter", model: "decision-model" };
const input = {
  method: {
    id: "method",
    version: 1,
    instructions: "Sort memories",
    prepared: {
      questions: [
        {
          key: "purpose",
          label: "Purpose",
          instructions: "Pick the purpose.",
          options: [{ key: "work", label: "Work", description: "Work related" }],
        },
        {
          key: "tone",
          label: "Tone",
          instructions: "Pick the tone.",
          options: [{ key: "formal", label: "Formal", description: "Formal tone" }],
        },
      ],
    },
  },
  candidate: { id: "memory", revision: 1, content: "Prefers formal emails at work" },
  neighbors: [],
};

function deps(provider: FakeDecisionProvider, consent = true) {
  const prisma = {
    spaceMember: { findUnique: async () => ({ spaceId: "space" }) },
    spaceDecisionConfig: {
      findUnique: async () => ({ provider: "openrouter", settings: { modelId: "decision-model" } }),
    },
    aiDataConsent: {
      findUnique: async () => (consent ? { version: AI_DISCLOSURE_VERSION } : null),
    },
  } as unknown as PrismaClient;
  return { prisma, decisionProviders: { resolve: async () => provider } };
}

const choice = (key: string, other: string) => ({
  type: "choice" as const,
  choice: key,
  confidence: 0.8,
  probabilities: { [key]: 0.8, [other]: 0.2 },
});

describe("resolveMemoryBotClassifier", () => {
  it("asks the Space decision provider one choice per method question", async () => {
    const provider = new FakeDecisionProvider({
      script: [{ answers: { purpose: choice("work", "none"), tone: choice("none", "formal") } }],
    });
    const classify = await resolveMemoryBotClassifier(deps(provider), actor, method);
    const result = await classify(input);
    expect(Object.keys(provider.calls[0]!.questions)).toEqual(["purpose", "tone"]);
    expect(result).toMatchObject({
      answers: { purpose: "work", tone: null },
      abstained: false,
      metadata: { provider: "fake", confidence: 0.8 },
    });
  });

  it("abstains when the provider fails", async () => {
    const provider = new FakeDecisionProvider({ script: [new Error("down")] });
    const classify = await resolveMemoryBotClassifier(deps(provider), actor, method);
    expect(await classify(input)).toMatchObject({
      abstained: true,
      abstentionReason: "provider_error",
    });
  });

  it("requires consent for the connected recipient", async () => {
    await expect(
      resolveMemoryBotClassifier(deps(new FakeDecisionProvider(), false), actor, method),
    ).rejects.toThrow(AI_CONSENT_REQUIRED);
  });
});
