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

  async function startedRun() {
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
    await prisma.$transaction((tx) =>
      appendSessionEntryInTransaction(tx, {
        sessionId,
        botId: botId!,
        runId: run.id,
        type: "run.started",
        payload: { trigger: { kind: "direct" }, model: { provider: "p", id: "m" }, effort: null },
      }),
    );
    return { sessionId, threadId, botId: botId!, runId: run.id, taskId: task.id };
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

  it("keeps one entry for two concurrent deliveries of one clientNonce to a helper's session", async () => {
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
      type: "user.message",
      payload: { blocks: [{ kind: "text", text: "once" }], source: "app", clientNonce: "helper-1" },
    };

    const [first, second] = await contend(delivery, delivery);

    expect(second).toEqual(first);
    expect(
      await prisma.sessionEntry.findMany({ where: { sessionId }, select: { id: true, seq: true } }),
    ).toEqual([{ id: first.id, seq: 0 }]);
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
