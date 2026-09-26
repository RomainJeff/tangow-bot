import type { Actor } from "@rakazo/contracts";
import { AI_DISCLOSURE_VERSION } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const threadTarget = vi.hoisted(() => ({
  resolve: vi.fn(async () => ({ kind: "bot" as const, botId: "bot" })),
}));
vi.mock("./thread-target.js", () => ({
  resolveThreadTarget: threadTarget.resolve,
}));

import { aiConsentStatus, allowAiConsent } from "./ai-consent.js";
import type { RouterDeps } from "./router.js";

function setup() {
  const upsert = vi.fn(async () => ({}));
  const deps = {
    env: { agentRuntime: "scripted" },
    prisma: {
      spaceModelPreference: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      secret: { findMany: vi.fn(async () => []) },
      bot: { findMany: vi.fn(async () => []) },
      spaceVoicePreference: {
        findFirst: vi.fn(async () => ({ credential: { provider: "openai" }, voiceId: "alloy" })),
        findMany: vi.fn(async () => [{ credential: { provider: "openai" } }]),
      },
      spaceMemoryConfig: { findUnique: vi.fn(async () => null) },
      spaceMemoryClassifierConfig: { findUnique: vi.fn(async () => null) },
      botMemoryMethod: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      aiDataConsent: { findMany: vi.fn(async () => []), upsert },
      $transaction: vi.fn(async (queries) => Promise.all(queries)),
    },
  } as unknown as RouterDeps;
  return { deps, upsert, actor: { userId: "user", spaceId: "space" } as Actor };
}
afterEach(() => threadTarget.resolve.mockClear());
describe("consent grants", () => {
  it("includes reachable helper models and cloud services for a targeted send", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    deps.cloudAgent = {
      key: "test",
      spaceId: actor.spaceId,
      provider: { describe: () => ({ id: "cursor", capabilities: { offline: false } }) },
    } as RouterDeps["cloudAgent"];
    vi.mocked(deps.prisma.spaceModelPreference.findMany).mockResolvedValue([
      {
        modelId: "helper-model",
        isDefault: false,
        credential: { provider: "anthropic", secretId: "test-secret" },
      },
    ] as never);
    const status = await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] });
    expect(status.recipients.map((recipient) => recipient.name)).toEqual(
      expect.arrayContaining(["Anthropic", "Cursor"]),
    );
    expect(deps.prisma.spaceVoicePreference.findMany).not.toHaveBeenCalled();
    expect(deps.prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ["bot"] } }) }),
    );
  });
  it("discloses only the selected voice provider before a voice action", async () => {
    const { deps, actor } = setup();
    vi.mocked(deps.prisma.spaceVoicePreference.findMany).mockResolvedValue([
      { credential: { provider: "openai" } },
      { credential: { provider: "elevenlabs" } },
    ] as never);
    const status = await aiConsentStatus(deps, actor, { uses: ["voice"] });
    expect(status.recipients).toHaveLength(1);
    expect(status.recipients[0]?.name).toBe("OpenAI");
    expect(deps.prisma.spaceVoicePreference.findMany).not.toHaveBeenCalled();
  });
  it("returns an operator policy without requiring a hosted provider", async () => {
    const { deps, actor } = setup();
    deps.env.privacyPolicyUrl = "https://example.com/privacy";
    expect((await aiConsentStatus(deps, actor)).privacyUrl).toBe("https://example.com/privacy");
  });
  it("discloses Jev for a shared bot method without resolving access to the owner's private thread", async () => {
    const { deps, actor } = setup();
    vi.mocked(deps.prisma.botMemoryMethod.findFirst).mockResolvedValue({
      bot: { userId: "bot-owner" },
      sharing: "space",
      provider: "typesafe-jev",
      model: "custom-jev-model",
    } as never);

    const status = await aiConsentStatus(deps, actor, {
      botId: "shared-bot",
      uses: ["memory-classification"],
    });

    expect(threadTarget.resolve).not.toHaveBeenCalled();
    expect(status.recipients).toHaveLength(1);
    expect(status.recipients[0]).toMatchObject({
      name: "Jev · TypeSafe",
      use: "memory-classification",
      detail: "Model: custom-jev-model.",
    });
  });
  it("does not disclose a hosted recipient for a local shared bot method", async () => {
    const { deps, actor } = setup();
    vi.mocked(deps.prisma.botMemoryMethod.findFirst).mockResolvedValue({
      bot: { userId: "bot-owner" },
      sharing: "space",
      provider: "local",
      model: "reviewed-examples",
    } as never);

    const status = await aiConsentStatus(deps, actor, {
      botId: "shared-bot",
      uses: ["memory-classification"],
    });

    expect(threadTarget.resolve).not.toHaveBeenCalled();
    expect(status.recipients).toEqual([]);
  });
  it("discloses only the selected bot's connected model for method preparation", async () => {
    const { deps, actor } = setup();
    deps.env = {
      agentRuntime: "pi",
      deploymentModelKey: "configured",
      defaultProvider: "openai",
      defaultModel: "gpt-test",
    } as RouterDeps["env"];
    vi.mocked(deps.prisma.bot.findMany).mockResolvedValue([
      { modelProvider: null, modelId: null, thinkingLevel: null },
    ] as never);

    const status = await aiConsentStatus(deps, actor, {
      botId: "bot",
      uses: ["memory-method-preparation"],
    });

    expect(threadTarget.resolve).toHaveBeenCalledExactlyOnceWith(deps.prisma, actor, {
      botId: "bot",
      uses: ["memory-method-preparation"],
    });
    expect(status.recipients).toHaveLength(1);
    expect(status.recipients[0]).toMatchObject({
      name: "OpenAI",
      use: "memory-method-preparation",
      detail: "Model: gpt-test.",
    });
    expect(deps.prisma.spaceModelPreference.findMany).not.toHaveBeenCalled();
    expect(deps.prisma.spaceMemoryClassifierConfig.findUnique).not.toHaveBeenCalled();
  });
  it("grants the exact bot method preparation recipient after status review", async () => {
    const { deps, actor, upsert } = setup();
    deps.env = {
      agentRuntime: "pi",
      deploymentModelKey: "configured",
      defaultProvider: "openai",
      defaultModel: "gpt-test",
    } as RouterDeps["env"];
    vi.mocked(deps.prisma.bot.findMany).mockResolvedValue([
      { modelProvider: null, modelId: null, thinkingLevel: null },
    ] as never);
    const query = { botId: "bot", uses: ["memory-method-preparation"] as const };
    const status = await aiConsentStatus(deps, actor, query);

    await expect(
      allowAiConsent(deps, actor, {
        scope: status.scope,
        version: status.version,
        keys: [status.recipients[0]!.key],
        query,
      }),
    ).resolves.toMatchObject({
      recipients: [expect.objectContaining({ use: "memory-method-preparation", allowed: true })],
    });
    expect(upsert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        create: expect.objectContaining({
          recipientKey: status.recipients[0]!.key,
          version: AI_DISCLOSURE_VERSION,
        }),
      }),
    );
  });
  it("allows the custom Jev model frozen in a shared bot method and rejects a changed recipient", async () => {
    const { deps, actor, upsert } = setup();
    const method = {
      bot: { userId: "bot-owner" },
      sharing: "space",
      provider: "typesafe-jev",
      model: "shared-method-jev",
    };
    vi.mocked(deps.prisma.botMemoryMethod.findFirst).mockResolvedValue(method as never);
    vi.mocked(deps.prisma.spaceMemoryClassifierConfig.findUnique).mockResolvedValue({
      provider: "typesafe-jev",
      model: "different-global-jev",
    } as never);
    const query = { botId: "shared-bot", uses: ["memory-classification"] as const };
    const status = await aiConsentStatus(deps, actor, query);
    const input = {
      scope: status.scope,
      version: status.version,
      keys: [status.recipients[0]!.key],
      query,
    };
    expect(status.recipients[0]).toMatchObject({
      use: "memory-classification",
      detail: "Model: shared-method-jev.",
    });

    vi.mocked(deps.prisma.botMemoryMethod.findFirst).mockResolvedValue({
      ...method,
      model: "changed-method-jev",
    } as never);
    await expect(allowAiConsent(deps, actor, input)).rejects.toThrow("changed");
    expect(upsert).not.toHaveBeenCalled();

    vi.mocked(deps.prisma.botMemoryMethod.findFirst).mockResolvedValue(method as never);
    await expect(allowAiConsent(deps, actor, input)).resolves.toMatchObject({
      recipients: [expect.objectContaining({ use: "memory-classification", allowed: true })],
    });
    expect(upsert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        create: expect.objectContaining({ recipientKey: status.recipients[0]!.key }),
      }),
    );
  });
  it("rejects stale disclosures, unknown recipients, and a changed account or Space", async () => {
    const { deps, actor, upsert } = setup();
    const current = await aiConsentStatus(deps, actor);
    const input = {
      scope: current.scope,
      version: current.version,
      keys: [current.recipients[0]!.key],
    };
    for (const invalid of [
      { ...input, version: "old" },
      { ...input, scope: "different-account" },
      { ...input, keys: ["unknown"] },
    ]) {
      await expect(allowAiConsent(deps, actor, invalid)).rejects.toThrow("changed");
    }
    expect(upsert).not.toHaveBeenCalled();
    await allowAiConsent(deps, actor, input);
    expect(upsert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        create: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          recipientKey: input.keys[0],
          version: AI_DISCLOSURE_VERSION,
        },
      }),
    );
  });
});
