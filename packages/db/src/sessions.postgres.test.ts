import { randomUUID } from "node:crypto";
import type { SessionEntryDraft } from "@rakazo/adapter-kit";
import type { SessionEntry } from "@rakazo/contracts";
import { SessionId } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelRunsInTransaction, logCancelledRunsInTransaction } from "./cancel-runs.js";
import { createDb, type PrismaClient } from "./client.js";
import { clearThread, finalizeComputerControlRelease } from "./events.js";
import {
  appendComputerControlInTransaction,
  appendRunFinishedInTransaction,
  appendSessionEntryInTransaction,
  createSessionInTransaction,
  openRoutineSessionInTransaction,
} from "./sessions.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
const TRANSACTION = { timeout: 20_000 };

describePostgres("appendSessionEntryInTransaction under contention (PostgreSQL)", () => {
  const id = `sessions-${process.pid}-${Date.now()}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!, { poolMax: 4 });
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({ data: { id, name: "Sessions", email: `${id}@rakazo.test` } });
    await prisma.organization.create({
      data: { id, name: "Sessions", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "General" } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { id } });
    await close();
  });

  async function freshSession(): Promise<SessionId> {
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Ada", color: "#00C46A" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    return SessionId.parse(thread.sessionId);
  }

  async function queuedRun() {
    const sessionId = await freshSession();
    const { id: threadId, botId } = await prisma.thread.findUniqueOrThrow({
      where: { sessionId },
      select: { id: true, botId: true },
    });
    const task = await prisma.task.create({
      data: { spaceId: id, botId: botId!, threadId, userId: id, prompt: "", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        botId: botId!,
        threadId,
        taskId: task.id,
        userId: id,
        status: "running",
        trigger: "user",
      },
    });
    return { sessionId, threadId, botId: botId!, runId: run.id, taskId: task.id };
  }

  function runStarted(sessionId: SessionId, botId: string, runId: string): SessionEntryDraft {
    return {
      sessionId,
      botId,
      runId,
      type: "run.started",
      payload: { trigger: { kind: "direct" }, model: { provider: "p", id: "m" }, effort: null },
    };
  }

  async function startedRun() {
    const run = await queuedRun();
    await prisma.$transaction((tx) =>
      appendSessionEntryInTransaction(tx, runStarted(run.sessionId, run.botId, run.runId)),
    );
    return run;
  }

  async function startedRoutineRun() {
    const run = await queuedRun();
    const routineSessionId = await prisma.$transaction(async (tx) => {
      const opened = await openRoutineSessionInTransaction(
        tx,
        { id: run.runId, spaceId: id, threadId: run.threadId, botId: run.botId },
        {
          routineId: "routine-digest",
          name: "Digest",
          trigger: "routine",
          scheduledAt: new Date().toISOString(),
          model: { provider: "p", id: "m" },
        },
      );
      await appendSessionEntryInTransaction(tx, runStarted(opened, run.botId, run.runId));
      return opened;
    });
    return { ...run, childSessionId: routineSessionId };
  }

  async function startedHelperRun() {
    const parent = await startedRun();
    return prisma.$transaction(async (tx) => {
      const call = await appendSessionEntryInTransaction(tx, {
        sessionId: parent.sessionId,
        botId: parent.botId,
        runId: parent.runId,
        type: "tool.call",
        payload: { callId: "call_helper", name: "run_subagent", input: "{}" },
      });
      const childSessionId = await createSessionInTransaction(tx, {
        kind: "subagent",
        id: SessionId.parse(randomUUID()),
        spaceId: id,
        parentSessionId: parent.sessionId,
        parentEntryId: call.id,
      });
      const task = await tx.task.create({
        data: {
          spaceId: id,
          botId: parent.botId,
          threadId: parent.threadId,
          userId: id,
          prompt: "",
          status: "running",
        },
      });
      const helper = await tx.run.create({
        data: {
          spaceId: id,
          botId: parent.botId,
          threadId: parent.threadId,
          taskId: task.id,
          userId: id,
          status: "running",
          trigger: "subagent",
          sessionId: childSessionId,
          parentRunId: parent.runId,
        },
      });
      await appendSessionEntryInTransaction(
        tx,
        runStarted(childSessionId, parent.botId, helper.id),
      );
      return { ...parent, runId: helper.id, taskId: task.id, childSessionId };
    });
  }

  function said(sessionId: SessionId, text: string): SessionEntryDraft {
    return {
      sessionId,
      feedBotId: id,
      type: "user.message",
      payload: { blocks: [{ kind: "text", text }], source: "app" },
    };
  }

  async function waitForLockWaiter(): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (row!.waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("The second append never waited for the first");
  }

  /**
   * Appends `first` and holds its transaction open until the append of `second`, in a transaction
   * of its own, waits on a lock, then lets both commit.
   */
  async function contend(
    first: SessionEntryDraft,
    second: SessionEntryDraft,
  ): Promise<[SessionEntry, SessionEntry]> {
    let appended!: () => void;
    let release!: () => void;
    const firstAppended = new Promise<void>((resolve) => {
      appended = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstCommitted = prisma.$transaction(async (tx) => {
      const entry = await appendSessionEntryInTransaction(tx, first);
      appended();
      await released;
      return entry;
    }, TRANSACTION);
    await Promise.race([firstAppended, firstCommitted]);
    const secondCommitted = prisma.$transaction(
      (tx) => appendSessionEntryInTransaction(tx, second),
      TRANSACTION,
    );
    await waitForLockWaiter();
    release();
    return Promise.all([firstCommitted, secondCommitted]);
  }

  it("keeps one entry for two concurrent deliveries of one clientNonce", async () => {
    const sessionId = await freshSession();
    const delivery: SessionEntryDraft = {
      sessionId,
      feedBotId: id,
      type: "user.message",
      payload: {
        blocks: [{ kind: "text", text: "once" }],
        source: "app",
        clientNonce: "delivery-1",
      },
    };

    const [first, second] = await contend(delivery, delivery);

    expect(second).toEqual(first);
    expect(
      await prisma.sessionEntry.findMany({ where: { sessionId }, select: { id: true, seq: true } }),
    ).toEqual([{ id: first.id, seq: 0 }]);
    expect(
      await prisma.conversationSession.findUnique({
        where: { id: sessionId },
        select: { nextEntrySeq: true },
      }),
    ).toEqual({ nextEntrySeq: 1 });
  });

  it("keeps one entry, in the thread's session, for two concurrent deliveries of one clientNonce addressed to a helper's session", async () => {
    const parentSessionId = await freshSession();
    const parent = await prisma.$transaction((tx) =>
      appendSessionEntryInTransaction(tx, said(parentSessionId, "delegate")),
    );
    const sessionId = await prisma.$transaction((tx) =>
      createSessionInTransaction(tx, {
        kind: "subagent",
        id: SessionId.parse(randomUUID()),
        spaceId: id,
        parentSessionId,
        parentEntryId: parent.id,
      }),
    );
    const delivery: SessionEntryDraft = {
      sessionId,
      feedBotId: id,
      type: "user.message",
      payload: { blocks: [{ kind: "text", text: "once" }], source: "app", clientNonce: "helper-1" },
    };

    const [first, second] = await contend(delivery, delivery);

    expect(second).toEqual(first);
    expect(
      await prisma.sessionEntry.findMany({
        where: { sessionId: { in: [sessionId, parentSessionId] } },
        orderBy: { seq: "asc" },
        select: { id: true, sessionId: true, seq: true },
      }),
    ).toEqual([
      { id: parent.id, sessionId: parentSessionId, seq: 0 },
      { id: first.id, sessionId: parentSessionId, seq: 1 },
    ]);
  });

  it("closes a run's log once when a cancel waits on a finalize that commits first", async () => {
    const { threadId, runId } = await startedRun();
    let finalized!: () => void;
    let release!: () => void;
    const finalizing = new Promise<void>((resolve) => {
      finalized = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finalize = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      await tx.run.update({ where: { id: runId }, data: { status: "completed" } });
      await appendRunFinishedInTransaction(tx, runId, { status: "completed" });
      finalized();
      await released;
    }, TRANSACTION);
    await Promise.race([finalizing, finalize]);
    const cancel = prisma.$transaction(
      (tx) => logCancelledRunsInTransaction(tx, [runId], id),
      TRANSACTION,
    );
    await waitForLockWaiter();
    release();
    await Promise.all([finalize, cancel]);

    const logged = await prisma.sessionEntry.findMany({
      where: { runId },
      orderBy: { seq: "asc" },
      select: { type: true, payload: true },
    });
    expect(
      logged.map(({ type, payload }) => [type, (payload as { status?: string }).status]),
    ).toEqual([
      ["run.started", undefined],
      ["run.finished", "completed"],
    ]);
  });

  it("locks the threads of the runs it cancels in id order", async () => {
    const [low, high] = [await startedRun(), await startedRun()].sort((a, b) =>
      a.threadId < b.threadId ? -1 : 1,
    );
    let locked!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${low!.threadId} FOR UPDATE`;
      locked();
      await released;
    }, TRANSACTION);
    await holding;
    const cancel = prisma.$transaction(
      (tx) => logCancelledRunsInTransaction(tx, [high!.runId, low!.runId], id),
      TRANSACTION,
    );
    await waitForLockWaiter();
    const probe = await prisma.$queryRaw`
      SELECT id FROM threads WHERE id = ${high!.threadId} FOR UPDATE NOWAIT`.then(
      () => "free",
      (error: unknown) => String(error),
    );
    release();
    await Promise.all([holder, cancel]);

    expect(probe).toBe("free");
  });

  it.each([
    ["a routine run", startedRoutineRun],
    ["a helper run", startedHelperRun],
  ])(
    "starts %s's helper behind its thread lock, so a stop landing meanwhile cancels the run without a deadlock",
    async (_, started) => {
      const { threadId, botId, runId, taskId, childSessionId } = await started();
      let locked!: () => void;
      let release!: () => void;
      const holding = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stop = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        locked();
        await released;
        await cancelRunsInTransaction(tx, [{ id: runId, taskId }], new Date(), id);
      }, TRANSACTION);
      await holding;
      const startHelper = prisma.$transaction(async (tx) => {
        const call = await appendSessionEntryInTransaction(tx, {
          sessionId: childSessionId,
          botId,
          runId,
          type: "tool.call",
          payload: { callId: "call_0", name: "run_subagent", input: "{}" },
        });
        const helperSessionId = await createSessionInTransaction(tx, {
          kind: "subagent",
          id: SessionId.parse(randomUUID()),
          spaceId: id,
          parentSessionId: childSessionId,
          parentEntryId: call.id,
        });
        const task = await tx.task.create({
          data: { spaceId: id, botId, threadId, userId: id, prompt: "", status: "running" },
        });
        await tx.run.create({
          data: {
            spaceId: id,
            botId,
            threadId,
            taskId: task.id,
            userId: id,
            status: "running",
            trigger: "subagent",
            sessionId: helperSessionId,
            parentRunId: runId,
          },
        });
      }, TRANSACTION);
      await waitForLockWaiter();
      const probe = await prisma.$queryRaw`
      SELECT id FROM sessions WHERE id = ${childSessionId} FOR NO KEY UPDATE NOWAIT`.then(
        () => "free",
        (error: unknown) => String(error),
      );
      release();
      const outcomes = await Promise.allSettled([stop, startHelper]);

      expect({
        probe,
        outcomes: outcomes.map((outcome) =>
          outcome.status === "fulfilled" ? "committed" : String(outcome.reason),
        ),
      }).toEqual({
        probe: "free",
        outcomes: ["committed", "RunHistoryWriteError: Run cannot write thread history"],
      });
      expect(
        (
          await prisma.sessionEntry.findMany({
            where: { sessionId: childSessionId },
            orderBy: { seq: "asc" },
            select: { type: true },
          })
        ).map(({ type }) => type),
      ).toEqual(["run.started", "run.finished"]);
    },
  );

  it("keeps a run that finished between a canceller's read and its cancel", async () => {
    const { threadId, runId, taskId } = await startedRun();
    const read = [{ id: runId, taskId }];
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      await tx.run.update({ where: { id: runId }, data: { status: "completed" } });
      await appendRunFinishedInTransaction(tx, runId, { status: "completed" });
    });

    await prisma.$transaction((tx) => cancelRunsInTransaction(tx, read, new Date(), id));

    expect(
      await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { status: true } }),
    ).toEqual({ status: "completed" });
    expect(
      (
        await prisma.sessionEntry.findMany({
          where: { runId },
          orderBy: { seq: "asc" },
          select: { type: true, payload: true },
        })
      ).map(({ type, payload }) => [type, (payload as { status?: string }).status]),
    ).toEqual([
      ["run.started", undefined],
      ["run.finished", "completed"],
    ]);
  });

  it("keeps a cleared thread's cancelled run.finished and its clear in the feed", async () => {
    const { threadId, botId } = await startedRun();

    await clearThread(prisma, { spaceId: id, threadId, botId, userId: id });

    const feed = await prisma.event.findMany({
      where: { threadId },
      orderBy: { seq: "asc" },
      select: { type: true, payload: true },
    });
    expect(
      feed.map(({ type, payload }) => [
        type,
        ...((payload as { entries?: SessionEntry[] }).entries ?? []).map((entry) =>
          entry.type === "run.finished" ? `${entry.type} ${entry.payload.status}` : entry.type,
        ),
      ]),
    ).toEqual([["session.entry.appended", "run.finished cancelled", "clear"], ["thread.cleared"]]);
  });

  it("releases a computer behind its bot's thread lock, holding nothing a stop needs first", async () => {
    const { sessionId, threadId, botId, runId } = await startedRun();
    await prisma.run.update({ where: { id: runId }, data: { status: "waiting_takeover" } });
    await prisma.$transaction((tx) =>
      appendComputerControlInTransaction(tx, { sessionId, botId, holder: "user" }),
    );
    const computer = await prisma.computer.create({
      data: {
        spaceId: id,
        userId: id,
        scopeKey: `release-${runId}`,
        homeKey: `release-${runId}`,
        kind: "sandbox",
        controlHolder: "user",
        controlBotId: botId,
        controlLeaseId: "lease-1",
        controlRunId: runId,
      },
    });
    let locked!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopLike = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      locked();
      await released;
    }, TRANSACTION);
    await holding;
    const finalized = finalizeComputerControlRelease(prisma, {
      spaceId: id,
      computerId: computer.id,
      botId,
      runId,
      leaseId: "lease-1",
      holder: "bot",
      reason: "done",
    });
    await waitForLockWaiter();
    const probe = (query: Promise<unknown>) =>
      query.then(
        () => "free",
        (error: unknown) => String(error),
      );
    const probes = [
      await probe(
        prisma.$queryRaw`SELECT id FROM computers WHERE id = ${computer.id} FOR UPDATE NOWAIT`,
      ),
      await probe(
        prisma.$queryRaw`SELECT id FROM runs WHERE id = ${runId} FOR NO KEY UPDATE NOWAIT`,
      ),
    ];
    release();
    await stopLike;

    expect(probes).toEqual(["free", "free"]);
    expect(await finalized).toEqual({ runId });
    expect(
      await prisma.sessionEntry.findMany({
        where: { sessionId, type: "computer.control" },
        orderBy: { seq: "asc" },
        select: { payload: true },
      }),
    ).toEqual([{ payload: { holder: "user" } }, { payload: { holder: "bot" } }]);
  });

  it("gives two concurrent appends on one session distinct seqs on one chain", async () => {
    const sessionId = await freshSession();

    const [first, second] = await contend(said(sessionId, "first"), said(sessionId, "second"));

    expect([first.seq, first.parentId, second.seq, second.parentId]).toEqual([
      0,
      null,
      1,
      first.id,
    ]);
  });
});
