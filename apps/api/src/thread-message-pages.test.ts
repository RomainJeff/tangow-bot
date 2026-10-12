import type { ProductEvent, SessionEntry } from "@rakazo/contracts";
import { EntryId, SessionEntrySchema, SessionId } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { forwardedThreadEvent, isPeerRun, loadEntryPage } from "./thread-message-pages.js";

const SESSION = SessionId.parse("session-main");
const thread = { threadId: "thread-1", sessionId: SESSION };

function entry(seq: number, type: string, payload: object, envelope: object = {}): SessionEntry {
  return SessionEntrySchema.parse({
    id: `entry-${seq}`,
    sessionId: SESSION,
    seq,
    parentId: seq === 0 ? null : `entry-${seq - 1}`,
    ts: new Date(Date.UTC(2026, 9, 11, 9, 0, seq)).toISOString(),
    type,
    payload,
    ...envelope,
  });
}

const said = (seq: number, text: string) =>
  entry(seq, "user.message", { blocks: [{ kind: "text", text }], source: "app" });
const peer = { botId: "bot-scout", runId: "run-peer" };
const peerStep = (seq: number) =>
  entry(seq, "tool.call", { callId: `call-${seq}`, name: "search", input: "{}" }, peer);
const peerAsk = (seq: number) =>
  entry(seq, "assistant.ask", { block: { kind: "ask", text: "Which market?" } }, peer);

function threadDb() {
  return {
    run: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.includes("run-peer")
          ? [{ id: "run-peer", bot: { parentBotId: "bot-chief" }, sourceMessageId: null }]
          : [],
      ),
    },
  } as unknown as PrismaClient;
}

function pagedLog(chain: SessionEntry[], around: SessionEntry[] = []) {
  return {
    readPage: vi.fn(async (_sessionId: SessionId, page: { before?: EntryId; limit: number }) => {
      const end = page.before ? chain.findIndex((held) => held.id === page.before) : chain.length;
      return chain.slice(Math.max(0, end - page.limit), end);
    }),
    readAround: vi.fn(async () => around),
  };
}

const ids = (entries: readonly SessionEntry[]) => entries.map((held) => held.id);

describe("thread entry pages", () => {
  it("pages the chain back from an entry, the cursor on the oldest until the chain starts", async () => {
    const chain = Array.from({ length: 250 }, (_, seq) => said(seq, `m${seq}`));
    const deps = { prisma: threadDb(), sessionLog: pagedLog(chain) };

    const tail = await loadEntryPage(deps, thread, {});
    const older = await loadEntryPage(deps, thread, { before: tail.olderCursor! });

    expect([tail.entries.length, tail.olderCursor]).toEqual([200, "entry-50"]);
    expect(tail.entries[0]).toEqual({
      id: "entry-50",
      seq: 50,
      parentId: "entry-49",
      ts: "2026-10-11T09:00:50.000Z",
      type: "user.message",
      payload: { blocks: [{ kind: "text", text: "m50" }], source: "app" },
    });
    expect([older.entries.length, older.entries[0]?.id, older.olderCursor]).toEqual([
      50,
      "entry-0",
      null,
    ]);
  });

  it("leaves a hidden peer run's steps out of a page and keeps its question", async () => {
    const chain = [said(0, "Ask Scout"), peerStep(1), peerAsk(2), said(3, "Thanks")];
    const deps = { prisma: threadDb(), sessionLog: pagedLog(chain) };

    const page = await loadEntryPage(deps, thread, {});
    const overlay = await loadEntryPage(deps, thread, { includePeerRuns: true });

    expect(ids(page.entries)).toEqual(["entry-0", "entry-2", "entry-3"]);
    expect(ids(overlay.entries)).toEqual(["entry-0", "entry-1", "entry-2", "entry-3"]);
  });

  it("jumps around an entry, and to the tail when the chain no longer holds it", async () => {
    const chain = [said(0, "a"), said(1, "b"), said(2, "c")];
    const held = { prisma: threadDb(), sessionLog: pagedLog(chain, chain.slice(0, 2)) };
    const rewound = { prisma: threadDb(), sessionLog: pagedLog(chain, []) };
    const around = { entryId: EntryId.parse("entry-1") };

    const jump = await loadEntryPage(held, thread, { around });
    const fallback = await loadEntryPage(rewound, thread, {
      around,
      before: EntryId.parse("entry-2"),
    });

    expect(held.sessionLog.readAround).toHaveBeenCalledWith(SESSION, "entry-1", 200, held.prisma);
    expect(ids(jump.entries)).toEqual(["entry-0", "entry-1"]);
    expect(ids(fallback.entries)).toEqual(["entry-0", "entry-1", "entry-2"]);
  });
});

