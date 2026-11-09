import type { SessionEntryDraft } from "@rakazo/adapter-kit";
import { SessionId } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { RunHistoryWriteError } from "@rakazo/db";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { applyMigration, migrationNames, openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSessionLogConformance } from "./conformance.js";
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

  it("puts a thread session's entries on its thread's feed and a subagent's steps nowhere", async () => {
    const { prisma } = database;
    const { botId, threadId, sessionId, run } = await seedThread(prisma);
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
        botId,
        runId: run.id,
        type: "assistant.text",
        payload: { blocks: [{ kind: "text", text: "helper" }] },
      });
    });

    const events = await prisma.event.findMany({ where: { threadId }, orderBy: { seq: "asc" } });
    const { sessionId: _entrySession, ...fedEntry } = entry;
    const { sessionId: _authoredSession, ...fedAuthored } = authored;
    expect(events.map(({ type, botId, payload }) => ({ type, botId, payload }))).toEqual([
      { type: "session.entry.appended", botId, payload: { entries: [fedEntry] } },
      { type: "session.entry.appended", botId: "bot_author", payload: { entries: [fedAuthored] } },
    ]);
  });

  it("puts every entry a transaction appends to a thread on one feed event", async () => {
    const { prisma } = database;
    const { botId, threadId, sessionId, run } = await seedThread(prisma);
    const appended = await prisma.$transaction(async (tx) => [
      await log.append(tx, {
        sessionId,
        botId,
        runId: run.id,
        type: "assistant.text",
        payload: { blocks: [{ kind: "text", text: "one" }] },
      }),
      await log.append(tx, {
        sessionId,
        botId,
        runId: run.id,
        type: "assistant.text",
        payload: { blocks: [{ kind: "text", text: "two" }] },
      }),
    ]);

    const events = await prisma.event.findMany({ where: { threadId } });
    expect(
      events.map(({ type, botId, runId, payload }) => ({ type, botId, runId, payload })),
    ).toEqual([
      {
        type: "session.entry.appended",
        botId,
        runId: run.id,
        payload: {
          entries: [
            {
              id: appended[0]!.id,
              seq: 0,
              parentId: null,
              ts: appended[0]!.ts,
              botId,
              runId: run.id,
              type: "assistant.text",
              payload: { blocks: [{ kind: "text", text: "one" }] },
            },
            {
              id: appended[1]!.id,
              seq: 1,
              parentId: appended[0]!.id,
              ts: appended[1]!.ts,
              botId,
              runId: run.id,
              type: "assistant.text",
              payload: { blocks: [{ kind: "text", text: "two" }] },
            },
          ],
        },
      },
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

  it("refuses a run's own entries after its run.finished, but not its subagent entry", async () => {
    const { prisma } = database;
    const { botId, sessionId, run } = await seedThread(prisma);
    const ofRun = { sessionId, botId, runId: run.id };
    const append = (draft: SessionEntryDraft) => prisma.$transaction((tx) => log.append(tx, draft));
    await append({
      ...ofRun,
      type: "run.finished",
      payload: { status: "completed", usage: { inputTokens: 1, outputTokens: 1 } },
    });

    await expect(
      append({
        ...ofRun,
        type: "assistant.text",
        payload: { blocks: [{ kind: "text", text: "late" }] },
      }),
    ).rejects.toMatchObject({ reason: "run_finished" });
    await append({
      ...ofRun,
      type: "subagent",
      payload: {
        callId: "call_helper",
        sessionId: SessionId.parse("ses_helper_after"),
        name: "checker",
        model: { provider: "emulator", id: "emulator-1" },
        task: "Check it.",
        status: "completed",
        result: "checked",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });
    expect((await log.readTail(sessionId)).map((entry) => entry.type)).toEqual([
      "run.finished",
      "subagent",
    ]);
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
  /** The backfill reads the messages until this drops them; its own test covers it. */
  const DROP = "20261012000000_drop_messages";
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
        UPDATE threads SET "historyCompactedUpToSeq" = 0, "historyCompactionSummary" = 'Said hi.'
        WHERE id = 't1';
      `);
      await applyMigration(pglite, MIGRATION);
      await pglite.exec(`DELETE FROM sessions WHERE "threadId" = 't2'`);
      await applyMigration(pglite, MIGRATION);
      await pglite.exec(`
        INSERT INTO session_entries (id, "sessionId", seq, "parentId", type, payload)
        SELECT 'e' || n, "sessionId", n, CASE WHEN n = 0 THEN NULL ELSE 'e' || (n - 1) END,
          'system.note', '{"text":"before the head pointer"}'
        FROM threads, generate_series(0, 1) AS n WHERE threads.id = 't1';
        UPDATE sessions SET "nextEntrySeq" = 2 WHERE "threadId" = 't1';
      `);
      for (const name of names.slice(names.indexOf(MIGRATION) + 1, names.indexOf(DROP))) {
        await applyMigration(pglite, name);
        await applyMigration(pglite, name);
      }
    });
  });
  afterAll(() => database.close());

  it("gives every existing thread a main session and every run its thread's, and reruns", async () => {
    const { prisma } = database;
    const threads = await prisma.thread.findMany({
      select: { id: true, sessionId: true },
      orderBy: { id: "asc" },
    });
    const sessions = await prisma.conversationSession.findMany({ orderBy: { threadId: "asc" } });
    const runs = await prisma.run.findMany({ select: { id: true, sessionId: true } });

    expect(sessions.map(({ id, kind, threadId }) => ({ id, kind, threadId }))).toEqual(
      threads.map((thread) => ({ id: thread.sessionId, kind: "thread", threadId: thread.id })),
    );
    expect(runs.map(({ id, sessionId }) => ({ id, sessionId }))).toEqual([
      { id: "r1", sessionId: threads[0]!.sessionId },
    ]);
    expect(await prisma.$queryRaw`SELECT id, seq, blocks FROM messages`).toEqual([
      { id: "m1", seq: 0, blocks: [{ kind: "text", text: "hi" }] },
    ]);
  });

  it("indexes the entries that rose from a child session by the session they came from", async () => {
    expect(
      await database.prisma.$queryRaw`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'session_entries_originSessionId_idx'`,
    ).toEqual([
      {
        indexdef: `CREATE INDEX "session_entries_originSessionId_idx" ON public.session_entries USING btree (((payload ->> 'originSessionId'::text))) WHERE ((payload ->> 'originSessionId'::text) IS NOT NULL)`,
      },
    ]);
  });

  it("keeps a thread's compaction summary from before the log for the backfill to read", async () => {
    expect(
      await database.prisma.$queryRaw`
        SELECT "historyCompactedUpToSeq", "historyCompactionSummary" FROM threads WHERE id = 't1'`,
    ).toEqual([{ historyCompactedUpToSeq: 0, historyCompactionSummary: "Said hi." }]);
  });

  it("points a session that already has entries at its newest one, so the next append chains on", async () => {
    const { prisma } = database;
    const { sessionId } = await prisma.thread.findUniqueOrThrow({
      where: { id: "t1" },
      select: { sessionId: true },
    });
    const next = await prisma.$transaction((tx) =>
      new PostgresSessionLog(prisma).append(tx, {
        sessionId: SessionId.parse(sessionId),
        feedBotId: "b1",
        type: "system.note",
        payload: { text: "after" },
      }),
    );

    expect([next.seq, next.parentId]).toEqual([2, "e1"]);
  });

  it("creates a new thread's main session and files a new run under it", async () => {
    const { prisma } = database;
    const bot = { id: "b_new_thread" };
    await prisma.$executeRaw`INSERT INTO bots (id, "spaceId", "userId", name, color, "updatedAt")
      VALUES (${bot.id}, 's1', 'u1', 'C', '#000000', now())`;
    const [thread] = await prisma.$queryRaw<Array<{ id: string; sessionId: string }>>`
      INSERT INTO threads (id, "spaceId", "userId", "botId") VALUES ('t_new_thread', 's1', 'u1', ${bot.id})
      RETURNING id, "sessionId"`;
    if (!thread) throw new Error("thread not seeded");
    await prisma.$executeRaw`INSERT INTO runs
      (id, "spaceId", "botId", "threadId", "taskId", "userId", status, trigger, "updatedAt")
      VALUES ('r_new_thread', 's1', ${bot.id}, ${thread.id}, 'k1', 'u1', 'queued', 'user', now())`;
    const run = await prisma.run.findUniqueOrThrow({
      where: { id: "r_new_thread" },
      select: { sessionId: true },
    });

    expect(
      await prisma.conversationSession.findUnique({ where: { id: thread.sessionId } }),
    ).toEqual(expect.objectContaining({ kind: "thread", threadId: thread.id, nextEntrySeq: 0 }));
    expect(run.sessionId).toBe(thread.sessionId);
  });
});
