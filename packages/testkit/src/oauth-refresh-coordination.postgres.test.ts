import { randomUUID } from "node:crypto";
import type { ExecutorDeps } from "@rakazo/adapters";
import { createRunExecutor, EncryptedSecretStore } from "@rakazo/adapters";
import type { Db, Pool, PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";

const available = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const encryptionKey = "oauth-refresh-coordination-test-key";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe.skipIf(!available)("model OAuth refresh coordination", () => {
  const clients: Array<{ prisma: Db; pool: Pool }> = [];

  afterEach(async () => {
    await Promise.all(
      clients.splice(0).map(async ({ prisma, pool }) => {
        await prisma.$disconnect();
        await pool.end();
      }),
    );
  });

  it("allows two independent workers to resolve one rotated credential after exactly one refresh", async () => {
    const store = new EncryptedSecretStore(encryptionKey);
    const primaryClient = createDb(process.env.DATABASE_URL!);
    const secondaryClient = createDb(process.env.DATABASE_URL!);
    const { prisma: primary } = primaryClient;
    const { prisma: secondary } = secondaryClient;
    clients.push(primaryClient, secondaryClient);
    const userId = randomUUID();
    const organizationId = randomUUID();
    const spaceId = randomUUID();
    const secretId = randomUUID();
    const credentialId = randomUUID();
    const stale = {
      type: "oauth" as const,
      access: "stale-access",
      refresh: "stale-refresh",
      expires: 0,
      accountId: "test-account",
    };
    const encrypted = await store.put(
      JSON.stringify(stale),
      {
        operationId: "fixture",
        traceId: "fixture",
        userId,
        spaceId,
        signal: new AbortController().signal,
      },
      secretId,
    );
    await primary.user.create({
      data: { id: userId, email: `${userId}@example.test`, name: "OAuth fixture" },
    });
    await primary.organization.create({
      data: { id: organizationId, name: "OAuth fixture", slug: userId, createdAt: new Date() },
    });
    await primary.space.create({
      data: { id: spaceId, organizationId, name: "OAuth fixture", createdByUserId: userId },
    });
    await primary.member.create({
      data: {
        id: randomUUID(),
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await primary.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId,
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await primary.secret.create({
      data: { id: secretId, userId, kind: "model", ciphertext: encrypted.ciphertext },
    });
    await primary.userModelCredential.create({
      data: { id: credentialId, userId, provider: "test-oauth", label: "OAuth fixture", secretId },
    });
    await primary.spaceModelPreference.create({
      data: { spaceId, userId, credentialId, modelId: "test-model", isDefault: true },
    });

    const refreshStarted = deferred();
    const releaseRefresh = deferred();
    let refreshes = 0;
    const externalProvider: NonNullable<ExecutorDeps["modelOAuth"]> = {
      async refresh(_provider, credential, signal) {
        refreshes += 1;
        refreshStarted.resolve();
        await Promise.race([
          releaseRefresh.promise,
          new Promise<never>((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
        ]);
        return {
          ...credential,
          access: "fresh-access",
          refresh: "fresh-refresh",
          expires: Date.now() + 3_600_000,
        };
      },
      async toAuth(_provider, credential) {
        return credential.access;
      },
    };
    const makeWorker = (prisma: PrismaClient) =>
      createRunExecutor({
        prisma,
        secretStore: store,
        modelOAuth: externalProvider,
      } as ExecutorDeps);

    const first = makeWorker(primary).resolveModel({ userId, spaceId });
    await refreshStarted.promise;
    const second = makeWorker(secondary).resolveModel({ userId, spaceId });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(refreshes).toBe(1);
    releaseRefresh.resolve();
    const [firstModel, secondModel] = await Promise.all([first, second]);

    expect(refreshes).toBe(1);
    expect(firstModel.oauth?.credential).toMatchObject({
      access: "fresh-access",
      refresh: "fresh-refresh",
    });
    expect(secondModel.oauth?.credential).toEqual(firstModel.oauth?.credential);
    const reread = await makeWorker(secondary).resolveModel({ userId, spaceId });
    expect(refreshes).toBe(1);
    expect(reread.oauth?.credential).toEqual(firstModel.oauth?.credential);

    await primary.userModelCredential.delete({ where: { id: credentialId } });
    await expect(
      makeWorker(secondary).resolveConnectedModel({
        userId,
        spaceId,
        provider: "test-oauth",
        modelId: "test-model",
      }),
    ).rejects.toThrow("Connect that model provider first");
    expect(refreshes).toBe(1);
  });
});