describe("thread feed forwarding", () => {
  const appended = (entries: SessionEntry[]): ProductEvent => ({
    id: "event-1",
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-chief",
    seq: 7,
    type: "session.entry.appended",
    runId: entries[0]?.runId,
    createdAt: "2026-10-11T09:00:00.000Z",
    payload: { entries },
  });

  it("forwards an append without a hidden peer run's steps, and drops one with nothing else", async () => {
    const peerRuns = new Map<string, Promise<boolean>>();
    const prisma = threadDb();

    const mixed = await forwardedThreadEvent(
      prisma,
      appended([said(0, "Ask Scout"), peerStep(1), peerAsk(2)]),
      peerRuns,
    );
    const stepsOnly = await forwardedThreadEvent(prisma, appended([peerStep(3)]), peerRuns);

    expect(ids((mixed?.payload.entries ?? []) as SessionEntry[])).toEqual(["entry-0", "entry-2"]);
    expect(stepsOnly).toBeNull();
  });

  it("keeps the other rules for a hidden peer run's events", async () => {
    const peerRuns = new Map<string, Promise<boolean>>();
    const prisma = threadDb();
    const event = (type: ProductEvent["type"], runId: string): ProductEvent => ({
      ...appended([]),
      type,
      runId,
      payload: {},
    });

    const forwarded = await Promise.all([
      forwardedThreadEvent(prisma, event("run.started", "run-peer"), peerRuns),
      forwardedThreadEvent(prisma, event("run.completed", "run-peer"), peerRuns),
      forwardedThreadEvent(prisma, event("thread.progress", "run-peer"), peerRuns),
      forwardedThreadEvent(prisma, event("effect.edited", "run-peer"), peerRuns),
      forwardedThreadEvent(prisma, event("thread.progress", "run-own"), peerRuns),
    ]);

    expect(forwarded.map((kept) => kept && `${kept.type}:${kept.runId}`)).toEqual([
      "run.started:run-peer",
      "run.completed:run-peer",
      null,
      null,
      "thread.progress:run-own",
    ]);
  });

  it("caches peer-run classification for live events", async () => {
    const findMany = vi.fn(async () => [
      { id: "run-peer", bot: { parentBotId: "claudius-1" }, sourceMessageId: null },
    ]);
    const prisma = { run: { findMany } } as unknown as PrismaClient;
    const cache = new Map<string, Promise<boolean>>();

    await expect(isPeerRun(prisma, "run-peer", cache)).resolves.toBe(true);
    await expect(isPeerRun(prisma, "run-peer", cache)).resolves.toBe(true);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  /** A top-level bot's run woken by a peer's message, and the row its context reads. */
  function wokenBy(intent: string, text: string) {
    const findMany = vi.fn(async () => [
      { id: "run-woken", bot: { parentBotId: null }, sourceMessageId: "entry-received" },
    ]);
    const $queryRaw = vi.fn(async () => [
      {
        id: "entry-received",
        sessionId: "session-main",
        seq: 4,
        parentId: "entry-3",
        type: "bot.message.received",
        payload: {
          from: { kind: "bot", botId: "warren", name: "Warren" },
          fromSessionId: "session-warren",
          fromEntryId: "entry-sent",
          text,
          intent,
          hop: 1,
          exchangeId: "entry-sent",
        },
        botId: "bot-chief",
        runId: null,
        createdAt: new Date("2026-10-11T09:00:00.000Z"),
        requestId: null,
        requestRunId: null,
      },
    ]);
    return { run: { findMany }, $queryRaw } as unknown as PrismaClient;
  }

  it("does not treat a top-level bot's relay of delegated work as a peer run (CA5/CA6)", async () => {
    // background-work-visibility: a top-level bot (no parent) has no orchestrator above it, so
    // the run where it carries a peer's `result` back IS its user-facing relay.
    const prisma = wokenBy("result", "Done.");
    await expect(isPeerRun(prisma, "run-woken", new Map())).resolves.toBe(false);
  });

  it("hides a top-level bot's run answering a peer's own request", async () => {
    // The turn's output is returned to the peer that asked; it is not addressed to the user, so
    // it stays out of their thread and out of the live event stream.
    const prisma = wokenBy("request", "Peux-tu me donner le contexte ?");
    await expect(isPeerRun(prisma, "run-woken", new Map())).resolves.toBe(true);
  });
});
