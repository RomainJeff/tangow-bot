import type { BotMessageIntent } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { appendSessionEntryInTransaction } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messageBot, resolveRunHop, returnBotMessageOutcome } from "./bot-messages.js";
import type { ExecutorDeps } from "./executor.js";

vi.mock("../../db/src/sessions.js", async () =>
  (await import("@rakazo/db/sessions.test-support")).stubbedDbSessions(),
);

beforeEach(() => {
  vi.clearAllMocks();
});

const run = {
  id: "run-1",
  spaceId: "workspace-1",
  threadId: "thread-sender",
  botId: "bot-sender",
  userId: "user-1",
  sourceMessageId: null as string | null,
};
const sender = { id: "bot-sender", name: "Researcher" };

/** The delivery that woke the sending run, as the sender's session holds it. */
type Woke = { from?: string; fromName?: string; hop?: number; intent?: BotMessageIntent };

function wokeRow(woke: Woke, extra: Record<string, unknown> = {}) {
  return {
    id: "message-source",
    sessionId: "session-sender",
    seq: 3,
    parentId: "entry-2",
    type: "bot.message.received",
    payload: {
      from: { kind: "bot", botId: woke.from ?? "bot-target", name: woke.fromName ?? "Analyst" },
      fromSessionId: "session-target",
      fromEntryId: "entry-request",
      text: "please look",
      intent: woke.intent ?? "request",
      hop: woke.hop ?? 1,
      exchangeId: "exchange-1",
      ...extra,
    },
    botId: null,
    runId: null,
    createdAt: new Date("2026-10-01T09:00:00.000Z"),
    requestId: null,
    requestRunId: null,
  };
}

function deps(
  options: {
    bots?: unknown[];
    woke?: Woke;
    /** The `inheritedHop` of the run's routine. */
    routineHop?: number | null;
    senderRunning?: boolean;
    alreadyDelivered?: boolean;
    targetArchived?: boolean;
    transactionConflictOnce?: boolean;
    /** The run already sent its requester a result. */
    resultSent?: boolean;
  } = {},
) {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(undefined);
  const woke = options.woke && wokeRow(options.woke);
  const sessionEntry = {
    findUnique: vi.fn(async () => woke ?? null),
    findFirst: vi.fn(async () => (options.resultSent ? { id: "entry-result" } : null)),
  };
  const tx = {
    $queryRaw: vi.fn(async (sql: TemplateStringsArray) => {
      const query = sql.join("?");
      if (query.includes("clientNonce")) {
        return options.alreadyDelivered ? [wokeRow({}, { clientNonce: "bot-message:call-1" })] : [];
      }
      return query.includes("LATERAL") ? [] : [{ id: "thread" }];
    }),
    sessionEntry,
    run: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          options.senderRunning === false
            ? null
            : { id: "run-1", sessionId: "session-sender", status: "running" },
        ),
      create: vi.fn().mockResolvedValue({ id: "run-2" }),
    },
    bot: {
      findFirst: vi.fn().mockResolvedValue(options.targetArchived ? null : { id: "bot-target" }),
    },
    task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
    chatGroupPerson: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    thread: {
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ nextEventSeq: 8 }),
    },
  };
  let transactionAttempts = 0;
  const prisma = {
    sessionEntry,
    $queryRaw: vi.fn(async () => (woke ? [woke] : [])),
    bot: {
      findMany: vi.fn().mockResolvedValue(
        options.bots ?? [
          {
            id: "bot-target",
            name: "Analyst",
            title: "",
            thread: { id: "thread-target", sessionId: "session-target" },
          },
        ],
      ),
    },
    routine: {
      findUnique: vi.fn().mockResolvedValue({ inheritedHop: options.routineHop ?? null }),
    },
    run: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn(async (fn: (client: unknown) => unknown) => {
      transactionAttempts += 1;
      if (options.transactionConflictOnce && transactionAttempts === 1) {
        throw Object.assign(new Error("write conflict"), { code: "P2034" });
      }
      return fn(tx);
    }),
  } as unknown as PrismaClient;
  return {
    deps: { prisma, events: { notify }, jobs: { enqueue } } as unknown as Pick<
      ExecutorDeps,
      "prisma" | "events" | "jobs"
    >,
    tx,
    enqueue,
    notify,
  };
}

