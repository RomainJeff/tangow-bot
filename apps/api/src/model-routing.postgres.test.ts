import { randomUUID } from "node:crypto";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, findModelCategories, setModelCategory } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("model category settings (PostgreSQL)", () => {
  const suffix = randomUUID();
  const userId = `routing-user-${suffix}`;
  const otherUserId = `routing-other-${suffix}`;
  const organizationId = `routing-org-${suffix}`;
  const spaceId = `routing-space-${suffix}`;
  const otherSpaceId = `routing-other-space-${suffix}`;
  const actor: Actor = { userId, spaceId, email: "routing@example.test", isDeploymentOwner: false };
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let handler: RPCHandler<{ actor: Actor | null }>;
  let credentialId: string;
  let otherCredentialId: string;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    for (const id of [userId, otherUserId]) {
      await prisma.user.create({
        data: { id, name: "Routing test", email: `${id}@example.test`, emailVerified: false },
      });
    }
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Routing test",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    for (const id of [spaceId, otherSpaceId]) {
      await prisma.space.create({
        data: { id, organizationId, name: "Routing test", createdByUserId: userId },
      });
    }
    for (const id of [userId, otherUserId]) {
      await prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: id,
          role: "member",
          createdAt: new Date(),
        },
      });
      for (const sid of [spaceId, otherSpaceId]) {
        await prisma.spaceMember.create({
          data: {
            id: randomUUID(),
            organizationId,
            spaceId: sid,
            userId: id,
            createdAt: new Date(),
          },
        });
      }
    }
    await prisma.userModelCredential.create({
      data: {
        userId,
        provider: "scripted",
        label: "Older",
        secretId: "fake-old-secret",
        updatedAt: new Date(0),
      },
    });
    const credential = await prisma.userModelCredential.create({
      data: { userId, provider: "scripted", label: "Test", secretId: "fake-secret" },
    });
    credentialId = credential.id;
    const other = await prisma.userModelCredential.create({
      data: {
        userId: otherUserId,
        provider: "anthropic",
        label: "Other",
        secretId: "fake-other-secret",
      },
    });
    otherCredentialId = other.id;
    handler = new RPCHandler(createRouter({ prisma } as RouterDeps));
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await close();
  });

  async function rpc(method: string, input?: unknown, caller: Actor | null = actor) {
    const { response } = await handler.handle(
      new Request(`http://localhost/rpc/models/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: caller } },
    );
    return { status: response!.status, body: await response!.json() };
  }

  it("upserts category settings and exposes Auto only in the active member's Space", async () => {
    expect((await rpc("routing")).body.json).toMatchObject({ auto: false, categories: [] });
    expect(
      (
        await rpc("setCategory", {
          category: "fast",
          provider: "scripted",
          modelId: "scripted",
          thinkingLevel: "low",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await rpc("setCategory", {
          category: "fast",
          provider: "scripted",
          modelId: "scripted",
          thinkingLevel: "high",
        })
      ).status,
    ).toBe(200);
    expect((await rpc("setAuto", { enabled: true })).status).toBe(200);
    const listed = (await rpc("routing")).body.json;
    expect(listed).toMatchObject({
      auto: true,
      categories: [
        { category: "fast", provider: "scripted", modelId: "scripted", thinkingLevel: "high" },
      ],
    });
    expect(
      (await rpc("routing", undefined, { ...actor, spaceId: otherSpaceId })).body.json,
    ).toMatchObject({ auto: false, categories: [] });
    expect(
      (await rpc("routing", undefined, { ...actor, userId: otherUserId })).body.json,
    ).toMatchObject({ auto: false, categories: [] });
    expect(await findModelCategories(prisma, actor)).toMatchObject([{ credentialId }]);
    expect(
      (await rpc("clearCategory", { category: "fast" }, { ...actor, spaceId: otherSpaceId }))
        .status,
    ).toBe(200);
    expect(await findModelCategories(prisma, actor)).toHaveLength(1);
    expect(
      (await rpc("setCategory", { category: "fast", provider: "scripted", modelId: "scripted" }))
        .status,
    ).toBe(200);
    expect((await rpc("routing")).body.json.categories).toEqual([
      { category: "fast", provider: "scripted", modelId: "scripted", thinkingLevel: null },
    ]);
    expect((await rpc("clearCategory", { category: "fast" })).status).toBe(200);
    expect((await rpc("setAuto", { enabled: false })).status).toBe(200);
    expect((await rpc("routing")).body.json).toMatchObject({ auto: false, categories: [] });
  });

  it("rejects another user's connection and unknown models without saving an assignment", async () => {
    expect(
      (
        await rpc("setCategory", {
          category: "complex",
          provider: "anthropic",
          modelId: "claude-opus-4-6",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await rpc("setCategory", {
          category: "complex",
          provider: "scripted",
          modelId: "unknown-model",
        })
      ).status,
    ).toBe(400);
    await expect(
      setModelCategory(prisma, actor, {
        category: "complex",
        credentialId: otherCredentialId,
        modelId: "other",
      }),
    ).rejects.toThrow();
    expect((await rpc("setAuto", { enabled: true }, null)).status).toBe(401);
    expect(await findModelCategories(prisma, actor)).toEqual([]);
  });

  it("removes assignments when the connection or Space membership is deleted", async () => {
    await setModelCategory(prisma, actor, {
      category: "everyday",
      credentialId,
      modelId: "scripted",
    });
    await setModelCategory(
      prisma,
      { ...actor, spaceId: otherSpaceId },
      { category: "fast", credentialId, modelId: "scripted" },
    );
    await prisma.spaceMember.delete({
      where: { spaceId_userId: { spaceId: otherSpaceId, userId } },
    });
    expect(await findModelCategories(prisma, { ...actor, spaceId: otherSpaceId })).toEqual([]);
    await prisma.userModelCredential.delete({ where: { id: credentialId } });
    expect((await rpc("routing")).body.json.categories).toEqual([]);
  });
});
