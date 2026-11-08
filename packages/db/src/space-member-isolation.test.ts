import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapUserSpace } from "./bootstrap-user.js";
import type { PrismaClient } from "./client.js";
import { ensureComputerRecord } from "./computers.js";
import {
  applyMigration,
  migrationNames,
  openPgliteDatabase,
  type PgliteDatabase,
} from "./pglite.test-support.js";
import { createRepos } from "./repos.js";
import { acceptSpaceInvitation, createSpaceForMember, createSpaceInvitation } from "./spaces.js";

const env = { signupsEnabled: "true", signupAllowlist: undefined };
const MIGRATION = "20261108130000"; // first isolation migration

describe("people sharing a Space", () => {
  let database: PgliteDatabase;
  let prisma: PrismaClient;
  let ownerHome: string;
  let shared: string;

  const actor = (userId: string, spaceId: string) => ({
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  });
  const newBot = (userId: string) =>
    createRepos(prisma).createBot(actor(userId, shared), {
      name: `${userId} bot`,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });

  beforeAll(async () => {
    database = await openPgliteDatabase();
    prisma = database.prisma;
    for (const id of ["owner", "member"]) {
      await prisma.user.create({ data: { id, name: id, email: `${id}@rakazo.test` } });
    }
    ownerHome = (await bootstrapUserSpace(prisma, { id: "owner" }, env)).spaceId;
    await bootstrapUserSpace(prisma, { id: "member" }, env);
    shared = (
      await createSpaceForMember(prisma, {
        currentSpaceId: ownerHome,
        userId: "owner",
        name: "Family",
      })
    ).id;
    const { token } = await createSpaceInvitation(prisma, { spaceId: shared, userId: "owner" });
    await acceptSpaceInvitation(prisma, { token, userId: "member" });
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  it("gives each person their own team computer", async () => {
    await newBot("owner");
    await newBot("member");
    const computers = await prisma.computer.findMany({
      where: { spaceId: shared },
      select: { id: true, userId: true, scopeKey: true, homeKey: true },
      orderBy: { userId: "asc" },
    });

    expect(computers).toEqual([
      expect.objectContaining({ userId: "member", scopeKey: `team:${shared}:member` }),
      expect.objectContaining({ userId: "owner", scopeKey: `team:${shared}:owner` }),
    ]);
    expect(computers[0]?.homeKey).not.toBe(computers[1]?.homeKey);
    const bots = await prisma.bot.findMany({
      where: { spaceId: shared },
      select: { userId: true, computerId: true },
      orderBy: { userId: "asc" },
    });
    expect(bots.map((bot) => bot.computerId)).toEqual(computers.map((computer) => computer.id));
  });
});

describe("the per-person migration of an existing Space", () => {
  it("keeps the one person's team computer and shared volume", async () => {
    const database = await openPgliteDatabase(async (pglite: PGlite) => {
      const names = await migrationNames();
      for (const name of names.filter((name) => name < MIGRATION)) {
        await applyMigration(pglite, name);
      }
      await pglite.exec(`
        INSERT INTO "user" (id, name, email, "updatedAt")
          VALUES ('user_old', 'Old', 'old@example.test', '2026-11-01');
        INSERT INTO organization (id, name, slug, "createdAt")
          VALUES ('org_old', 'Old', 'old', '2026-11-01');
        INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
          VALUES ('member_old', 'org_old', 'user_old', 'owner', '2026-11-01');
        INSERT INTO spaces (id, "organizationId", name, "skillIndexReceivedAt")
          VALUES ('space_old', 'org_old', 'Old', '2026-11-02');
        INSERT INTO space_members (id, "spaceId", "organizationId", "userId", role, "createdAt")
          VALUES ('space_member_old', 'space_old', 'org_old', 'user_old', 'owner', '2026-11-01');
        INSERT INTO computers (id, "spaceId", "userId", scope, "scopeKey", "homeKey", kind,
          "homeStorage", "updatedAt")
          VALUES ('computer_old', 'space_old', 'user_old', 'team', 'team:space_old',
            'team-space_old', 'docker', 'volumes', '2026-11-01');
        INSERT INTO volumes (id, kind, "spaceId", "providerKind", "providerRef", "updatedAt")
          VALUES ('volume_old', 'space_shared', 'space_old', 'docker', 'shared_files',
            '2026-11-01');
      `);
      for (const name of names.filter((name) => name >= MIGRATION)) {
        await applyMigration(pglite, name);
      }
    });
    try {
      const { prisma } = database;
      const computer = await ensureComputerRecord(prisma, {
        mode: "team",
        spaceId: "space_old",
        userId: "user_old",
        kind: "docker",
        homeStorage: "volumes",
      });
      expect(computer).toMatchObject({
        id: "computer_old",
        scopeKey: "team:space_old:user_old",
        homeKey: "team-space_old",
      });
      expect(
        await prisma.volume.findFirst({
          where: { kind: "space_shared", spaceId: "space_old", userId: "user_old" },
        }),
      ).toMatchObject({
        id: "volume_old",
        providerRef: "shared_files",
        skillIndexReceivedAt: new Date("2026-11-02T00:00:00.000Z"),
      });
    } finally {
      await database.close();
    }
  });
});
