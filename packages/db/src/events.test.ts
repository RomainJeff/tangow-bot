import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { ProductEventSchema } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  answerRunInput,
  appendEvent,
  claimSteering,
  clearThread,
  completedRunBlocks,
  conversationRunFilter,
  dismissProposalWithTextInTransaction,
  finalizeComputerControlRelease,
  finalizeRun,
  followThreadEvents,
  InvalidAnswerError,
  pauseRunForInput,
  pauseRunForTakeover,
  resumeAskWithComposerTextInTransaction,
  rewindThread,
  sendUserMessage,
  startInboundRoutineRuns,
} from "./events.js";
import {
  appendCardStateInTransaction,
  appendRewindInTransaction,
  appendRunBlocksInTransaction,
  appendSessionEntryInTransaction,
  RunHistoryWriteError,
} from "./sessions.js";

vi.mock("./sessions.js", async () =>
  (await import("./sessions.test-support.js")).stubbedDbSessions(),
);

beforeEach(() => {
  vi.resetAllMocks();
});

/** The card state an answer appended, by the ask it targets. */
function answeredCard(target: string, answer: Record<string, unknown> = {}) {
  return expect.objectContaining({ type: "card.answered", payload: { target, ...answer } });
}

class TestFanout implements RealtimeFanout {
  subscriber: ((payload: string) => void) | undefined;
  unsubscribed = false;

  describe() {
    return {
      id: "test",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { distributed: false, push: true },
    };
  }

  async publish(_topic: string, payload: string) {
    this.subscriber?.(payload);
  }

  async subscribe(_topic: string, subscriber: (payload: string) => void) {
    this.subscriber = subscriber;
    return async () => {
      this.unsubscribed = true;
      this.subscriber = undefined;
    };
  }

  async close() {}
}

/** The run's pending card, as the entry `latestRunAsk` reads: an approval asks about its effect. */
function askEntry(id: string, block: Record<string, unknown>) {
  const approval = typeof block.approvalEffectId === "string";
  return {
    id,
    sessionId: "session-1",
    seq: 3,
    parentId: "entry-2",
    type: approval ? "effect.requested" : "assistant.ask",
    payload: approval
      ? { effectId: block.approvalEffectId, effectKind: "approval", proposal: {}, card: block }
      : { block },
    botId: "bot-1",
    runId: "run-1",
    createdAt: new Date("2026-08-15T12:00:00.000Z"),
  };
}

function event(seq: number) {
  return {
    id: `event-${seq}`,
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq,
    type: "run.started",
    payload: {},
    runId: null,
    createdAt: new Date("2026-08-15T12:00:00.000Z"),
  };
}

describe("finalizeRun", () => {
  it("stamps the final steps block with wall-clock run duration", () => {
    const blocks = [
      { kind: "steps" as const, steps: [{ label: "Read file", count: 1 }] },
      { kind: "text" as const, text: "Then I checked it." },
      { kind: "steps" as const, steps: [{ label: "Run tests", count: 1 }] },
    ];

    expect(
      completedRunBlocks(
        blocks,
        new Date("2026-09-01T12:00:00.000Z"),
        new Date("2026-09-01T12:01:43.000Z"),
      ),
    ).toEqual([blocks[0], blocks[1], { ...blocks[2], durationMs: 103_000 }]);
    expect(completedRunBlocks(blocks, null, new Date())).toBe(blocks);
  });

  it("retries a transaction conflict without duplicating the terminal event or notification", async () => {
    const conflict = Object.assign(new Error("serialization conflict"), { code: "P2034" });
    const createEvent = vi.fn(async () => ({ threadId: "thread-1", seq: 0 }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: {
        findUnique: vi.fn(async () => ({ status: "running" })),
        findUniqueOrThrow: vi.fn(async () => ({ sourceMessage: null })),
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
      task: { updateMany: vi.fn(async () => ({ count: 1 })) },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      event: { create: createEvent, deleteMany: vi.fn(async () => ({ count: 0 })) },
      steeringMessage: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      bot: { update: vi.fn(async () => ({})) },
    };
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockImplementation(async (operation: (client: typeof tx) => unknown) => operation(tx));
    const publish = vi.fn(async () => undefined);

    await expect(
      finalizeRun(
        { $transaction: transaction } as unknown as PrismaClient,
        {
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          runId: "run-1",
          taskId: "task-1",
          attemptId: "attempt-1",
          leaseOwner: "worker-1",
          leaseFence: 1,
          outcome: "failed",
          error: "failed",
        },
        { publish } as never,
      ),
    ).resolves.toEqual({ continuationRunId: null });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(createEvent).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
  });
});

describe("followThreadEvents", () => {
  it("does not lose a notification that arrives while querying", async () => {
    const fanout = new TestFanout();
    const findMany = vi
      .fn()
      .mockImplementationOnce(async () => {
        await fanout.publish("thread:thread-1", "wake");
        return [];
      })
      .mockResolvedValueOnce([event(0)])
      .mockResolvedValue([]);
    const prisma = { event: { findMany } } as unknown as PrismaClient;
    const abort = new AbortController();
    const stream = followThreadEvents(prisma, "thread-1", -1, fanout, abort.signal, 10_000);

    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 0 }, done: false });
    expect(findMany).toHaveBeenCalledTimes(2);
    abort.abort();
    await stream.return(undefined);
    expect(fanout.unsubscribed).toBe(true);
  });

  it("periodically catches up when a signal is missed", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([event(0)]);
    const prisma = { event: { findMany } } as unknown as PrismaClient;
    const abort = new AbortController();
    const stream = followThreadEvents(prisma, "thread-1", -1, undefined, abort.signal, 1);

    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 0 }, done: false });
    abort.abort();
    await stream.return(undefined);
  });
});

describe("finalizeComputerControlRelease", () => {
  it("clears the matching lease and appends its release event in one transaction", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1", sessionId: "session-1" }]),
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      run: {
        findUnique: vi.fn().mockResolvedValue({ status: "waiting_takeover" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      event: {
        create: vi.fn().mockResolvedValue({
          ...event(7),
          type: "computer.takeover.released",
          payload: { holder: "none", leaseId: "lease-1", reason: "expired" },
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      finalizeComputerControlRelease(
        prisma,
        {
          spaceId: "workspace-1",
          computerId: "computer-1",
          botId: "bot-1",
          runId: "run-1",
          leaseId: "lease-1",
          holder: "none",
          reason: "expired",
        },
        fanout,
      ),
    ).resolves.toEqual({ runId: "run-1" });

    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: {
        id: "computer-1",
        spaceId: "workspace-1",
        controlBotId: "bot-1",
        controlLeaseId: "lease-1",
        controlRunId: "run-1",
      },
      data: {
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        spaceId: "workspace-1",
        botId: "bot-1",
        status: "waiting_takeover",
      },
      data: { status: "queued", checkpoint: "takeover-skipped" },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "computer.takeover.released",
          runId: "run-1",
          payload: { holder: "none", leaseId: "lease-1", reason: "expired" },
        }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 7 }));
  });

  it("stamps a takeover checkpoint on a steered running run without clearing its lease", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1", sessionId: "session-1" }]),
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      run: {
        findUnique: vi.fn().mockResolvedValue({ status: "running" }),
        updateMany: vi.fn().mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      event: {
        create: vi.fn().mockResolvedValue({
          ...event(7),
          type: "computer.takeover.released",
          payload: { holder: "bot", leaseId: "lease-1", reason: "released" },
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      finalizeComputerControlRelease(prisma, {
        spaceId: "workspace-1",
        computerId: "computer-1",
        botId: "bot-1",
        runId: "run-1",
        leaseId: "lease-1",
        holder: "bot",
        reason: "released",
      }),
    ).resolves.toEqual({ runId: "run-1" });

    expect(tx.run.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: "run-1",
        spaceId: "workspace-1",
        botId: "bot-1",
        status: "waiting_takeover",
      },
      data: { status: "queued", checkpoint: "takeover" },
    });
    expect(tx.run.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: "run-1",
        spaceId: "workspace-1",
        botId: "bot-1",
        status: { in: ["leased", "running"] },
      },
      data: { checkpoint: "takeover" },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "computer.takeover.released",
          runId: "run-1",
        }),
      }),
    );
  });

  it("clears the lease even if its controlling bot was deleted", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      finalizeComputerControlRelease(prisma, {
        spaceId: "workspace-1",
        computerId: "computer-1",
        botId: "deleted-bot",
        runId: null,
        leaseId: "lease-1",
        holder: "none",
        reason: "expired",
      }),
    ).resolves.toEqual({ runId: null });

    expect(tx.computer.updateMany).toHaveBeenCalledOnce();
  });
});

