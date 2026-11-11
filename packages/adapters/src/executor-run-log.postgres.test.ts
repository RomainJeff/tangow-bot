import type { SessionId } from "@tangow/contracts";
import type { PrismaClient } from "@tangow/db";
import { createDb } from "@tangow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRunLog } from "./executor.js";
import { PostgresSessionLog } from "./session-log/postgres.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
const TRANSACTION = { timeout: 20_000 };

describePostgres("openRunLog under contention (PostgreSQL)", () => {
  const id = `run-log-${process.pid}-${Date.now()}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!, { poolMax: 4 });
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({ data: { id, name: "Run log", email: `${id}@tangow.test` } });
    await prisma.organization.create({
      data: { id, name: "Run log", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "General" } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { id } });
    await close();
  });

  async function waitForLockWaiters(count: number): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (row!.waiting >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Fewer than ${count} opens waited for the thread`);
  }

  it("opens a routine run's own session once when two workers on a stale lease open its log together", async () => {
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Ada", color: "#00C46A" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const routine = await prisma.routine.create({
      data: {
        spaceId: id,
        botId: bot.id,
        userId: id,
        threadId: thread.id,
        name: "Digest",
        prompt: "Sum up.",
        crons: [],
      },
    });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        botId: bot.id,
        threadId: thread.id,
        userId: id,
        prompt: "Sum up.",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: id,
        status: "running",
        trigger: "routine",
        routineId: routine.id,
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
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
      locked();
      await released;
    }, TRANSACTION);
    await holding;
    const deps = { prisma, sessionLog: new PostgresSessionLog(prisma) };
    const open = () =>
      openRunLog(
        deps,
        run,
        { sessionId: run.sessionId as SessionId, runId: run.id, botId: bot.id },
        { provider: "p", id: "m" },
        null,
      );
    const opens = Promise.all([open(), open()]);
    await waitForLockWaiters(2);
    release();
    const [first, second] = await opens;
    await holder;

    const routineSessions = await prisma.conversationSession.findMany({
      where: { parentSessionId: thread.sessionId, kind: "routine" },
      select: { id: true },
    });
    const logged = await prisma.sessionEntry.findMany({
      where: { runId: run.id },
      orderBy: { createdAt: "asc" },
      select: { type: true, sessionId: true },
    });
    expect(routineSessions).toHaveLength(1);
    const [{ id: routineSessionId }] = routineSessions as [{ id: string }];
    expect({ opened: [first.sessionId, second.sessionId], logged }).toEqual({
      opened: [routineSessionId, routineSessionId],
      logged: [
        { type: "routine.started", sessionId: thread.sessionId },
        { type: "run.started", sessionId: routineSessionId },
      ],
    });
  });
});
