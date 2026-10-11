import { SessionId } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { RunHistoryWriteError } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSessionLogConformance } from "./conformance.js";
import type { PgliteDatabase } from "./pglite.js";
import { applyMigration, migrationNames, openPgliteDatabase } from "./pglite.js";
import { PostgresSessionLog } from "./postgres.js";

const SPACE = "space_log";
const USER = "user_log";

async function seedSpace(prisma: PrismaClient): Promise<void> {
  await prisma.user.create({ data: { id: USER, name: "Log", email: "log@rakazo.test" } });
  await prisma.organization.create({
    data: { id: "org_log", name: "Log", slug: "org-log", createdAt: new Date() },
  });
  await prisma.space.create({ data: { id: SPACE, organizationId: "org_log", name: "General" } });
}

async function seedThread(prisma: PrismaClient) {
  const bot = await prisma.bot.create({
    data: { spaceId: SPACE, userId: USER, name: "Ada", color: "#00C46A" },
  });
  const thread = await prisma.thread.create({
    data: { spaceId: SPACE, userId: USER, botId: bot.id },
  });
  const task = await prisma.task.create({
    data: {
      spaceId: SPACE,
      botId: bot.id,
      threadId: thread.id,
      userId: USER,
      prompt: "",
      status: "running",
    },
  });
  const run = await prisma.run.create({
    data: {
      spaceId: SPACE,
      botId: bot.id,
      threadId: thread.id,
      taskId: task.id,
      userId: USER,
      status: "running",
      trigger: "user",
    },
  });
  return { botId: bot.id, threadId: thread.id, sessionId: SessionId.parse(thread.sessionId), run };
}

runSessionLogConformance(async () => {
  const database = await openPgliteDatabase();
  await seedSpace(database.prisma);
  return {
    log: new PostgresSessionLog(database.prisma),
    transaction: (work) => database.prisma.$transaction(work),
    async threadSession() {
      const seeded = await seedThread(database.prisma);
      return {
        session: {
          kind: "thread",
          id: seeded.sessionId,
          spaceId: SPACE,
          threadId: seeded.threadId,
        },
        runId: seeded.run.id,
      };
    },
    async dropEntry(entry) {
      await database.prisma.sessionEntry.delete({ where: { id: entry.id } });
    },
    close: database.close,
  };
});