describe("pauseRunForInput", () => {
  it("stores the paused run, prompt, and status event in one transaction", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "running",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: {
        update: vi.fn().mockResolvedValue({ sessionId: "session-1", botId: "bot-1" }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ nextEventSeq: 9 }),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      pauseRunForInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          runId: "run-1",
          attemptId: "attempt-1",
          leaseOwner: "worker-1",
          leaseFence: 3,
          blocks: [{ kind: "ask", text: "Which city?" }],
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(appendRunBlocksInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ botId: "bot-1", runId: "run-1" }),
      [{ kind: "ask", text: "Which city?" }],
      expect.any(Function),
    );
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "running", leaseFence: 3 }),
        data: { status: "waiting_input", leaseOwner: null, leaseExpiresAt: null },
      }),
    );
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 8 }));
  });

  it("stores offered choice actions on the run checkpoint for resume", async () => {
    const fanout = new TestFanout();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "running",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: {
        update: vi.fn().mockResolvedValue({ sessionId: "session-1", botId: "bot-1" }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ nextEventSeq: 9 }),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      pauseRunForInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          runId: "run-1",
          attemptId: "attempt-1",
          leaseOwner: "worker-1",
          leaseFence: 3,
          blocks: [
            {
              kind: "ask",
              text: "Which token?",
              status: "pending",
              actions: [
                { id: "choice-1", label: "use [redacted]" },
                { id: "choice-2", label: "use plain" },
              ],
            },
          ],
          offeredActions: [
            { id: "choice-1", label: "use sk-live-choice-secret" },
            { id: "choice-2", label: "use plain" },
          ],
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: "waiting_input",
          leaseOwner: null,
          leaseExpiresAt: null,
          checkpoint: JSON.stringify({
            kind: "choice_ask_v1",
            actions: [
              { id: "choice-1", label: "use sk-live-choice-secret" },
              { id: "choice-2", label: "use plain" },
            ],
          }),
        },
      }),
    );
  });
});

describe("pauseRunForTakeover", () => {
  it("stores the paused run, attempt, computer takeover mark, and event in one transaction", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "waiting_takeover" }),
      },
      attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      computer: {
        findFirst: vi.fn().mockResolvedValue({
          controlHolder: "none",
          controlBotId: null,
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      pauseRunForTakeover(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          runId: "run-1",
          attemptId: "attempt-1",
          leaseOwner: "worker-1",
          leaseFence: 3,
          reason: "Sign in",
          computerId: "computer-1",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "running", leaseFence: 3 }),
        data: {
          status: "waiting_takeover",
          leaseOwner: null,
          leaseExpiresAt: null,
          checkpoint: null,
        },
      }),
    );
    expect(tx.attempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "waiting_takeover" }) }),
    );
    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", spaceId: "workspace-1" },
      data: {
        state: "running",
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: "run-1",
      },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "computer.takeover.requested",
          payload: {
            reason: "Sign in",
            takeoverRequested: true,
            retainedControl: false,
          },
        }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 7 }));
  });

  it("keeps an active user control lease and only binds controlRunId", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "waiting_takeover" }),
      },
      attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      computer: {
        findFirst: vi.fn().mockResolvedValue({
          controlHolder: "user",
          controlBotId: "bot-1",
          controlLeaseId: "lease-1",
          controlLeaseExpiresAt: expiresAt,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      pauseRunForTakeover(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        attemptId: "attempt-1",
        leaseOwner: "worker-1",
        leaseFence: 3,
        reason: "Sign in",
        computerId: "computer-1",
      }),
    ).resolves.toBe(true);

    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", spaceId: "workspace-1" },
      data: { state: "running", controlRunId: "run-1" },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({ retainedControl: true, takeoverRequested: true }),
        }),
      }),
    );
  });

  it("preserves another bot's active user lease without binding this run to it", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "computer-1" }]),
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "waiting_takeover" }),
      },
      attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      computer: {
        findFirst: vi.fn().mockResolvedValue({
          controlHolder: "user",
          controlBotId: "other-bot",
          controlLeaseId: "lease-other",
          controlLeaseExpiresAt: expiresAt,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      pauseRunForTakeover(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        attemptId: "attempt-1",
        leaseOwner: "worker-1",
        leaseFence: 3,
        reason: "Sign in",
        computerId: "computer-1",
      }),
    ).resolves.toBe(true);

    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", spaceId: "workspace-1" },
      data: { state: "running" },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({ retainedControl: false, takeoverRequested: true }),
        }),
      }),
    );
  });
});

