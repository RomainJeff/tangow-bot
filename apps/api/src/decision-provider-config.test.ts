import type { PrismaClient } from "@tangow/db";
import { describe, expect, it, vi } from "vitest";
import {
  disconnectDecisionProvider,
  persistDecisionProviderConfig,
} from "./decision-provider-config.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "a@example.test",
  isDeploymentOwner: false,
};

function makeDeps(
  options: { spaceOwner?: boolean; existing?: { id: string; secretId: string } } = {},
) {
  const upsert = vi.fn(async (args: { create: { provider: string; settings: unknown } }) => ({
    provider: args.create.provider,
    settings: args.create.settings,
    updatedAt: new Date("2026-09-26T00:00:00.000Z"),
  }));
  const secretDeleteMany = vi.fn(async () => ({ count: 1 }));
  const deleteConfig = vi.fn(async () => ({}));
  const prisma = {
    spaceMember: {
      findUnique: vi.fn(async () => (options.spaceOwner === false ? null : { role: "owner" })),
    },
    spaceDecisionConfig: {
      findUnique: vi.fn(async () => options.existing ?? null),
      upsert,
      delete: deleteConfig,
    },
    secret: { create: vi.fn(async () => ({ id: "secret-new" })), deleteMany: secretDeleteMany },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  const put = vi.fn(async () => ({ id: "secret-new", ciphertext: "cipher" }));
  return {
    deps: { prisma: prisma as unknown as PrismaClient, secrets: { put } },
    put,
    upsert,
    secretDeleteMany,
    deleteConfig,
  };
}

describe("decision provider config", () => {
  it("stores the key encrypted and returns settings without credentials", async () => {
    const { deps, put, upsert, secretDeleteMany } = makeDeps({
      existing: { id: "cfg-1", secretId: "secret-old" },
    });
    const config = await persistDecisionProviderConfig(deps, actor, {
      provider: "openrouter",
      settings: { modelId: "typesafe/jev-1.13" },
      credentials: { apiKey: "test-key-not-real" },
    });
    expect(config).toEqual({
      provider: "openrouter",
      settings: { modelId: "typesafe/jev-1.13" },
      updatedAt: "2026-09-26T00:00:00.000Z",
    });
    expect(put).toHaveBeenCalledWith(
      JSON.stringify({ apiKey: "test-key-not-real" }),
      expect.anything(),
    );
    expect(JSON.stringify(upsert.mock.calls)).not.toContain("test-key-not-real");
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-old" } });
  });

  it("refuses a missing key or a malformed base URL before storing anything", async () => {
    for (const input of [
      { settings: {}, credentials: {} },
      { settings: { baseUrl: "ftp://proxy.example.test" }, credentials: { apiKey: "k" } },
    ]) {
      const { deps, put } = makeDeps();
      await expect(
        persistDecisionProviderConfig(deps, actor, { provider: "openrouter", ...input }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(put).not.toHaveBeenCalled();
    }
  });

  it("keeps private endpoints with the deployment owner", async () => {
    const input = {
      provider: "openrouter",
      settings: { baseUrl: "http://127.0.0.1:9000" },
      credentials: { apiKey: "k" },
    };
    const member = makeDeps();
    await expect(persistDecisionProviderConfig(member.deps, actor, input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(member.put).not.toHaveBeenCalled();
    const owner = makeDeps();
    await expect(
      persistDecisionProviderConfig(owner.deps, { ...actor, isDeploymentOwner: true }, input),
    ).resolves.toMatchObject({ provider: "openrouter" });
  });

  it("is limited to Space owners and disconnects with its secret", async () => {
    const outsider = makeDeps({ spaceOwner: false });
    await expect(disconnectDecisionProvider(outsider.deps, actor)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const { deps, deleteConfig, secretDeleteMany } = makeDeps({
      existing: { id: "cfg-1", secretId: "secret-old" },
    });
    await expect(disconnectDecisionProvider(deps, actor)).resolves.toEqual({ ok: true });
    expect(deleteConfig).toHaveBeenCalledWith({ where: { id: "cfg-1" } });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-old" } });

    const unset = makeDeps();
    await expect(disconnectDecisionProvider(unset.deps, actor)).resolves.toEqual({ ok: true });
    expect(unset.deleteConfig).not.toHaveBeenCalled();
    expect(unset.secretDeleteMany).not.toHaveBeenCalled();
  });
});