/** The entries one delivery wrote, by type. */
function delivered(type: "bot.message.sent" | "bot.message.received") {
  return vi
    .mocked(appendSessionEntryInTransaction)
    .mock.calls.map(([, draft]) => draft)
    .filter((draft) => draft.type === type);
}

describe("messaging another bot", () => {
  it("delivers into the target's own chat and wakes it", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "  chart the q3 numbers  ",
    });

    expect(sent).toMatchObject({ ok: true, botId: "bot-target", name: "Analyst" });
    expect(harness.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-target",
          threadId: "thread-target",
          prompt: expect.stringMatching(/not the user typing[\s\S]*untrusted peer content/),
        }),
      }),
    );
    const [received] = delivered("bot.message.received");
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-target",
          threadId: "thread-target",
          status: "queued",
          trigger: "bot_message",
          sourceMessageId: received?.id,
        }),
      }),
    );
    expect(delivered("bot.message.sent")).toEqual([
      expect.objectContaining({
        sessionId: "session-sender",
        runId: "run-1",
        payload: expect.objectContaining({ text: "chart the q3 numbers", intent: "request" }),
      }),
    ]);
    expect(received).toMatchObject({
      sessionId: "session-target",
      payload: { from: { kind: "bot", botId: "bot-sender", name: "Researcher" }, hop: 1 },
    });
    expect(harness.notify).toHaveBeenCalledWith("thread-target", 7);
    expect(harness.notify).toHaveBeenCalledWith("thread-sender", 7);
    expect(harness.tx.thread.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["thread-sender", "thread-target"] }, groupId: null },
      data: { unread: true },
    });
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  it("tells the sender to continue independent work", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "ping",
    });
    expect(sent.ok && sent.note).toContain("async");
    expect(sent.ok && sent.note).toContain("Continue independent work");
  });

  it("refuses a bot messaging itself", async () => {
    const harness = deps({
      bots: [{ id: "bot-sender", name: "Researcher", title: "", thread: { id: "thread-sender" } }],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-sender",
      message: "hello",
    });
    expect(sent).toEqual({ ok: false, error: "a bot cannot message itself" });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("refuses an unknown target without starting a run", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-missing",
      message: "hello",
    });
    expect(sent).toEqual({ ok: false, error: "no bot found with that id or name" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("refuses an empty message", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "   ",
    });
    expect(sent).toEqual({ ok: false, error: "message is required" });
  });

  it("rejects an oversized message instead of silently truncating it", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "x".repeat(8_001),
    });
    expect(sent).toEqual({ ok: false, error: "message exceeds the 8000 character limit" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("does not deliver once the sending run is no longer active", async () => {
    const harness = deps({ senderRunning: false });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "hello",
    });
    expect(sent).toMatchObject({ ok: false });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("stops a chain that has volleyed too many times", async () => {
    const harness = deps({ woke: { from: "b", fromName: "B", hop: 6 } });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "again" },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("allows a final result back through after the request hop limit", async () => {
    const harness = deps({ woke: { hop: 6, intent: "request" } });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "finished", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(sent.ok).toBe(true);
    // The result belongs to the exchange the request opened.
    expect(delivered("bot.message.received")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ intent: "result", exchangeId: "exchange-1" }),
      }),
    ]);
  });

  it("does not exempt a terminal reply to another terminal reply", async () => {
    const harness = deps({ woke: { hop: 6, intent: "result" } });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "acknowledged", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("does not let a result label bypass the hop limit toward an unrelated bot", async () => {
    const harness = deps({
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-other", name: "Writer", title: "", thread: { id: "thread-other" } },
      ],
      woke: { fromName: "Coordinator", hop: 6, intent: "request" },
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-other", message: "keep going", intent: "result" },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("keeps model-supplied status updates subject to the hop limit", async () => {
    const harness = deps({ woke: { fromName: "Coordinator", hop: 6, intent: "request" } });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "still working", intent: "status" },
    );
    expect(sent.ok).toBe(false);
  });

  it("keeps a person-started chain going", async () => {
    const harness = deps({ woke: { from: "b", fromName: "B", hop: 1 } });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "carry on" },
    );
    expect(sent.ok).toBe(true);
  });
});