describe("answerRunInput", () => {
  it("answers only the selected pending prompt and publishes its update", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    publish.mockRejectedValueOnce(new Error("realtime unavailable"));
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            text: "Which city?",
            status: "pending",
            actions: [
              { id: "choice-1", label: "Berlin" },
              { id: "choice-2", label: "Paris" },
            ],
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "queued",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "choice-2",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "waiting_input" }),
        data: { status: "queued", checkpoint: null },
      }),
    );
    expect(appendCardStateInTransaction).toHaveBeenCalledWith(
      tx,
      answeredCard("message-1", { answer: "choice-2" }),
    );
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: { prompt: expect.stringContaining("Selected choice choice-2: Paris") },
    });
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 9 }));
  });

  it("resumes with the offered choice label when the persisted label was redacted", async () => {
    const fanout = new TestFanout();
    const secret = "sk-live-choice-secret";
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            text: "Which token?",
            status: "pending",
            actions: [
              { id: "choice-1", label: `use [redacted]` },
              { id: "choice-2", label: "use plain" },
            ],
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({
          botId: "bot-2",
          userId: "user-1",
          checkpoint: JSON.stringify({
            kind: "choice_ask_v1",
            actions: [
              { id: "choice-1", label: `use ${secret}` },
              { id: "choice-2", label: "use plain" },
            ],
          }),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "queued",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ nextEventSeq: 11 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "choice-1",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: { prompt: expect.stringContaining(`Selected choice choice-1: use ${secret}`) },
    });
    expect(appendCardStateInTransaction).toHaveBeenCalledWith(
      tx,
      answeredCard("message-1", { answer: "choice-1" }),
    );
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "queued", checkpoint: null },
      }),
    );
  });

  it("accepts a free-text answer on a choice ask (none of the offered choices)", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            text: "Which city?",
            status: "pending",
            actions: [
              { id: "Berlin", label: "Berlin" },
              { id: "Seoul", label: "Seoul" },
            ],
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "queued",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ nextEventSeq: 11 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "Toronto",
      }),
    ).resolves.toBe(true);

    // The offered options are a convenience, not a constraint: a typed answer resumes the run
    // with the free-text prompt rather than being dropped.
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: {
        prompt: expect.stringContaining("Free-text answer (none of the offered choices): Toronto"),
      },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "queued", checkpoint: null },
      }),
    );
  });

  it("resumes a multi-question ask from one structured submission", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            text: "",
            status: "pending",
            questions: [
              {
                id: "q1",
                question: "Ta cible ?",
                options: [
                  { id: "q1o1", label: "DG PME" },
                  { id: "q1o2", label: "Direction BU" },
                ],
              },
              { id: "q2", question: "Ton horizon ?", required: false },
            ],
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "queued",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ nextEventSeq: 11 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: JSON.stringify({
          answers: { q1: { selected: ["q1o1"] }, q2: { other: "6 mois" } },
        }),
      }),
    ).resolves.toBe(true);

    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: {
        prompt: expect.stringContaining(
          "The user answered your questions:\n1. Ta cible ? — DG PME\n2. Ton horizon ? — Other: 6 mois",
        ),
      },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "queued", checkpoint: null } }),
    );
    expect(appendCardStateInTransaction).toHaveBeenCalledWith(
      tx,
      answeredCard("message-1", {
        answers: { q1: { selected: ["q1o1"] }, q2: { other: "6 mois" } },
      }),
    );
  });

  it("keeps one selected option on a single-choice question", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            text: "Ta cible ?",
            status: "pending",
            questions: [
              {
                id: "q1",
                question: "Ta cible ?",
                options: [
                  { id: "q1o1", label: "DG PME" },
                  { id: "q1o2", label: "Direction BU" },
                ],
              },
            ],
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "queued",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ nextEventSeq: 11 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: JSON.stringify({ answers: { q1: { selected: ["q1o1", "q1o2"] } } }),
      }),
    ).resolves.toBe(true);

    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: {
        prompt: expect.stringContaining(
          "The user answered your questions:\n1. Ta cible ? — DG PME",
        ),
      },
    });
    expect(appendCardStateInTransaction).toHaveBeenCalledWith(
      tx,
      answeredCard("message-1", { answers: { q1: { selected: ["q1o1"] } } }),
    );
  });

  it("rejects a multi-question submission that is not valid JSON", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            text: "",
            status: "pending",
            questions: [{ id: "q1", question: "Ta cible ?" }],
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
        updateMany: vi.fn(),
      },
      task: { updateMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "just some text",
      }),
    ).rejects.toThrow(InvalidAnswerError);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a multi-question submission that leaves a required question unanswered", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            text: "",
            status: "pending",
            questions: [
              { id: "q1", question: "Ta cible ?" },
              { id: "q2", question: "Ton horizon ?" },
            ],
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
        updateMany: vi.fn(),
      },
      task: { updateMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: JSON.stringify({ answers: { q1: { other: "DG" } } }),
      }),
    ).rejects.toThrow(InvalidAnswerError);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a client-asserted skip on a required question", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            text: "",
            status: "pending",
            questions: [{ id: "q1", question: "Ta cible ?" }],
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
        updateMany: vi.fn(),
      },
      task: { updateMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: JSON.stringify({ answers: { q1: { skipped: true } } }),
      }),
    ).rejects.toThrow(InvalidAnswerError);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });

  it("does not queue a run for an empty answer on a choice ask", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            text: "Which city?",
            status: "pending",
            actions: [
              { id: "Berlin", label: "Berlin" },
              { id: "Seoul", label: "Seoul" },
            ],
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
        updateMany: vi.fn(),
      },
      task: { updateMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "   ",
      }),
    ).rejects.toThrow(InvalidAnswerError);

    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });

  it("approves consequential actions without overwriting the task prompt", async () => {
    const fanout = new TestFanout();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            approvalEffectId: "effect-1",
            text: "Review before writing",
            status: "pending",
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      task: { updateMany: vi.fn() },
      externalEffect: {
        findFirst: vi.fn().mockResolvedValue({ id: "effect-1", status: "intended" }),
        update: vi.fn().mockResolvedValue({ id: "effect-1" }),
      },
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "allow",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.externalEffect.findFirst).toHaveBeenCalledWith({
      where: {
        id: "effect-1",
        spaceId: "workspace-1",
        runId: "run-1",
        status: "intended",
      },
    });
    expect(tx.externalEffect.update).toHaveBeenCalledWith({
      where: { id: "effect-1" },
      data: { status: "approved", answeredAt: expect.any(Date) },
    });
  });

  it("approves and upserts always-allow without overwriting the task prompt", async () => {
    const fanout = new TestFanout();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            approvalEffectId: "effect-1",
            text: "Review before writing",
            status: "pending",
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "always", label: "Always allow" },
              { id: "deny", label: "Deny" },
            ],
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ userId: "user-1", status: "queued" }),
      },
      task: { updateMany: vi.fn() },
      externalEffect: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "effect-1", status: "intended", kind: "destination.write" }),
        update: vi.fn().mockResolvedValue({ id: "effect-1" }),
      },
      actionApprovalRule: {
        upsert: vi.fn().mockResolvedValue({ id: "rule-1" }),
      },
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "always",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.externalEffect.update).toHaveBeenCalledWith({
      where: { id: "effect-1" },
      data: { status: "approved", answeredAt: expect.any(Date) },
    });
    expect(tx.actionApprovalRule.upsert).toHaveBeenCalledWith({
      where: {
        spaceId_createdByUserId_effect_matchKind_matchValue: {
          spaceId: "workspace-1",
          createdByUserId: "user-1",
          effect: "always_allow",
          matchKind: "tool",
          matchValue: "destination.write",
        },
      },
      create: {
        spaceId: "workspace-1",
        createdByUserId: "user-1",
        effect: "always_allow",
        matchKind: "tool",
        matchValue: "destination.write",
      },
      update: {},
    });
  });

  it("does not let another workspace member create an always-allow rule for the run owner", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            approvalEffectId: "effect-1",
            text: "Review before writing",
            status: "pending",
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "always", label: "Always allow" },
              { id: "deny", label: "Deny" },
            ],
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "run-owner" }),
        findUnique: vi.fn().mockResolvedValue({ userId: "run-owner" }),
        updateMany: vi.fn(),
      },
      externalEffect: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "effect-1", status: "intended", kind: "destination.write" }),
      },
      actionApprovalRule: { upsert: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "other-member",
        answer: "always",
      }),
    ).resolves.toBe(false);

    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.actionApprovalRule.upsert).not.toHaveBeenCalled();
  });

  it("does not queue a run when an approval card has no matching effect", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            approvalEffectId: "missing-effect",
            text: "Review before writing",
            status: "pending",
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        updateMany: vi.fn(),
      },
      externalEffect: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "allow",
      }),
    ).resolves.toBe(false);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("does not queue a run for an action that the approval card did not offer", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            approvalEffectId: "effect-1",
            text: "Review before writing",
            status: "pending",
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        updateMany: vi.fn(),
      },
      externalEffect: { findFirst: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "always",
      }),
    ).resolves.toBe(false);
    expect(tx.externalEffect.findFirst).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an answer to a card the run has moved past, without queuing it", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            askEntry("message-2", { kind: "ask", text: "Which city?", status: "pending" }),
          ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "Rome",
      }),
    ).resolves.toBe(false);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { name: "example_api", origin: "https://api.example.test", auth: { type: "bearer" } },
  ])("stores secret asks without writing plaintext to the task prompt (%j)", async (credential) => {
    const fanout = new TestFanout();
    const store = vi.fn().mockResolvedValue(undefined);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            text: "Enter your code",
            input: "secret",
            purpose: "api_key",
            ...(credential ? { credential } : {}),
            status: "pending",
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      task: { updateMany: vi.fn() },
      externalEffect: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "123456",
        },
        fanout,
        { store },
      ),
    ).resolves.toBe(true);

    expect(store).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        plaintext: "123456",
        botId: "bot-1",
        userId: "user-1",
        spaceId: "workspace-1",
        credential,
      }),
    );
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(JSON.stringify(tx.event.create.mock.calls)).not.toContain("123456");
    expect(JSON.stringify(vi.mocked(appendSessionEntryInTransaction).mock.calls)).not.toContain(
      "123456",
    );
    expect(tx.externalEffect.updateMany).toHaveBeenCalledWith({
      where: {
        runId: "run-1",
        spaceId: "workspace-1",
        kind: "request_secret",
        status: "intended",
      },
      data: {
        status: "approved",
        ...(credential ? { result: { credentialSaved: credential } } : {}),
      },
    });
    expect(appendCardStateInTransaction).toHaveBeenCalledWith(
      tx,
      answeredCard("message-1", { answer: "" }),
    );
  });

  it("does not let another workspace member save a credential as the run owner", async () => {
    const store = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "owner" }),
        updateMany: vi.fn(),
      },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            text: "API key",
            input: "secret",
            status: "pending",
            credential: {
              name: "example_api",
              origin: "https://api.example.test",
              auth: { type: "bearer" },
            },
          }),
        ),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    expect(
      await answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "other-member",
          answer: "fake-key",
        },
        new TestFanout(),
        { store },
      ),
    ).toBe(false);
    expect(store).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("rejects secret asks when no run secret writer is configured", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("message-1", {
            kind: "ask",
            text: "Enter your code",
            input: "secret",
            status: "pending",
          }),
        ),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "123456",
      }),
    ).resolves.toBe(false);

    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });
});

