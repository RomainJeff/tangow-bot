import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDb } from "@rakazo/db";
import { describe, expect, it } from "vitest";

const available = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!available)("memory library upgrade", () => {
  it("preserves legacy content and revisions without making private or orphaned documents shared", async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const client = await db.pool.connect();
    const schema = `memory_upgrade_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE "spaces" (id TEXT PRIMARY KEY);
        CREATE TABLE "user" (id TEXT PRIMARY KEY);
        CREATE TABLE "bots" (id TEXT PRIMARY KEY);
        CREATE TABLE "threads" (id TEXT PRIMARY KEY);
        CREATE TABLE "runs" (id TEXT PRIMARY KEY);
        CREATE TABLE "memory_documents" (
          id TEXT PRIMARY KEY, "spaceId" TEXT NOT NULL, "userId" TEXT NOT NULL,
          "botId" TEXT, scope TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL,
          revision INTEGER NOT NULL, "createdAt" TIMESTAMP NOT NULL, "updatedAt" TIMESTAMP NOT NULL
        );
        CREATE TABLE "memory_revisions" (
          id TEXT PRIMARY KEY, "documentId" TEXT NOT NULL, revision INTEGER NOT NULL,
          content TEXT NOT NULL, "sourceRunId" TEXT, "sourceThreadId" TEXT, "createdAt" TIMESTAMP NOT NULL,
          UNIQUE ("documentId", revision)
        );
        INSERT INTO "spaces" VALUES ('fixture-space');
        INSERT INTO "user" VALUES ('fixture-owner'), ('fixture-peer'), ('fixture-orphan-owner');
        INSERT INTO "bots" VALUES ('fixture-bot');
      `);
      const timestamp = "2026-09-01T12:00:00Z";
      const originals = [
        {
          id: "private-owner",
          user: "fixture-owner",
          bot: null,
          scope: "user",
          content: "# Personal\n\nKeep **exact** spacing.\n",
        },
        {
          id: "private-peer",
          user: "fixture-peer",
          bot: null,
          scope: "user",
          content: "Same path, different owner.",
        },
        {
          id: "agent-note",
          user: "fixture-owner",
          bot: "fixture-bot",
          scope: "bot",
          content: "Agent private knowledge.",
        },
        {
          id: "orphan-note",
          user: "fixture-orphan-owner",
          bot: null,
          scope: "bot",
          content: "Preserved after a source bot disappeared.",
        },
      ];
      for (const document of originals) {
        await client.query(
          `INSERT INTO "memory_documents" VALUES ($1, 'fixture-space', $2, $3, $4, 'MEMORY.md', $5, 2, $6, $6)`,
          [document.id, document.user, document.bot, document.scope, document.content, timestamp],
        );
        await client.query(
          `INSERT INTO "memory_revisions" VALUES ($1, $2, 1, $3, 'fixture-run', 'fixture-thread', $4), ($5, $2, 2, $6, NULL, NULL, $4)`,
          [
            `${document.id}-r1`,
            document.id,
            "First version.\n",
            timestamp,
            `${document.id}-r2`,
            document.content,
          ],
        );
      }
      const before = (
        await client.query(
          `SELECT id, "documentId", revision, content, "sourceRunId", "sourceThreadId", "createdAt" FROM "memory_revisions" ORDER BY id`,
        )
      ).rows;
      const migration = await readFile(
        new URL(
          "../../db/prisma/migrations/20261018000000_memory_library/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await client.query(migration);
      const evidenceMigration = await readFile(
        new URL(
          "../../db/prisma/migrations/20261018010000_memory_evidence/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await client.query(evidenceMigration);
      const after = (
        await client.query(
          `SELECT id, "documentId", revision, content, "sourceRunId", "sourceThreadId", "createdAt" FROM "memory_revisions" ORDER BY id`,
        )
      ).rows;
      expect(after).toEqual(before);
      for (const original of originals) {
        const migrated = (
          await client.query(
            `SELECT d.*, c.kind, c."ownerUserId" FROM "memory_documents" d JOIN "memory_collections" c ON c.id = d."collectionId" WHERE d.id = $1`,
            [original.id],
          )
        ).rows[0];
        expect(migrated).toMatchObject({
          content: original.content,
          revision: 2,
          status: "proposed",
          ownerUserId: original.user,
          kind: original.bot ? "agent" : "personal",
        });
      }
      expect(
        (await client.query(`SELECT id FROM "memory_collections" WHERE kind = 'space'`)).rows,
      ).toHaveLength(0);
      const duplicate = await client.query(
        `INSERT INTO "memory_collections" (id, "spaceId", kind, "ownerUserId", "botId") VALUES ('duplicate-fixture', 'fixture-space', 'personal', 'fixture-owner', NULL) ON CONFLICT DO NOTHING RETURNING id`,
      );
      expect(duplicate.rows).toHaveLength(0);
      expect((await client.query(`SELECT id FROM "memory_evidence"`)).rows).toHaveLength(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
});
