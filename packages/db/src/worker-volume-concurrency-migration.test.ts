import type { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigration, migrationNames, openPgliteDatabase } from "./pglite.test-support.js";

const MIGRATION = "20261028000000_drop_volume_writer";
const at = new Date("2026-10-28T00:00:00.000Z");

async function seedDeployment(database: PGlite) {
  await database.exec(`
    INSERT INTO "user" (id, name, email, "updatedAt")
      VALUES ('user_migration', 'Test', 'migration@example.test', '2026-10-28');
    INSERT INTO organization (id, name, slug, "createdAt")
      VALUES ('org_migration', 'Test', 'migration', '2026-10-28');
    INSERT INTO spaces (id, "organizationId", name)
      VALUES ('space_migration', 'org_migration', 'Test');
    INSERT INTO bots (id, "spaceId", "userId", name, color, "updatedAt")
      VALUES ('bot_migration', 'space_migration', 'user_migration', 'Test', '#000000', '2026-10-28');
    INSERT INTO threads (id, "spaceId", "botId", "userId")
      VALUES ('thread_migration', 'space_migration', 'bot_migration', 'user_migration');
    INSERT INTO tasks (id, "spaceId", "botId", "threadId", "userId", prompt, status, "updatedAt")
      VALUES ('task_migration', 'space_migration', 'bot_migration', 'thread_migration',
        'user_migration', 'Test', 'running', '2026-10-28');
    INSERT INTO runs (id, "spaceId", "botId", "threadId", "taskId", "userId", status, trigger,
      "leaseFence", "updatedAt")
      SELECT id, 'space_migration', 'bot_migration', 'thread_migration', 'task_migration',
        'user_migration', status, 'user', 1, '2026-10-28'::timestamp
      FROM (VALUES ('run_ready', 'running'), ('run_releasing', 'cancelled'),
        ('run_requested', 'running')) AS fixture(id, status);
    INSERT INTO attempts (id, "runId", fence, status, "startedAt", "workerState",
      "workerProviderKind", "workerProviderRef", "workerStateAt", "workerEnsureAt",
      "stopPhase", "stopPhaseAt") VALUES
      ('attempt_ready', 'run_ready', 1, 'running', '2026-10-28', 'ready', 'docker',
        'vm_ready', '2026-10-28', '2026-10-28', NULL, NULL),
      ('attempt_releasing', 'run_releasing', 1, 'interrupted', '2026-10-28', 'releasing',
        'docker', 'vm_releasing', '2026-10-28', '2026-10-28', 'unconfirmed', '2026-10-28'),
      ('attempt_requested', 'run_requested', 1, 'running', '2026-10-28', 'requested',
        'docker', NULL, '2026-10-28', '2026-10-28', NULL, NULL);
    INSERT INTO volumes (id, kind, "spaceId", "botId", "providerKind", "providerRef",
      "ensureUntil", "createdAt", "updatedAt") VALUES
      ('volume_private', 'bot_private', 'space_migration', 'bot_migration', 'docker',
        'private_files', NULL, '2026-10-28', '2026-10-28'),
      ('volume_shared', 'space_shared', 'space_migration', NULL, 'docker',
        'shared_files', '2026-10-28', '2026-10-28', '2026-10-28');
  `);
}

describe("volume writer removal migration", () => {
  it.each(["upgrade", "fresh bootstrap"])(
    "%s preserves volumes and worker tracking without retaining attempt deletion restrictions",
    async (path) => {
      const database = await openPgliteDatabase(async (pglite) => {
        const names = await migrationNames();
        for (const name of names.filter((name) => name < MIGRATION)) {
          await applyMigration(pglite, name);
        }
        if (path === "upgrade") {
          await seedDeployment(pglite);
          await pglite.exec(`
            UPDATE volumes SET "writerAttemptId" = 'attempt_ready' WHERE id = 'volume_private';
            UPDATE volumes SET "writerAttemptId" = 'attempt_releasing' WHERE id = 'volume_shared';
          `);
        }
        for (const name of names.filter((name) => name >= MIGRATION)) {
          await applyMigration(pglite, name);
        }
        if (path === "fresh bootstrap") await seedDeployment(pglite);
      });
      try {
        const { prisma } = database;
        const volumes = () =>
          prisma.volume.findMany({
            select: {
              id: true,
              kind: true,
              spaceId: true,
              botId: true,
              providerKind: true,
              providerRef: true,
              ensureUntil: true,
              createdAt: true,
              updatedAt: true,
            },
            orderBy: { id: "asc" },
          });
        const expectedVolumes = [
          {
            id: "volume_private",
            kind: "bot_private",
            spaceId: "space_migration",
            botId: "bot_migration",
            providerKind: "docker",
            providerRef: "private_files",
            ensureUntil: null,
            createdAt: at,
            updatedAt: at,
          },
          {
            id: "volume_shared",
            kind: "space_shared",
            spaceId: "space_migration",
            botId: null,
            providerKind: "docker",
            providerRef: "shared_files",
            ensureUntil: at,
            createdAt: at,
            updatedAt: at,
          },
        ];
        expect(await volumes()).toEqual(expectedVolumes);
        expect(await prisma.attempt.findMany({ orderBy: { id: "asc" } })).toEqual([
          {
            id: "attempt_ready",
            runId: "run_ready",
            fence: 1,
            status: "running",
            error: null,
            startedAt: at,
            finishedAt: null,
            workerState: "ready",
            workerProviderKind: "docker",
            workerProviderRef: "vm_ready",
            workerStateAt: at,
            workerEnsureAt: at,
            stopPhase: null,
            stopPhaseAt: null,
          },
          {
            id: "attempt_releasing",
            runId: "run_releasing",
            fence: 1,
            status: "interrupted",
            error: null,
            startedAt: at,
            finishedAt: null,
            workerState: "releasing",
            workerProviderKind: "docker",
            workerProviderRef: "vm_releasing",
            workerStateAt: at,
            workerEnsureAt: at,
            stopPhase: "unconfirmed",
            stopPhaseAt: at,
          },
          {
            id: "attempt_requested",
            runId: "run_requested",
            fence: 1,
            status: "running",
            error: null,
            startedAt: at,
            finishedAt: null,
            workerState: "requested",
            workerProviderKind: "docker",
            workerProviderRef: null,
            workerStateAt: at,
            workerEnsureAt: at,
            stopPhase: null,
            stopPhaseAt: null,
          },
        ]);
        await prisma.attempt.update({
          where: { id: "attempt_ready" },
          data: { workerState: "released", workerStateAt: at },
        });
        await prisma.attempt.delete({ where: { id: "attempt_ready" } });
        expect(await volumes()).toEqual(expectedVolumes);
      } finally {
        await database.close();
      }
    },
  );
});