describe("resumeAskWithComposerTextInTransaction", () => {
  function baseTx(askBlock: Record<string, unknown>) {
    return {
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: new Date() }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      sessionEntry: { findFirst: vi.fn().mockResolvedValue(askEntry("ask-msg-1", askBlock)) },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ nextEventSeq: 5 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
  }

  it("resolves a mono-question ask_user with the composer text, queues the run, and answers the card", async () => {
    const tx = baseTx({
      kind: "ask",
      text: "What's the target city?",
      status: "pending",
      input: "text",
    });

    const result = await resumeAskWithComposerTextInTransaction(tx as never, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      text: "Lisbon, flexible dates",
    });

    expect(result).toEqual({ resolvable: true, runId: "run-1" });
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: { id: "run-1", spaceId: "workspace-1", threadId: "thread-1", status: "waiting_input" },
      data: { status: "queued", checkpoint: null },
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: { prompt: expect.stringContaining("Lisbon, flexible dates") },
    });
    // Never echo the reply onto the card (design D2 — the words live in the user's bubble) and
    // never fabricate a structured per-question map from free text.
    expect(appendCardStateInTransaction).toHaveBeenCalledWith(tx, answeredCard("ask-msg-1"));
  });

  it("resolves a multi-question ask_user from prose without JSON-parsing the answer", async () => {
    const tx = baseTx({
      kind: "ask",
      text: "",
      status: "pending",
      questions: [
        { id: "q1", question: "Where do you want to go?", required: true },
        { id: "q2", question: "What's your budget?", required: true },
        { id: "q3", question: "Any dietary constraints?", required: false },
      ],
    });

    const result = await resumeAskWithComposerTextInTransaction(tx as never, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      text: "Somewhere warm, budget doesn't matter much",
    });

    expect(result).toMatchObject({ resolvable: true });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "queued", checkpoint: null } }),
    );
    const prompt = tx.task.updateMany.mock.calls[0]![0].data.prompt as string;
    expect(prompt).toContain("Somewhere warm, budget doesn't matter much");
    expect(prompt).toContain("Where do you want to go?");
    expect(prompt).toContain("What's your budget?");
  });

  it("resolves a partial reply even when required questions in the batch stay uncovered", async () => {
    const tx = baseTx({
      kind: "ask",
      text: "",
      status: "pending",
      questions: [
        { id: "q1", question: "Which city?", required: true },
        { id: "q2", question: "Which dates?", required: true },
      ],
    });

    const result = await resumeAskWithComposerTextInTransaction(tx as never, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      text: "Let's do Lisbon",
    });

    // No coverage requirement: reconciliation (and any re-ask of the remainder) happens at the
    // next agent turn, not as a validation error here.
    expect(result).toMatchObject({ resolvable: true });
    expect(appendCardStateInTransaction).toHaveBeenCalled();
  });

  it("refuses a pending secret ask without writing a secret or resuming the run", async () => {
    const tx = baseTx({
      kind: "ask",
      text: "Enter your code",
      input: "secret",
      status: "pending",
    });

    const result = await resumeAskWithComposerTextInTransaction(tx as never, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      text: "123456",
    });

    expect(result).toEqual({ resolvable: false });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(appendCardStateInTransaction).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a pending approval ask without approving the effect or resuming the run", async () => {
    const tx = baseTx({
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Allow this?",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    });

    const result = await resumeAskWithComposerTextInTransaction(tx as never, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      text: "yes go ahead",
    });

    expect(result).toEqual({ resolvable: false });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(appendCardStateInTransaction).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect((tx as Record<string, unknown>).externalEffect).toBeUndefined();
  });

  it("never touches steeringMessage while resolving an ask_user", async () => {
    const tx = baseTx({
      kind: "ask",
      text: "Where next?",
      status: "pending",
      input: "text",
    });

    const result = await resumeAskWithComposerTextInTransaction(tx as never, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      text: "Kyoto",
    });

    expect(result).toMatchObject({ resolvable: true });
    expect((tx as Record<string, unknown>).steeringMessage).toBeUndefined();
  });

  it("is a clean no-op when a concurrent resolution already answered the run (atomic guard)", async () => {
    const tx = baseTx({
      kind: "ask",
      text: "Where next?",
      status: "pending",
      input: "text",
    });
    // The conditional updateMany is the final atomic gate: another resolution (e.g. a card
    // click) won the race and already flipped the run off waiting_input.
    tx.run.updateMany = vi.fn().mockResolvedValue({ count: 0 });

    const result = await resumeAskWithComposerTextInTransaction(tx as never, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      text: "Kyoto",
    });

    expect(result).toEqual({ resolvable: false });
    expect(appendCardStateInTransaction).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });

  it("does not resolve when the run is no longer waiting on input", async () => {
    const tx = baseTx({ kind: "ask", text: "Where next?", status: "pending", input: "text" });
    tx.run.findFirst = vi.fn().mockResolvedValue(null);

    const result = await resumeAskWithComposerTextInTransaction(tx as never, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      text: "Kyoto",
    });

    expect(result).toEqual({ resolvable: false });
    expect(tx.sessionEntry.findFirst).not.toHaveBeenCalled();
  });

  it("does not resolve an empty composer message (attachment-only send)", async () => {
    const tx = baseTx({ kind: "ask", text: "Where next?", status: "pending", input: "text" });

    const result = await resumeAskWithComposerTextInTransaction(tx as never, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      text: "   ",
    });

    expect(result).toEqual({ resolvable: false });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });
});

describe("sendUserMessage", () => {
  it("creates the message, run, and event in one transaction and publishes once", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      thread: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValueOnce({ sessionId: "session-1", botId: "bot-1" })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      run: {
        create: vi.fn().mockResolvedValue({ id: "run-1" }),
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
          runId: "run-1",
        })),
      },
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    vi.mocked(appendSessionEntryInTransaction).mockImplementationOnce(
      async (_tx, draft) => ({ ...draft, seq: 4 }) as never,
    );

    const sent = await sendUserMessage(
      prisma,
      {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text: "hello" }],
        prompt: "hello",
        trigger: "user",
        clientNonce: "nonce-1",
      },
      fanout,
    );
    expect(sent).toEqual({
      messageId: expect.any(String),
      seq: 4,
      taskId: "task-1",
      runId: "run-1",
    });

    expect(appendSessionEntryInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        id: sent.messageId,
        type: "user.message",
        sessionId: "session-1",
        payload: expect.objectContaining({ clientNonce: "nonce-1", source: "app" }),
      }),
    );
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trigger: "user",
          clientNonce: `send:${sent.messageId}`,
          sourceMessageId: sent.messageId,
        }),
      }),
    );
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 8 }));
  });

  it.each([
    ["follow_up", false],
    ["webhook", true],
    ["messaging", true],
  ] as const)("steers a busy run with a %s message, untrusted: %s", async (trigger, untrusted) => {
    const tx = {
      thread: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValueOnce({ sessionId: "session-1", botId: "bot-1" })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn() },
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "run-0", taskId: "task-0" }),
        findUnique: vi.fn().mockResolvedValue({ status: "running" }),
        create: vi.fn(),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    const sent = await sendUserMessage(prisma, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      blocks: [{ kind: "text", text: "hello" }],
      prompt: "hello",
      trigger,
    });
    expect(sent).toMatchObject({ taskId: null, runId: "run-0" });

    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    // Only conversation runs take steering; a routine card run's reply never reaches the thread.
    expect(tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(conversationRunFilter) }),
    );
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: sent.messageId,
        botId: "bot-1",
        userId: "user-1",
        runId: "run-0",
        untrusted,
      },
    });
  });
});

describe("startInboundRoutineRuns", () => {
  const input = {
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    userId: "user-1",
    runs: [
      {
        routineId: "routine-a",
        prompt: 'Run routine "Triage":\nOpen an issue',
        requireToolApproval: false,
        clientNonce: "webhook:bot-1:digest:routine-a",
      },
      {
        routineId: "routine-b",
        prompt: 'Run routine "Notify":\nPost a summary',
        requireToolApproval: true,
        clientNonce: "webhook:bot-1:digest:routine-b",
      },
    ],
  };

  it("queues every routine run in one transaction, without a user message", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    let eventSeq = 8;
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      thread: { update: vi.fn(async () => ({ nextEventSeq: ++eventSeq + 1 })) },
      task: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ id: "task-a" })
          .mockResolvedValueOnce({ id: "task-b" }),
      },
      run: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ id: "run-a" })
          .mockResolvedValueOnce({ id: "run-b" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      run: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(startInboundRoutineRuns(prisma, input, fanout)).resolves.toEqual({
      runIds: ["run-a", "run-b"],
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(appendSessionEntryInTransaction).not.toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ type: "user.message" }),
    );
    expect(tx.task.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ prompt: input.runs[0]!.prompt, status: "queued" }),
    });
    expect(tx.run.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        taskId: "task-a",
        trigger: "webhook",
        routineId: "routine-a",
        requireToolApproval: false,
        clientNonce: "webhook:bot-1:digest:routine-a",
      }),
    });
    expect(tx.run.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        taskId: "task-b",
        routineId: "routine-b",
        requireToolApproval: true,
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "routine.fired",
          runId: "run-b",
          payload: { routineId: "routine-b" },
        }),
      }),
    );
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 10 }));
  });

  it("returns the runs a redelivered nonce already started", async () => {
    const prisma = {
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-b", clientNonce: "webhook:bot-1:digest:routine-b" },
          { id: "run-a", clientNonce: "webhook:bot-1:digest:routine-a" },
        ]),
      },
      $transaction: vi.fn(),
    } as unknown as PrismaClient;

    await expect(startInboundRoutineRuns(prisma, input)).resolves.toEqual({
      runIds: ["run-a", "run-b"],
    });
    expect(prisma.run.findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "workspace-1",
        clientNonce: {
          in: ["webhook:bot-1:digest:routine-a", "webhook:bot-1:digest:routine-b"],
        },
      },
      select: { id: true, clientNonce: true },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("resolves a concurrent duplicate to the winning runs", async () => {
    const prisma = {
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { id: "run-won-a", clientNonce: "webhook:bot-1:digest:routine-a" },
            { id: "run-won-b", clientNonce: "webhook:bot-1:digest:routine-b" },
          ]),
      },
      $transaction: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" })),
    } as unknown as PrismaClient;

    await expect(startInboundRoutineRuns(prisma, input)).resolves.toEqual({
      runIds: ["run-won-a", "run-won-b"],
    });
  });
});

