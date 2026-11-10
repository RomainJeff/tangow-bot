import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import { clearThread } from "./events.js";
import { markThreadsUnread } from "./groups.js";
import { createBotMessageInTransaction } from "./messages.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
const TRANSACTION = { timeout: 20_000 };

/**
 * A group thread is locked before its people's rows on every path, the order a send takes: the
 * reverse on one path deadlocks against a send or a finishing run.
 */
describePostgres("group thread lock order (PostgreSQL)", () => {
  const id = `group-locks-${process.pid}-${Date.now()}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!, { poolMax: 4 });
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({ data: { id, name: "Locks", email: `${id}@rakazo.test` } });
    await prisma.organization.create({
      data: { id, name: "Locks", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "General" } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { id } });
    await close();
  });

  async function groupThread() {
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Ada", color: "#00C46A" },
    });
    const group = await prisma.chatGroup.create({
      data: {
        spaceId: id,
        userId: id,
        name: "Team",
        members: { create: { botId: bot.id } },
        people: { create: { userId: id } },
      },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: id, userId: id, groupId: group.id },
    });
    return { threadId: thread.id, groupId: group.id, botId: bot.id };
  }

  async function waitForLockWaiter(): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (row!.waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("The operation never waited for the thread lock");
  }

  /** Runs `operation` while another transaction holds the thread, and reports the person row. */
  async function personRowWhileThreadHeld(
    threadId: string,
    groupId: string,
    operation: () => Promise<unknown>,
  ) {
    let locked!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      locked();
      await released;
    }, TRANSACTION);
    await holding;
    const operated = operation();
    await waitForLockWaiter();
    const probe = await prisma.$queryRaw`
      SELECT id FROM chat_group_people WHERE "groupId" = ${groupId} FOR UPDATE NOWAIT`.then(
      () => "free",
      (error: unknown) => String(error),
    );
    release();
    await Promise.all([holder, operated]);
    return probe;
  }

  it("clears a group behind its thread lock, holding no person row a send takes later", async () => {
    const { threadId, groupId, botId } = await groupThread();

    const probe = await personRowWhileThreadHeld(threadId, groupId, () =>
      clearThread(prisma, { spaceId: id, threadId, botId, groupId, userId: id }),
    );

    expect(probe).toBe("free");
  });

  it.each([
    [
      "a bot's message",
      (threadId: string, botId: string) =>
        prisma.$transaction(
          (tx) =>
            createBotMessageInTransaction(tx, {
              threadId,
              botId,
              blocks: [{ kind: "text", text: "hi" }],
            }),
          TRANSACTION,
        ),
    ],
    [
      "a bot's activity",
      (threadId: string) =>
        prisma.$transaction((tx) => markThreadsUnread(tx, [threadId]), TRANSACTION),
    ],
  ])("marks a group unread for %s behind its thread lock", async (_, operation) => {
    const { threadId, groupId, botId } = await groupThread();

    const probe = await personRowWhileThreadHeld(threadId, groupId, () =>
      operation(threadId, botId),
    );

    expect(probe).toBe("free");
  });
});