describe("run hop", () => {
  const received = (hop: number) => ({ type: "bot.message.received", payload: { hop } });
  const handoff = (hop: number) => ({ type: "handoff", payload: { hop } });
  function hopDb(source: unknown, routineHop: number | null = null) {
    return {
      sessionEntry: { findUnique: vi.fn().mockResolvedValue(source) },
      routine: { findUnique: vi.fn().mockResolvedValue({ inheritedHop: routineHop }) },
    } as unknown as PrismaClient;
  }

  it("treats a run a person started as the start of a chain", async () => {
    const prisma = hopDb(null);
    expect(await resolveRunHop(prisma, { sourceMessageId: null, routineId: null })).toBe(0);
    expect(await resolveRunHop(prisma, { trigger: "user" })).toBe(0);
    expect(prisma.sessionEntry.findUnique).not.toHaveBeenCalled();
    expect(prisma.routine.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["bot message alone", received(3), null, 3],
    ["handoff alone", handoff(4), null, 4],
    ["routine alone", null, 5, 5],
    ["handoff and routine, the deeper wins", handoff(4), 3, 4],
    ["message and routine, the deeper wins", received(3), 5, 5],
    ["routine shallower than the message", received(5), 2, 5],
    ["nothing on the message and no inherited hop", { type: "user.message", payload: {} }, null, 0],
  ])("takes the deepest hop: %s", async (_label, source, routineHop, expected) => {
    const prisma = hopDb(source, routineHop);
    expect(
      await resolveRunHop(prisma, {
        sourceMessageId: "message-1",
        routineId: "routine-1",
        trigger: "webhook",
      }),
    ).toBe(expected);
  });

  it("does not read the routine for a run without one", async () => {
    const prisma = hopDb(received(3), 5);
    expect(await resolveRunHop(prisma, { sourceMessageId: "message-1", routineId: null })).toBe(3);
    expect(prisma.routine.findUnique).not.toHaveBeenCalled();
  });

  it("counts a routine run whose routine is gone as the end of the chain", async () => {
    const prisma = hopDb(null);
    expect(await resolveRunHop(prisma, { trigger: "routine", routineId: null })).toBe(6);
    // A routine deleted during its own run: the run still carries the id, the row is gone.
    const gone = {
      sessionEntry: { findUnique: vi.fn().mockResolvedValue(null) },
      routine: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    for (const trigger of ["routine", "webhook"]) {
      expect(await resolveRunHop(gone, { trigger, routineId: "routine-gone" })).toBe(6);
    }
    // An inbound webhook for a bot with no routine never had one: its chain starts at 0.
    expect(await resolveRunHop(prisma, { trigger: "webhook", routineId: null })).toBe(0);
    // A caller that does not carry routineId (the job reconciler) is not mistaken for a deleted one.
    expect(await resolveRunHop(prisma, { trigger: "routine" })).toBe(0);
    expect(await resolveRunHop(prisma, { trigger: "bot_message", routineId: null })).toBe(0);
    expect(await resolveRunHop(prisma, { trigger: "spawn", routineId: null })).toBe(0);
  });

  it("sends a message from a run at the inherited hop one hop further", async () => {
    const harness = deps({ routineHop: 5 });
    const sent = await messageBot(
      harness.deps,
      { ...run, trigger: "routine", routineId: "routine-1" },
      sender,
      { bot_id: "bot-target", message: "carry on" },
    );
    expect(sent.ok).toBe(true);
    expect(delivered("bot.message.received")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ hop: 6 }) }),
    ]);
  });

  it("carries a routine created at hop 4 to hop 6, and refuses the message after that", async () => {
    // schedule_create at hop 4 stores 5, so the routine's run sends at hop 6.
    const first = deps({ routineHop: 5 });
    const sent = await messageBot(
      first.deps,
      { ...run, trigger: "routine", routineId: "routine-1" },
      sender,
      { bot_id: "bot-target", message: "a" },
    );
    expect(sent.ok).toBe(true);
    expect(delivered("bot.message.received")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ hop: 6 }) }),
    ]);
    // The recipient, woken at hop 6, cannot pass the chain on.
    const second = deps({ woke: { from: "b", fromName: "B", hop: 6 } });
    const refused = await messageBot(
      second.deps,
      { ...run, trigger: "bot_message", sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "b" },
    );
    expect(refused.ok).toBe(false);
    expect(second.tx.run.create).not.toHaveBeenCalled();
  });

  it("lets a webhook wake of a routine with an inherited hop continue the chain", async () => {
    const harness = deps({ routineHop: 5 });
    const webhookRun = { ...run, trigger: "webhook", routineId: "routine-1" };
    expect(await resolveRunHop(harness.deps.prisma, webhookRun)).toBe(5);
    const sent = await messageBot(harness.deps, webhookRun, sender, {
      bot_id: "bot-target",
      message: "carry on",
    });
    expect(sent.ok).toBe(true);
    expect(delivered("bot.message.received")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ hop: 6 }) }),
    ]);
  });

  it("refuses a message from a routine run whose routine was deleted", async () => {
    const harness = deps();
    const sent = await messageBot(
      harness.deps,
      { ...run, trigger: "routine", routineId: null },
      sender,
      { bot_id: "bot-target", message: "again" },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("starts a spawned bot's chain over: its first message goes out at hop 1", async () => {
    const harness = deps();
    const spawnRun = { ...run, trigger: "spawn", routineId: null, sourceMessageId: null };
    expect(await resolveRunHop(harness.deps.prisma, spawnRun)).toBe(0);
    const sent = await messageBot(harness.deps, spawnRun, sender, {
      bot_id: "bot-target",
      message: "hello from the new bot",
    });
    expect(sent.ok).toBe(true);
    expect(delivered("bot.message.received")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ hop: 1 }) }),
    ]);
  });
});