describe("claimSteering", () => {
  it("claims pending messages for the fenced run in message order", async () => {
    const tx = {
      $queryRaw: vi.fn(),
      run: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "run-1", trigger: "user", thread: { sessionId: "session-1" } }),
      },
      steeringMessage: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "steer-1",
            messageId: "message-1",
            message: {
              payload: {
                blocks: [
                  { kind: "text", text: "First" },
                  {
                    kind: "image",
                    artifactId: "artifact-1",
                    name: "chart.png",
                    mimeType: "image/png",
                  },
                ],
              },
            },
          },
          {
            id: "steer-2",
            messageId: "message-2",
            untrusted: true,
            message: { payload: { blocks: [{ kind: "text", text: "Second" }] } },
          },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      claimSteering(prisma, {
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        leaseOwner: "worker-1",
        leaseFence: 2,
        seenIds: [],
      }),
    ).resolves.toEqual([
      {
        id: "steer-1",
        messageId: "message-1",
        text: "First\n[image: chart.png]",
        blocks: [
          { kind: "text", text: "First" },
          {
            kind: "image",
            artifactId: "artifact-1",
            name: "chart.png",
            mimeType: "image/png",
          },
        ],
      },
      {
        id: "steer-2",
        messageId: "message-2",
        text: "Second",
        blocks: [{ kind: "text", text: "Second" }],
        untrusted: true,
      },
    ]);
    expect(tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ leaseOwner: "worker-1", leaseFence: 2 }),
      }),
    );
    expect(tx.steeringMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["steer-1", "steer-2"] }, claimedAt: null },
      data: { runId: "run-1", claimedAt: expect.any(Date) },
    });
  });
});

describe("a reply steered into a run put back in the queue", () => {
  it("reaches the run once it runs again, and no other run", async () => {
    const run = { id: "run-1", threadId: "thread-1", botId: "bot-1", status: "queued" };
    const steering = [
      // As sendThreadMessage writes it when a reply puts a proposal card away.
      {
        id: "steer-1",
        messageId: "message-1",
        botId: "bot-1",
        runId: "run-1",
        claimedAt: null as Date | null,
        message: { payload: { blocks: [{ kind: "text", text: "Tuesdays" }] } },
      },
    ];
    const tx = {
      $queryRaw: vi.fn(),
      run: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          where.id === run.id && where.status === run.status
            ? { id: run.id, trigger: "user", thread: { sessionId: "session-1" } }
            : null,
        ),
      },
      steeringMessage: {
        findMany: vi.fn(
          async ({ where }: { where: { botId: string; OR: { runId: string | null }[] } }) =>
            steering.filter(
              (item) =>
                item.botId === where.botId &&
                where.OR.some((option) => option.runId === item.runId),
            ),
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const claim = (runId: string) =>
      claimSteering(prisma, {
        threadId: "thread-1",
        botId: "bot-1",
        runId,
        leaseOwner: "worker-1",
        leaseFence: 1,
        seenIds: [],
      });

    await expect(claim("run-1")).resolves.toEqual([]);
    run.status = "running";
    await expect(claim("run-2")).resolves.toEqual([]);
    await expect(claim("run-1")).resolves.toEqual([
      {
        id: "steer-1",
        messageId: "message-1",
        text: "Tuesdays",
        blocks: [{ kind: "text", text: "Tuesdays" }],
      },
    ]);
  });
});

describe("clearThread", () => {
  it("releases the computer execution lease without dropping the computer", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ nextEventSeq: 1 }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]),
        updateMany: vi.fn(),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      computerExecutionLease: { updateMany: vi.fn() },
      computer: { updateMany: vi.fn() },
      sessionEntry: { findMany: vi.fn().mockResolvedValue([]) },
      event: { deleteMany: vi.fn() },
      bot: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      clearThread(prisma, { spaceId: "workspace-1", threadId: "thread-1", botId: "bot-1" }, fanout),
    ).resolves.toMatchObject({ cancelledRunIds: ["run-1"] });
    expect(appendSessionEntryInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ type: "clear", sessionId: "session-1" }),
    );
    expect(tx.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-1"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: { executionRunId: { in: ["run-1"] } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 0 }));
  });

  it("scopes group clear lease cleanup to cancelled run ids", async () => {
    const fanout = new TestFanout();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn().mockResolvedValue({ sessionId: "session-group" }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ nextEventSeq: 1 }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "group-run-1", taskId: "task-1" },
          { id: "group-run-2", taskId: "task-2" },
        ]),
        updateMany: vi.fn(),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      computerExecutionLease: { updateMany: vi.fn() },
      computer: { updateMany: vi.fn() },
      sessionEntry: { findMany: vi.fn().mockResolvedValue([]) },
      event: { deleteMany: vi.fn() },
      chatGroup: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      clearThread(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-group",
          botId: "bot-1",
          groupId: "group-1",
        },
        fanout,
      ),
    ).resolves.toMatchObject({ cancelledRunIds: ["group-run-1", "group-run-2"] });

    expect(tx.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "thread-group",
          spaceId: "workspace-1",
        }),
      }),
    );
    expect(tx.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["group-run-1", "group-run-2"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: { executionRunId: { in: ["group-run-1", "group-run-2"] } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    expect(tx.computerExecutionLease.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ botId: expect.anything() }) }),
    );
  });
});

describe("rewindThread", () => {
  function rewindTx(overrides: { target?: { seq: number; createdAt: Date } | null }) {
    const target =
      overrides.target === undefined ? { seq: 4, createdAt: new Date(0) } : overrides.target;
    return {
      $queryRaw: vi
        .fn()
        // The target message on the chain, then the event that carried it.
        .mockResolvedValueOnce(target ? [target] : [])
        .mockResolvedValue([{ seq: 11 }]),
      thread: {
        update: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ nextEventSeq: 21 }),
      },
      sessionEntry: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]),
        updateMany: vi.fn(),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      computerExecutionLease: { updateMany: vi.fn() },
      computer: { updateMany: vi.fn() },
      event: { deleteMany: vi.fn(), create: vi.fn() },
      bot: { update: vi.fn() },
    };
  }

  function rewindPrisma(tx: ReturnType<typeof rewindTx>) {
    return {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
  }

  const input = {
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    messageId: "message-4",
  };

  it("cuts the chain at the target message and cancels active runs", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = rewindTx({});

    await expect(rewindThread(rewindPrisma(tx), input, fanout)).resolves.toMatchObject({
      cancelledRunIds: ["run-1"],
    });
    expect(appendRewindInTransaction).toHaveBeenCalledWith(tx, {
      sessionId: "session-1",
      messageId: "message-4",
      feedBotId: "bot-1",
    });
    // Events carry their own seq: cut at the target's creation event, not at the entry seq.
    expect(tx.event.deleteMany).toHaveBeenCalledWith({
      where: { threadId: "thread-1", seq: { gte: 11 } },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["run-1"] }, status: { in: [...ACTIVE_RUN_STATUSES] } },
        data: expect.objectContaining({ status: "cancelled" }),
      }),
    );
    expect(tx.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-1"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 20 }));
  });

  it("returns null and changes nothing when the target is not a user message", async () => {
    const tx = rewindTx({ target: null });

    await expect(rewindThread(rewindPrisma(tx), input)).resolves.toBeNull();
    expect(appendRewindInTransaction).not.toHaveBeenCalled();
    expect(tx.event.deleteMany).not.toHaveBeenCalled();
  });
});

