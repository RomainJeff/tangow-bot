import { afterAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import { storeLinkPreviewCache } from "./link-preview.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("link preview cache (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `link-preview-user-${suffix}`;
  const organizationId = `link-preview-organization-${suffix}`;
  const spaceId = `link-preview-space-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("reports the replaced image of two parallel stores of one link", async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: {
        id: userId,
        name: "Link Preview",
        email: `${userId}@rakazo.test`,
        emailVerified: false,
      },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Link Preview",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "General", createdByUserId: userId },
    });

    const leaked: string[] = [];
    for (let round = 0; round < 20; round += 1) {
      const keyHash = `key-${round}`;
      const store = (imageKey: string) =>
        storeLinkPreviewCache(prisma, {
          spaceId,
          keyHash,
          entry: {
            kind: "photo",
            image: { key: imageKey, width: 10, height: 10, bytes: 100 },
          },
        });
      const results = await Promise.all([store(`${keyHash}-a`), store(`${keyHash}-b`)]);
      const row = await prisma.linkPreviewCache.findUnique({
        where: { spaceId_keyHash: { spaceId, keyHash } },
      });
      const accounted = new Set([
        ...results.flatMap((result) => result.removedImageKeys),
        ...(row?.imageKey ? [row.imageKey] : []),
      ]);
      for (const key of [`${keyHash}-a`, `${keyHash}-b`]) {
        if (!accounted.has(key)) leaked.push(key);
      }
    }
    expect(leaked).toEqual([]);
  });
});
