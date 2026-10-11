import type { SessionEntryDraft } from "@rakazo/adapter-kit";
import type { SessionEntry } from "@rakazo/contracts";
import { SessionId } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import { appendSessionEntryInTransaction } from "./sessions.js";

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