describe("appendEvent", () => {
  it("does not persist output from a cancelled run after history was cleared", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }) },
      event: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      appendEvent(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          type: "thread.progress",
          runId: "run-1",
          payload: { text: "stale" },
        },
        fanout,
      ),
    ).rejects.toThrow(RunHistoryWriteError);
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("lets a new active run write after the thread was cleared", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const created = {
      ...event(8),
      type: "thread.progress",
      runId: "run-2",
    };
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 9 }) },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
      event: { create: vi.fn().mockResolvedValue(created) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      appendEvent(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          type: "thread.progress",
          runId: "run-2",
          payload: { text: "fresh" },
        },
        fanout,
      ),
    ).resolves.toMatchObject({ type: "thread.progress", runId: "run-2" });
    expect(tx.event.create).toHaveBeenCalled();
    expect(publish).toHaveBeenCalled();
  });

  it("does not persist a split-emoji high surrogate that would crash JSON insert", async () => {
    const fanout = new TestFanout();
    const created = {
      ...event(3),
      type: "thread.progress",
      runId: "run-3",
      payload: { delta: "hello \uFFFD", streaming: true },
    };
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 4 }) },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
      event: { create: vi.fn().mockResolvedValue(created) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    // Orphaned UTF-16 high surrogate (e.g. 😀 split across stream chunks as \uD83D alone).
    const orphanedHigh = "hello \uD83D";
    await expect(
      appendEvent(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          type: "thread.progress",
          runId: "run-3",
          payload: { delta: orphanedHigh, streaming: true },
        },
        fanout,
      ),
    ).resolves.toMatchObject({ type: "thread.progress", runId: "run-3" });

    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: { delta: "hello \uFFFD", streaming: true },
      }),
    });
    const persisted = tx.event.create.mock.calls[0]![0].data.payload as { delta: string };
    // Postgres rejects unpaired surrogates in json; the sanitized form must not contain any.
    expect(persisted.delta).not.toMatch(/[\uD800-\uDFFF]/);
    expect(() => JSON.stringify(persisted)).not.toThrow();
  });
});