describe("hardening", () => {
  it("does not deliver twice when the tool call is re-executed", async () => {
    const harness = deps({ alreadyDelivered: true });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });

    expect(sent).toMatchObject({ ok: true, replayed: true, botId: "bot-target" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("stamps the delivery so a retry can recognise it", async () => {
    const harness = deps();
    await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });
    expect(delivered("bot.message.received")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ clientNonce: "bot-message:call-1" }),
      }),
    ]);
  });

  it("still delivers when the caller supplies no delivery key", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent.ok).toBe(true);
    expect(harness.tx.run.create).toHaveBeenCalled();
  });

  it("does not deliver to a bot archived while the message was being sent", async () => {
    const harness = deps({ targetArchived: true });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent).toMatchObject({ ok: false });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("retries a serialization conflict without dropping the delivery", async () => {
    const harness = deps({ transactionConflictOnce: true });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent.ok).toBe(true);
    expect(harness.deps.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });
});

describe("automatic outcome return", () => {
  const delegated = { fromName: "Coordinator", hop: 1, intent: "request" as const };

  it("routes a delegated run's final text back to its coordinator", async () => {
    const harness = deps({ woke: delegated });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );
    expect(returned).toBe(true);
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "bot_message" }) }),
    );
    expect(harness.tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ["completed", "failed"] } }),
      }),
    );
    expect(harness.enqueue).toHaveBeenCalledOnce();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: run.id,
        status: { in: ["completed", "failed"] },
        botOutcomeReturnedAt: null,
      },
      data: { botOutcomeReturnedAt: expect.any(Date) },
    });
  });

  it("returns a final result when the run sent no result before, a status update included", async () => {
    const harness = deps({ woke: delegated });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    // Only a result already sent to the requester counts: a status update does not.
    expect(harness.deps.prisma.sessionEntry.findFirst).toHaveBeenCalledWith({
      where: {
        runId: "run-1",
        type: "bot.message.sent",
        AND: [
          { payload: { path: ["intent"], equals: "result" } },
          { payload: { path: ["to", "botId"], equals: "bot-target" } },
        ],
      },
      select: { id: true },
    });
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });

  it("skips the automatic return when a result was already sent", async () => {
    const harness = deps({ woke: delegated, resultSent: true });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalled();
  });
});
