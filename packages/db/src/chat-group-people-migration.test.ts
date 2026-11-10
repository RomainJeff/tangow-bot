import { describe, expect, it } from "vitest";
import { applyMigration, migrationNames, openPgliteDatabase } from "./pglite.test-support.js";

const MIGRATION = "20261111120000_chat_group_people";

describe("chat group people migration", () => {
  it("moves each group's pin, section and unread mark onto its creator's row", async () => {
    const database = await openPgliteDatabase(async (pglite) => {
      const names = await migrationNames();
      for (const name of names.filter((name) => name < MIGRATION)) {
        await applyMigration(pglite, name);
      }
      await pglite.exec(`
        INSERT INTO "user" (id, name, email, "updatedAt")
          VALUES ('creator', 'Creator', 'creator@example.test', '2026-11-11');
        INSERT INTO organization (id, name, slug, "createdAt")
          VALUES ('org', 'Org', 'org', '2026-11-11');
        INSERT INTO spaces (id, "organizationId", name) VALUES ('space', 'org', 'Space');
        INSERT INTO bot_sections (id, "spaceId", "userId", name, "updatedAt")
          VALUES ('section', 'space', 'creator', 'Work', '2026-11-11');
        INSERT INTO chat_groups (id, "spaceId", "userId", name, pinned, "sectionId", "updatedAt")
          VALUES ('pinned_unread', 'space', 'creator', 'A', true, 'section', '2026-11-11'),
            ('plain', 'space', 'creator', 'B', false, NULL, '2026-11-11');
        INSERT INTO threads (id, "spaceId", "groupId", "userId", unread)
          VALUES ('thread_a', 'space', 'pinned_unread', 'creator', true),
            ('thread_b', 'space', 'plain', 'creator', false);
      `);
      for (const name of names.filter((name) => name >= MIGRATION)) {
        await applyMigration(pglite, name);
      }
    });
    try {
      const { prisma } = database;
      expect(
        await prisma.chatGroupPerson.findMany({
          select: { groupId: true, userId: true, unread: true, pinned: true, sectionId: true },
          orderBy: { groupId: "asc" },
        }),
      ).toEqual([
        {
          groupId: "pinned_unread",
          userId: "creator",
          unread: true,
          pinned: true,
          sectionId: "section",
        },
        { groupId: "plain", userId: "creator", unread: false, pinned: false, sectionId: null },
      ]);
      expect(await prisma.chatGroup.findMany({ select: { leadBotId: true } })).toEqual([
        { leadBotId: null },
        { leadBotId: null },
      ]);
    } finally {
      await database.close();
    }
  }, 60_000);
});