describe("answerRunInput on a Create bot card with edits", () => {
  const OWNER = "user-1";
  const proposedRequest = {
    name: "Veille",
    title: "Watches competitors",
    instructions: "Track our competitors weekly.",
    prompt: "Start with the top three.",
    computer_mode: "dedicated",
  };
  const oldKey = approvalEffectKey("run-1", "spawn_bot", proposedRequest);

  function card(overrides: Record<string, unknown> = {}) {
    return {
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Create bot “Veille”?",
      detail: "Title: Watches competitors",
      status: "pending",
      actions: [
        { id: "allow", label: "Create bot", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
      spawnBot: {
        name: "Veille",
        title: "Watches competitors",
        instructions: "Track our competitors weekly.",
        prompt: "Start with the top three.",
        computerMode: "dedicated",
      },
      ...overrides,
    };
  }

  /** Rows behave like the database: a failed transaction restores everything it wrote. */
  function world(
    options: {
      kind?: string;
      block?: Record<string, unknown>;
      /** The card the run waits on now, when it moved past the one answered. */
      pendingCardId?: string;
      botNames?: string[];
      takenKeys?: string[];
      casCount?: number;
    } = {},
  ) {
    const state = {
      runStatus: "waiting_input",
      effect: {
        id: "effect-1",
        kind: options.kind ?? "spawn_bot",
        status: "intended",
        request: { ...proposedRequest } as Record<string, unknown>,
        idempotencyKey: oldKey,
      },
      entries: [] as Array<{ type: string; payload: Record<string, unknown> }>,
      events: [] as Array<{ type: string; payload: unknown; seq: number }>,
    };
    vi.mocked(appendSessionEntryInTransaction).mockImplementation(async (_tx, draft) => {
      state.entries.push({ type: draft.type, payload: draft.payload as Record<string, unknown> });
      return draft as never;
    });
    const botFindMany = vi.fn(async () => (options.botNames ?? []).map((name) => ({ name })));
    const effectFindUnique = vi.fn(async ({ where }: { where: { idempotencyKey: string } }) =>
      (options.takenKeys ?? []).includes(where.idempotencyKey) ? { id: "effect-other" } : null,
    );
    const effectUpdateMany = vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; status: string; idempotencyKey: string };
        data: Partial<typeof state.effect>;
      }) => {
        if (options.casCount === 0) return { count: 0 };
        if (
          state.effect.id !== where.id ||
          state.effect.status !== where.status ||
          state.effect.idempotencyKey !== where.idempotencyKey
        ) {
          return { count: 0 };
        }
        Object.assign(state.effect, data);
        return { count: 1 };
      },
    );
    const effectUpdate = vi.fn(async ({ data }: { data: Partial<typeof state.effect> }) => {
      Object.assign(state.effect, data);
    });
    const runFindFirst = vi.fn(async () =>
      state.runStatus === "waiting_input"
        ? { botId: "bot-1", userId: OWNER, checkpoint: null }
        : null,
    );
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      sessionEntry: {
        findFirst: vi.fn(async () =>
          askEntry(options.pendingCardId ?? "message-1", options.block ?? card()),
        ),
      },
      run: {
        findFirst: runFindFirst,
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        updateMany: vi.fn(async () => {
          state.runStatus = "queued";
          return { count: 1 };
        }),
      },
      externalEffect: {
        findFirst: vi.fn(async () =>
          state.effect.status === "intended" ? { ...state.effect } : null,
        ),
        findUnique: effectFindUnique,
        updateMany: effectUpdateMany,
        update: effectUpdate,
      },
      bot: { findMany: botFindMany },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      actionApprovalRule: { upsert: vi.fn() },
      thread: {
        update: vi.fn(async () => ({ nextEventSeq: 10 + state.events.length })),
        findUniqueOrThrow: vi.fn(async () => ({ nextEventSeq: 10 + state.events.length })),
      },
      event: {
        create: vi.fn(
          async ({ data }: { data: { seq: number; type: string; payload: unknown } }) => {
            state.events.push({ type: data.type, payload: data.payload, seq: data.seq });
            return { ...event(data.seq), type: data.type };
          },
        ),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => {
        const snapshot = structuredClone(state);
        try {
          return await callback(tx);
        } catch (error) {
          Object.assign(state, snapshot);
          throw error;
        }
      }),
    } as unknown as PrismaClient;
    return { state, tx, prisma, botFindMany, effectFindUnique, effectUpdateMany, effectUpdate };
  }

  const answer = (
    prisma: PrismaClient,
    extra: {
      answer?: string;
      answeredByUserId?: string;
      edits?: { name?: string; instructions?: string };
    },
  ) =>
    answerRunInput(prisma, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      messageId: "message-1",
      answeredByUserId: OWNER,
      answer: "allow",
      ...extra,
    });

  it("CA3 answers without edits exactly as before", async () => {
    const w = world();
    await expect(answer(w.prisma, {})).resolves.toBe(true);

    expect(w.effectUpdate).toHaveBeenCalledWith({
      where: { id: "effect-1" },
      data: { status: "approved", answeredAt: expect.any(Date) },
    });
    expect(w.effectUpdateMany).not.toHaveBeenCalled();
    expect(w.botFindMany).not.toHaveBeenCalled();
    expect(w.state.effect.request).toEqual(proposedRequest);
    expect(w.state.effect.idempotencyKey).toBe(oldKey);
    expect(w.state.events).toEqual([]);
    expect(w.state.entries).toEqual([
      {
        type: "effect.resolved",
        payload: { effectId: "effect-1", decision: "approved", answerId: "allow" },
      },
    ]);
  });

  it("CA24 answers an old card that has no spawnBot without edits", async () => {
    const { spawnBot: _spawnBot, ...oldCard } = card();
    const w = world({ block: oldCard });
    await expect(answer(w.prisma, {})).resolves.toBe(true);
    expect(w.state.effect.status).toBe("approved");
    expect(w.state.entries).toEqual([
      {
        type: "effect.resolved",
        payload: { effectId: "effect-1", decision: "approved", answerId: "allow" },
      },
    ]);
  });

  it("CA4 rewrites the request, the key and the card, and approves the effect", async () => {
    const w = world();
    await expect(
      answer(w.prisma, {
        edits: { name: "  Radar ", instructions: "Watch\r\nour competitors." },
      }),
    ).resolves.toBe(true);

    const approved = {
      name: "Radar",
      title: "Watches competitors",
      instructions: "Watch\nour competitors.",
      prompt: "Start with the top three.",
      computer_mode: "dedicated",
    };
    expect(w.state.effect).toMatchObject({
      status: "approved",
      request: approved,
      idempotencyKey: approvalEffectKey("run-1", "spawn_bot", approved),
    });
    expect(w.effectUpdateMany).toHaveBeenCalledWith({
      where: { id: "effect-1", status: "intended", idempotencyKey: oldKey },
      data: {
        request: approved,
        idempotencyKey: approvalEffectKey("run-1", "spawn_bot", approved),
        status: "approved",
        answeredAt: expect.any(Date),
      },
    });
    const edited = w.state.entries.find((entry) => entry.type === "effect.edited");
    expect(edited?.payload).toMatchObject({ effectId: "effect-1", proposal: approved });
    const answered = edited?.payload.card as Record<string, unknown>;
    expect(answered).toMatchObject({
      status: "answered",
      answer: "allow",
      text: "Create bot “Radar”?",
      spawnBot: {
        name: "Radar",
        title: "Watches competitors",
        instructions: "Watch\nour competitors.",
        prompt: "Start with the top three.",
        computerMode: "dedicated",
      },
    });
    expect(answered.detail).toContain("Watch");
    expect(answered.detail).not.toContain("Track our");
    expect(w.state.events.map((entry) => entry.type)).toEqual(["effect.edited"]);
    expect(w.state.entries.map((entry) => entry.type)).toEqual([
      "effect.edited",
      "effect.resolved",
    ]);
    expect(w.botFindMany).toHaveBeenCalledWith({
      where: { spaceId: "workspace-1", userId: OWNER, archivedAt: null },
      select: { name: true },
    });
  });

  it("CA21 audits the proposal next to the approval and puts the edit before the update", async () => {
    const w = world();
    await answer(w.prisma, { edits: { name: "Radar" } });

    expect(w.state.events[0]).toMatchObject({
      type: "effect.edited",
      payload: {
        effectId: "effect-1",
        proposed: proposedRequest,
        approved: { ...proposedRequest, name: "Radar" },
      },
    });
    expect(
      ProductEventSchema.safeParse({
        ...event(1),
        ...w.state.events[0],
        createdAt: "2026-09-29T12:00:00.000Z",
        runId: undefined,
      }).success,
    ).toBe(true);
    expect(w.tx.run.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      w.tx.event.create.mock.invocationCallOrder[0]!,
    );
  });

  it("CA8 treats edits that normalise to the same values as no edits", async () => {
    const w = world();
    await expect(
      answer(w.prisma, {
        edits: { name: "  Veille ", instructions: " Track our competitors weekly.\n" },
      }),
    ).resolves.toBe(true);

    expect(w.effectUpdate).toHaveBeenCalledOnce();
    expect(w.effectUpdateMany).not.toHaveBeenCalled();
    expect(w.botFindMany).not.toHaveBeenCalled();
    expect(w.state.effect.idempotencyKey).toBe(oldKey);
    expect(w.state.effect.request).toEqual(proposedRequest);
    expect(w.state.events).toEqual([]);
    expect(w.state.entries.map((entry) => entry.type)).toEqual(["effect.resolved"]);
  });

  it("CA8 lets instructions be cleared, and the request then carries none", async () => {
    const w = world();
    await answer(w.prisma, { edits: { instructions: "" } });

    const { instructions: _instructions, ...withoutInstructions } = proposedRequest;
    expect(w.state.effect.request).toEqual(withoutInstructions);
    expect(w.state.effect.idempotencyKey).toBe(
      approvalEffectKey("run-1", "spawn_bot", withoutInstructions),
    );
    const edited = w.state.entries.find((entry) => entry.type === "effect.edited");
    expect(edited?.payload.card).toMatchObject({ spawnBot: { instructions: "" } });
    expect((edited!.payload.card as { detail: string }).detail).not.toContain("Instructions:");
  });

  it.each([
    ["an empty name", { name: "   " }, "name is required."],
    ["a name of 81 characters", { name: "n".repeat(81) }, "at most 80"],
    ["a name held by an active bot", { name: " VEILLE2 " }, "already exists"],
    ["a hidden character", { name: "Ra​dar" }, "invisible"],
    ["a link-shaped name", { name: "[x](https://e)" }, "web address"],
    ["instructions of 3001 characters", { instructions: "i".repeat(3001) }, "at most 3000"],
    ["an isolated surrogate in the name", { name: "Radar\uD800" }, "invisible"],
    ["an isolated surrogate in the instructions", { instructions: "a\uDC00" }, "invisible"],
  ])("CA6 refuses %s and changes nothing", async (_label, edits, message) => {
    const w = world({ botNames: ["Veille2"] });
    const before = structuredClone(w.state);

    await expect(answer(w.prisma, { edits })).rejects.toThrow(InvalidAnswerError);
    await expect(answer(w.prisma, { edits })).rejects.toThrow(message);

    expect(w.state).toEqual(before);
    expect(w.tx.run.updateMany).not.toHaveBeenCalled();
    expect(w.effectUpdateMany).not.toHaveBeenCalled();
    expect(w.effectUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["a deny", { answer: "deny" }],
    ["an always", { answer: "always" }],
  ])("CA7 refuses edits with %s", async (_label, extra) => {
    const w = world({
      block: card({
        actions: [
          { id: "allow", label: "Create bot" },
          { id: "always", label: "Always" },
          { id: "deny", label: "Cancel" },
        ],
      }),
    });
    await expect(answer(w.prisma, { ...extra, edits: { name: "Radar" } })).rejects.toThrow(
      InvalidAnswerError,
    );
    expect(w.tx.run.updateMany).not.toHaveBeenCalled();
    expect(w.state.effect.status).toBe("intended");
  });

  it("CA7 refuses edits on an approval that is not a Create bot", async () => {
    for (const kind of ["create_space", "destination.write"]) {
      const w = world({ kind });
      await expect(answer(w.prisma, { edits: { name: "Radar" } })).rejects.toThrow(
        InvalidAnswerError,
      );
      expect(w.tx.run.updateMany).not.toHaveBeenCalled();
      expect(w.state.effect.status).toBe("intended");
      expect(w.state.effect.request).toEqual(proposedRequest);
    }
  });

  it("CA16 refuses edits from another member before reading any name", async () => {
    const w = world();
    await expect(
      answer(w.prisma, { answeredByUserId: "member-2", edits: { name: "Radar" } }),
    ).rejects.toThrow(InvalidAnswerError);

    expect(w.botFindMany).not.toHaveBeenCalled();
    expect(w.effectFindUnique).not.toHaveBeenCalled();
    expect(w.tx.externalEffect.findFirst).not.toHaveBeenCalled();
    expect(w.tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("CA16 still lets another member approve without edits, as before", async () => {
    const w = world();
    await expect(answer(w.prisma, { answeredByUserId: "member-2" })).resolves.toBe(true);
    expect(w.state.effect.status).toBe("approved");
  });

  it.each([
    [
      "a choice card",
      { kind: "ask", text: "Which?", status: "pending", actions: [{ id: "a", label: "A" }] },
      "a",
    ],
    ["a secret card", { kind: "ask", text: "Key?", input: "secret", status: "pending" }, "allow"],
    [
      "a multi-question card",
      {
        kind: "ask",
        text: "Questions",
        status: "pending",
        questions: [{ id: "q1", question: "Q?", options: [{ id: "o", label: "O" }] }],
      },
      JSON.stringify({ answers: { q1: { selected: ["o"] } } }),
    ],
  ])("CA16 refuses edits on %s", async (_label, block, answerText) => {
    const w = world({ block });
    await expect(
      answer(w.prisma, { answer: answerText, edits: { name: "Radar" } }),
    ).rejects.toThrow(InvalidAnswerError);
    expect(w.tx.run.updateMany).not.toHaveBeenCalled();
    expect(w.botFindMany).not.toHaveBeenCalled();
    expect(w.state.entries).toEqual([]);
  });

  it("CA7 keeps answering a card that was already answered as a conflict", async () => {
    // Answered once, the run went on and now waits on a later card.
    const w = world({ pendingCardId: "message-2" });
    await expect(answer(w.prisma, { edits: { name: "Radar" } })).resolves.toBe(false);
    expect(w.tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("CA7 answers a run that no longer waits as a conflict", async () => {
    const w = world();
    w.state.runStatus = "cancelled";
    await expect(answer(w.prisma, { edits: { name: "Radar" } })).resolves.toBe(false);
    expect(w.effectUpdateMany).not.toHaveBeenCalled();
  });

  it("CA9 refuses a key that already exists without cancelling the transaction", async () => {
    const approved = { ...proposedRequest, name: "Radar" };
    const w = world({ takenKeys: [approvalEffectKey("run-1", "spawn_bot", approved)] });
    const before = structuredClone(w.state);

    const failure = await answer(w.prisma, { edits: { name: "Radar" } }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InvalidAnswerError);
    expect((failure as Error).message).toBe(
      "This run already has a bot creation with these exact settings",
    );
    expect(w.state).toEqual(before);
    expect(w.tx.run.updateMany).not.toHaveBeenCalled();
    expect(w.effectFindUnique).toHaveBeenCalledOnce();
  });

  it("CA18 rolls everything back when the effect changed under the update", async () => {
    const w = world({ casCount: 0 });
    const before = structuredClone(w.state);

    await expect(answer(w.prisma, { edits: { name: "Radar" } })).rejects.toThrow(
      "Bot creation changed while it was edited",
    );

    expect(w.tx.run.updateMany).toHaveBeenCalledOnce();
    expect(w.state).toEqual(before);
    expect(w.state.runStatus).toBe("waiting_input");
    expect(w.state.effect.status).toBe("intended");
    expect(w.state.entries).toEqual([]);
    expect(w.state.events).toEqual([]);
  });

  it("CA18 refuses to rewrite an effect whose key moved since the card was read", async () => {
    const w = world();
    // Another writer settles the key between the plan and the update.
    w.tx.externalEffect.findUnique = vi.fn(async () => {
      w.state.effect.idempotencyKey = "moved";
      return null;
    });

    await expect(answer(w.prisma, { edits: { name: "Radar" } })).rejects.toThrow(
      "Bot creation changed while it was edited",
    );
    expect(w.effectUpdateMany).toHaveBeenCalledOnce();
    expect(w.state.runStatus).toBe("waiting_input");
    expect(w.state.effect.status).toBe("intended");
    expect(w.state.effect.request).toEqual(proposedRequest);
    expect(w.state.entries).toEqual([]);
    expect(w.state.events).toEqual([]);
  });

  it("CA17 lets only one of two racing answers through", async () => {
    const w = world();
    const first = await answer(w.prisma, { edits: { name: "Radar" } });
    const second = await answer(w.prisma, {});
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(w.state.effect.status).toBe("approved");
    expect(w.state.runStatus).toBe("queued");
    expect(w.state.effect.request).toMatchObject({ name: "Radar" });
  });

  it("CA19 stores a request whose key is the approval key of that request", async () => {
    const w = world();
    await answer(w.prisma, { edits: { name: "Radar", instructions: "Other." } });
    expect(w.state.effect.idempotencyKey).toBe(
      approvalEffectKey("run-1", "spawn_bot", w.state.effect.request),
    );
  });
});

describe("dismissProposalWithTextInTransaction", () => {
  const proposalCard = {
    kind: "ask",
    approvalEffectId: "effect-1",
    proposal: "routine",
    text: "Je m'en occupe chaque lundi ?",
    detail: "name: Weekly offers",
    status: "pending",
    actions: [
      { id: "allow", label: "Create routine", outcome: "created" },
      { id: "deny", label: "Not now", outcome: "cancelled" },
    ],
  };
  function proposalTx(
    options: {
      kind?: string;
      runStatus?: string;
      runUserId?: string;
      block?: Record<string, unknown>;
      effectUpdates?: number;
      runUpdates?: number;
    } = {},
  ) {
    return {
      $queryRaw: vi.fn().mockResolvedValue([]),
      run: {
        findFirst: vi.fn().mockResolvedValue({
          botId: "bot-1",
          userId: options.runUserId ?? "user-1",
          status: options.runStatus ?? "waiting_input",
          sessionId: "session-1",
        }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: new Date() }),
        updateMany: vi.fn().mockResolvedValue({ count: options.runUpdates ?? 1 }),
      },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(askEntry("card-msg", options.block ?? proposalCard)),
      },
      externalEffect: {
        findFirst: vi.fn().mockResolvedValue({
          id: "effect-1",
          kind: options.kind ?? "routine_proposal",
          status: "intended",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: options.effectUpdates ?? 1 }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 5 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
  }
  const input = { spaceId: "workspace-1", threadId: "thread-1", runId: "run-1", userId: "user-1" };

  it("puts the card away as dismissed and queues the run on its checkpoint", async () => {
    const tx = proposalTx();
    await expect(dismissProposalWithTextInTransaction(tx as never, input)).resolves.toEqual({
      outcome: "dismissed",
      status: "queued",
    });
    expect(tx.$queryRaw).toHaveBeenCalledBefore(tx.run.findFirst);
    expect(tx.externalEffect.updateMany).toHaveBeenCalledWith({
      where: { id: "effect-1", status: "intended", kind: { in: ["routine_proposal"] } },
      data: { status: "denied", answeredAt: expect.any(Date), result: { outcome: "dismissed" } },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: { id: "run-1", spaceId: "workspace-1", threadId: "thread-1", status: "waiting_input" },
      data: { status: "queued" },
    });
    expect(appendSessionEntryInTransaction).toHaveBeenCalledWith(tx, {
      type: "effect.resolved",
      sessionId: "session-1",
      botId: "bot-1",
      runId: "run-1",
      payload: { effectId: "effect-1", decision: "denied", dismissed: true },
    });
  });

  it.each([
    ["a Create bot card dressed as a proposal", { kind: "spawn_bot" }],
    ["a create_space card", { kind: "create_space" }],
    ["a sensitive tool approval", { kind: "gmail_send" }],
    ["a reply from someone else than the run's user", { runUserId: "user-2" }],
    [
      "an ask_user question",
      { block: { kind: "ask", text: "Which city?", status: "pending", input: "text" } },
    ],
    ["a cancelled run", { runStatus: "cancelled" }],
  ])("keeps %s as it is, writing nothing", async (_label, options) => {
    const tx = proposalTx(options);
    await expect(dismissProposalWithTextInTransaction(tx as never, input)).resolves.toEqual({
      outcome: "keep",
    });
    expect(tx.externalEffect.updateMany).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(appendSessionEntryInTransaction).not.toHaveBeenCalled();
  });

  const tappedCard = { ...proposalCard, status: "answered", answer: "allow" };
  it.each([
    ["a proposal", {}, { outcome: "settled", status: "queued" }],
    ["a Create bot card", { kind: "spawn_bot" }, { outcome: "keep" }],
    ["a connector approval", { kind: "gmail_send" }, { outcome: "keep" }],
    [
      "an ask_user question",
      { block: { kind: "ask", text: "Which city?", status: "answered", input: "text" } },
      { outcome: "keep" },
    ],
  ])(
    "lets a tap on %s that came first win, and steers the reply only into a proposal's run",
    async (_label, options, outcome) => {
      const tapped = proposalTx({ runStatus: "queued", block: tappedCard, ...options });
      await expect(dismissProposalWithTextInTransaction(tapped as never, input)).resolves.toEqual(
        outcome,
      );
      expect(tapped.externalEffect.updateMany).not.toHaveBeenCalled();
    },
  );

  it("never steers into a run still waiting on a card that was answered", async () => {
    const answered = proposalTx({ effectUpdates: 0 });
    await expect(dismissProposalWithTextInTransaction(answered as never, input)).resolves.toEqual({
      outcome: "keep",
    });
    expect(answered.run.updateMany).not.toHaveBeenCalled();
    expect(appendSessionEntryInTransaction).not.toHaveBeenCalled();
  });

  it("rolls back when the run moved without the card", async () => {
    const tx = proposalTx({ runUpdates: 0 });
    await expect(dismissProposalWithTextInTransaction(tx as never, input)).rejects.toThrow(
      "The run changed while its card was put away",
    );
    expect(appendSessionEntryInTransaction).not.toHaveBeenCalled();
  });
});