describe("PostgresSessionLog", () => {
  let database: PgliteDatabase;
  let log: PostgresSessionLog;

  beforeAll(async () => {
    database = await openPgliteDatabase();
    log = new PostgresSessionLog(database.prisma);
    await seedSpace(database.prisma);
  });
  afterAll(() => database.close());

  it("puts a thread session's entries on its thread's feed and a subagent's nowhere", async () => {
    const { prisma } = database;
    const { botId, threadId, sessionId } = await seedThread(prisma);
    const entry = await prisma.$transaction((tx) =>
      log.append(tx, {
        sessionId,
        feedBotId: botId,
        type: "user.message",
        payload: { blocks: [{ kind: "text", text: "hello" }], source: "app" },
      }),
    );
    const authored = await prisma.$transaction((tx) =>
      log.append(tx, {
        sessionId,
        botId: "bot_author",
        feedBotId: botId,
        type: "system.note",
        payload: { text: "noted" },
      }),
    );
    const childId = SessionId.parse("ses_child_feed");
    await prisma.$transaction(async (tx) => {
      await log.createSession(tx, {
        kind: "subagent",
        id: childId,
        spaceId: SPACE,
        parentSessionId: sessionId,
        parentEntryId: entry.id,
      });
      await log.append(tx, {
        sessionId: childId,
        type: "system.note",
        payload: { text: "helper" },
      });
    });

    const events = await prisma.event.findMany({ where: { threadId }, orderBy: { seq: "asc" } });
    expect(events.map(({ type, botId, payload }) => ({ type, botId, payload }))).toEqual([
      { type: "session.entry.appended", botId, payload: { entry } },
      { type: "session.entry.appended", botId: "bot_author", payload: { entry: authored } },
    ]);
  });

  it("refuses a thread session entry that names no bot for the feed", async () => {
    const { prisma } = database;
    const { sessionId } = await seedThread(prisma);

    await expect(
      prisma.$transaction((tx) =>
        log.append(tx, {
          sessionId,
          type: "user.message",
          payload: { blocks: [{ kind: "text", text: "whose?" }], source: "app" },
        }),
      ),
    ).rejects.toMatchObject({ reason: "no_feed_bot" });
    expect(await log.readTail(sessionId)).toEqual([]);
  });

  it("refuses an entry from a cancelled run", async () => {
    const { prisma } = database;
    const { botId, sessionId, run } = await seedThread(prisma);
    await prisma.run.update({ where: { id: run.id }, data: { status: "cancelled" } });

    await expect(
      prisma.$transaction((tx) =>
        log.append(tx, {
          sessionId,
          botId,
          runId: run.id,
          type: "assistant.text",
          payload: { blocks: [{ kind: "text", text: "too late" }] },
        }),
      ),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(await log.readTail(sessionId)).toEqual([]);
  });
});

describe("sessions migration", () => {
  const MIGRATION = "20261011000000_sessions";
  let database: PgliteDatabase;

  beforeAll(async () => {
    const names = await migrationNames();
    database = await openPgliteDatabase(async (pglite) => {
      for (const name of names.slice(0, names.indexOf(MIGRATION))) {
        await applyMigration(pglite, name);
      }
      await pglite.exec(`
        INSERT INTO "user" (id, name, email, "updatedAt") VALUES ('u1', 'U', 'u@rakazo.test', now());
        INSERT INTO organization (id, name, slug, "createdAt") VALUES ('o1', 'O', 'o1', now());
        INSERT INTO spaces (id, "organizationId", name) VALUES ('s1', 'o1', 'S');
        INSERT INTO bots (id, "spaceId", "userId", name, color, "updatedAt")
        VALUES ('b1', 's1', 'u1', 'A', '#000000', now()), ('b2', 's1', 'u1', 'B', '#000000', now());
        INSERT INTO threads (id, "spaceId", "botId", "userId") VALUES ('t1', 's1', 'b1', 'u1'), ('t2', 's1', 'b2', 'u1');
        INSERT INTO tasks (id, "spaceId", "botId", "threadId", "userId", prompt, status, "updatedAt")
        VALUES ('k1', 's1', 'b1', 't1', 'u1', '', 'completed', now());
        INSERT INTO runs (id, "spaceId", "botId", "threadId", "taskId", "userId", status, trigger, "updatedAt")
        VALUES ('r1', 's1', 'b1', 't1', 'k1', 'u1', 'completed', 'user', now());
        INSERT INTO messages (id, "threadId", seq, role, blocks)
        VALUES ('m1', 't1', 0, 'user', '[{"kind":"text","text":"hi"}]');
      `);
      await applyMigration(pglite, MIGRATION);
      await pglite.exec(`DELETE FROM sessions WHERE "threadId" = 't2'`);
      await applyMigration(pglite, MIGRATION);
    });
  });
  afterAll(() => database.close());

  it("gives every existing thread a main session and every run its thread's, and reruns", async () => {
    const { prisma } = database;
    const threads = await prisma.thread.findMany({ orderBy: { id: "asc" } });
    const sessions = await prisma.conversationSession.findMany({ orderBy: { threadId: "asc" } });
    const runs = await prisma.run.findMany();

    expect(sessions.map(({ id, kind, threadId }) => ({ id, kind, threadId }))).toEqual(
      threads.map((thread) => ({ id: thread.sessionId, kind: "thread", threadId: thread.id })),
    );
    expect(runs.map(({ id, sessionId }) => ({ id, sessionId }))).toEqual([
      { id: "r1", sessionId: threads[0]!.sessionId },
    ]);
    expect(
      await prisma.message.findMany({ select: { id: true, seq: true, blocks: true } }),
    ).toEqual([{ id: "m1", seq: 0, blocks: [{ kind: "text", text: "hi" }] }]);
  });

  it("creates a new thread's main session and files a new run under it", async () => {
    const { prisma } = database;
    const bot = await prisma.bot.create({
      data: { spaceId: "s1", userId: "u1", name: "C", color: "#000000" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: "s1", userId: "u1", botId: bot.id },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: "s1",
        botId: bot.id,
        threadId: thread.id,
        taskId: "k1",
        userId: "u1",
        status: "queued",
        trigger: "user",
      },
    });

    expect(
      await prisma.conversationSession.findUnique({ where: { id: thread.sessionId } }),
    ).toEqual(expect.objectContaining({ kind: "thread", threadId: thread.id, nextEntrySeq: 0 }));
    expect(run.sessionId).toBe(thread.sessionId);
  });
});
