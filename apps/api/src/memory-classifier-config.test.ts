import { aiRecipient, EncryptedSecretStore } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { AI_DISCLOSURE_VERSION } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { localMemoryBotClassifier } from "@rakazo/memory";
import { describe, expect, it, vi } from "vitest";
import {
  connectMemoryClassifier,
  disconnectMemoryClassifier,
  getMemoryClassifierSettings,
  resolveBotMemoryClassifier,
} from "./memory-classifier-config.js";

function fixture() {
  const actor = { userId: "owner", spaceId: "demo-space" } as Actor;
  const config = {
    spaceId: actor.spaceId,
    provider: "typesafe-jev",
    model: "jev-latest",
    secretId: "old-secret",
  };
  const db = {
    spaceMember: { findUnique: vi.fn(async () => ({ role: "owner", space: { name: "Demo" } })) },
    spaceMemoryClassifierConfig: {
      findUnique: vi.fn(async (query: { select?: unknown }) =>
        query.select ? { provider: config.provider, model: config.model } : config,
      ),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({})),
    },
    secret: {
      create: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => ({ id: config.secretId, ciphertext: "encrypted" })),
    },
    aiDataConsent: { findUnique: vi.fn(async () => ({ version: AI_DISCLOSURE_VERSION })) },
    $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => operation(db)),
  };
  const secrets = new EncryptedSecretStore("offline-test-encryption-key");
  const verify = vi.fn(async () => {});
  const createClassifier = vi.fn(() => localMemoryBotClassifier);
  const deps = { prisma: db as unknown as PrismaClient, secrets, verify, createClassifier };
  const input = { provider: "typesafe-jev", model: "jev-latest", apiKey: "fake-test-key" };
  return { actor, config, db, deps, input, verify, createClassifier };
}

describe("memory classifier connections", () => {
  it("returns only public settings, without decrypting or exposing credentials", async () => {
    const { deps, actor } = fixture();
    const load = vi.spyOn(deps.secrets, "load");
    const result = await getMemoryClassifierSettings(deps, actor);
    expect(result).toMatchObject({
      spaceName: "Demo",
      canConfigure: true,
      connection: { provider: "typesafe-jev", model: "jev-latest" },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|ciphertext|apiKey/);
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects a non-owner before any provider call or write", async () => {
    const { deps, actor, input, db, verify } = fixture();
    db.spaceMember.findUnique.mockResolvedValue({ role: "member", space: { name: "Demo" } });
    await expect(connectMemoryClassifier(deps, actor, input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(disconnectMemoryClassifier(deps, actor)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(verify).not.toHaveBeenCalled();
    expect(db.secret.create).not.toHaveBeenCalled();
  });

  it("failed probes leave the old connection intact and sanitize upstream errors", async () => {
    const { deps, actor, input, db, verify } = fixture();
    verify.mockRejectedValue(new Error(`provider echoed ${input.apiKey}`));
    await expect(connectMemoryClassifier(deps, actor, input)).rejects.toThrow(
      "Could not verify this connection",
    );
    expect(db.secret.create).not.toHaveBeenCalled();
    expect(db.spaceMemoryClassifierConfig.upsert).not.toHaveBeenCalled();
  });

  it("encrypts the key, atomically replaces the config and removes only its old secret", async () => {
    const { deps, actor, input, db } = fixture();
    await connectMemoryClassifier(deps, actor, input);
    const write = vi.mocked(db.secret.create).mock.calls[0] as unknown as [
      { data: { id: string; ciphertext: string; spaceId: string } },
    ];
    expect(write[0].data.ciphertext).not.toContain(input.apiKey);
    expect(deps.secrets.load(write[0].data.ciphertext, write[0].data.id)).toBe(input.apiKey);
    expect(write[0].data.spaceId).toBe(actor.spaceId);
    expect(db.secret.deleteMany).toHaveBeenCalledWith({
      where: { id: "old-secret", spaceId: actor.spaceId, kind: "memory-classifier" },
    });
  });

  it("rechecks ownership after the network probe", async () => {
    const { deps, actor, input, db, verify } = fixture();
    verify.mockImplementation(async () => {
      db.spaceMember.findUnique.mockResolvedValue({ role: "member", space: { name: "Demo" } });
    });
    await expect(connectMemoryClassifier(deps, actor, input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(db.secret.create).not.toHaveBeenCalled();
  });

  it("resolves the bot method model with a space-scoped secret after specific consent", async () => {
    const { deps, actor, input, db, createClassifier } = fixture();
    vi.spyOn(deps.secrets, "load").mockReturnValue(input.apiKey);
    const method = { provider: input.provider, model: input.model } as const;
    expect(await resolveBotMemoryClassifier(deps, actor, method)).toBe(localMemoryBotClassifier);
    expect(createClassifier).toHaveBeenCalledWith({ ...input, provider: "typesafe-jev" });
    expect(db.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "old-secret", spaceId: actor.spaceId, kind: "memory-classifier" },
    });
    const recipient = aiRecipient({
      provider: input.provider,
      modelId: input.model,
      use: "memory-classification",
    })!;
    expect(db.aiDataConsent.findUnique).toHaveBeenCalledWith({
      where: {
        userId_spaceId_recipientKey: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          recipientKey: recipient.key,
        },
      },
    });
  });

  it("refuses missing or revoked consent before decrypting the secret", async () => {
    const { deps, actor, db, createClassifier } = fixture();
    db.aiDataConsent.findUnique.mockResolvedValue({ version: "obsolete" });
    await expect(
      resolveBotMemoryClassifier(deps, actor, { provider: "typesafe-jev", model: "jev-latest" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.secret.findFirst).not.toHaveBeenCalled();
    expect(createClassifier).not.toHaveBeenCalled();
  });

  it("requires a configured connection for a Jev method", async () => {
    const { deps, actor, db, createClassifier } = fixture();
    db.spaceMemoryClassifierConfig.findUnique.mockResolvedValue(null as never);
    await expect(
      resolveBotMemoryClassifier(deps, actor, { provider: "typesafe-jev", model: "jev-latest" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(createClassifier).not.toHaveBeenCalled();
    expect(db.aiDataConsent.findUnique).not.toHaveBeenCalled();
  });

  it("uses exact reviewed local judgments for a local method without external consent", async () => {
    const { deps, actor, db, createClassifier } = fixture();
    expect(
      await resolveBotMemoryClassifier(deps, actor, {
        provider: "local",
        model: "local-exact-review/1",
      }),
    ).toBe(localMemoryBotClassifier);
    expect(createClassifier).not.toHaveBeenCalled();
    expect(db.aiDataConsent.findUnique).not.toHaveBeenCalled();
  });

  it("disconnects without touching memory content or the storage provider", async () => {
    const { deps, actor, db } = fixture();
    await disconnectMemoryClassifier(deps, actor);
    expect(db.spaceMemoryClassifierConfig.deleteMany).toHaveBeenCalledWith({
      where: { spaceId: actor.spaceId },
    });
    expect(db.secret.deleteMany).toHaveBeenCalledWith({
      where: { id: "old-secret", spaceId: actor.spaceId, kind: "memory-classifier" },
    });
  });
});
