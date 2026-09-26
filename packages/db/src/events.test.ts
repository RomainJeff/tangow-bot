import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  answerRunInput,
  appendEvent,
  claimSteering,
  clearThread,
  completedRunBlocks,
  conversationRunFilter,
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
import { RunHistoryWriteError } from "./messages.js";

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
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          computerId: "computer-1",
          thread: { id: "thread-1" },
        }),
      },
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
      message: { findUnique: vi.fn().mockResolvedValue(null) },
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
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          computerId: "computer-1",
          thread: { id: "thread-1" },
        }),
      },
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
      message: { findUnique: vi.fn().mockResolvedValue(null) },
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
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      bot: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
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
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 4 })
          .mockResolvedValueOnce({ nextEventSeq: 8 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
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

    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-1",
          runId: "run-1",
          role: "bot",
        }),
      }),
    );
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "running", leaseFence: 3 }),
        data: { status: "waiting_input", leaseOwner: null, leaseExpiresAt: null },
      }),
    );
    expect(tx.event.create.mock.calls.map(([input]) => input.data.type)).toEqual([
      "thread.message.created",
      "run.waiting_input",
    ]);
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
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 4 })
          .mockResolvedValueOnce({ nextEventSeq: 8 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
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
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Which city?",
              status: "pending",
              actions: [
                { id: "choice-1", label: "Berlin" },
                { id: "choice-2", label: "Paris" },
              ],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
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
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
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
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [
          {
            kind: "ask",
            text: "Which city?",
            status: "answered",
            answer: "choice-2",
            actions: [
              { id: "choice-1", label: "Berlin" },
              { id: "choice-2", label: "Paris" },
            ],
          },
        ],
      },
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: { prompt: expect.stringContaining("Selected choice choice-2: Paris") },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "thread.message.updated", botId: "bot-2" }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 9 }));
  });

  it("resumes with the offered choice label when the persisted label was redacted", async () => {
    const fanout = new TestFanout();
    const secret = "sk-live-choice-secret";
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Which token?",
              status: "pending",
              actions: [
                { id: "choice-1", label: `use [redacted]` },
                { id: "choice-2", label: "use plain" },
              ],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
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
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 11 }) },
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
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [
          {
            kind: "ask",
            text: "Which token?",
            status: "answered",
            answer: "choice-1",
            actions: [
              { id: "choice-1", label: "use [redacted]" },
              { id: "choice-2", label: "use plain" },
            ],
          },
        ],
      },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "queued", checkpoint: null },
      }),
    );
  });

  it("accepts a free-text answer on a choice ask (none of the offered choices)", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Which city?",
              status: "pending",
              actions: [
                { id: "Berlin", label: "Berlin" },
                { id: "Seoul", label: "Seoul" },
              ],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({}),
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
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 11 }) },
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
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
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
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({}),
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
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 11 }) },
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
    const updatedBlocks = tx.message.update.mock.calls[0]![0].data.blocks;
    expect(updatedBlocks[0].status).toBe("answered");
    expect(updatedBlocks[0].answers).toEqual({
      q1: { selected: ["q1o1"] },
      q2: { other: "6 mois" },
    });
  });

  it("keeps one selected option on a single-choice question", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
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
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({}),
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
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 11 }) },
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
    const updatedBlocks = tx.message.update.mock.calls[0]![0].data.blocks;
    expect(updatedBlocks[0].answers).toEqual({ q1: { selected: ["q1o1"] } });
  });

  it("rejects a multi-question submission that is not valid JSON", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "",
              status: "pending",
              questions: [{ id: "q1", question: "Ta cible ?" }],
            },
          ],
        }),
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
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "",
              status: "pending",
              questions: [
                { id: "q1", question: "Ta cible ?" },
                { id: "q2", question: "Ton horizon ?" },
              ],
            },
          ],
        }),
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
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "",
              status: "pending",
              questions: [{ id: "q1", question: "Ta cible ?" }],
            },
          ],
        }),
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
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Which city?",
              status: "pending",
              actions: [
                { id: "Berlin", label: "Berlin" },
                { id: "Seoul", label: "Seoul" },
              ],
            },
          ],
        }),
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
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "effect-1",
              text: "Review before writing",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
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
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
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
      data: { status: "approved" },
    });
  });

  it("approves and upserts always-allow without overwriting the task prompt", async () => {
    const fanout = new TestFanout();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "effect-1",
              text: "Review before writing",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "always", label: "Always allow" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
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
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
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
      data: { status: "approved" },
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
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "effect-1",
              text: "Review before writing",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "always", label: "Always allow" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
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
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "missing-effect",
              text: "Review before writing",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
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
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "effect-1",
              text: "Review before writing",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
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

  it("rejects an already answered prompt without queuing the run", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [{ kind: "ask", text: "Which city?", status: "answered", answer: "Paris" }],
        }),
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
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Enter your code",
              input: "secret",
              purpose: "api_key",
              ...(credential ? { credential } : {}),
              status: "pending",
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      task: { updateMany: vi.fn() },
      externalEffect: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
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
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [
          {
            kind: "ask",
            text: "Enter your code",
            input: "secret",
            purpose: "api_key",
            ...(credential ? { credential } : {}),
            status: "answered",
            answer: "",
          },
        ],
      },
    });
  });

  it("does not let another workspace member save a credential as the run owner", async () => {
    const store = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "owner" }),
        updateMany: vi.fn(),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "API key",
              input: "secret",
              status: "pending",
              credential: {
                name: "example_api",
                origin: "https://api.example.test",
                auth: { type: "bearer" },
              },
            },
          ],
        }),
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
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Enter your code",
              input: "secret",
              status: "pending",
            },
          ],
        }),
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
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "ask-msg-1",
          blocks: [askBlock],
        }),
        update: vi.fn().mockResolvedValue({ id: "ask-msg-1" }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 5 }) },
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

    expect(result).toMatchObject({ resolvable: true, runId: "run-1", botId: "bot-1" });
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: { id: "run-1", spaceId: "workspace-1", threadId: "thread-1", status: "waiting_input" },
      data: { status: "queued", checkpoint: null },
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: { prompt: expect.stringContaining("Lisbon, flexible dates") },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "ask-msg-1" },
      data: {
        blocks: [
          {
            kind: "ask",
            text: "What's the target city?",
            status: "answered",
            input: "text",
          },
        ],
      },
    });
    // Never echo the reply onto the card (design D2 — the words live in the user's bubble) and
    // never fabricate a structured per-question map from free text.
    const updatedBlock = tx.message.update.mock.calls[0]![0].data.blocks[0];
    expect(updatedBlock.answer).toBeUndefined();
    expect(updatedBlock.answers).toBeUndefined();
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
    expect(tx.message.update).toHaveBeenCalled();
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
    expect(tx.message.update).not.toHaveBeenCalled();
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
    expect(tx.message.update).not.toHaveBeenCalled();
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
    expect(tx.message.update).not.toHaveBeenCalled();
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
    expect(tx.message.findFirst).not.toHaveBeenCalled();
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

  // A block written by another build version must neither hide the pending ask (the client
  // renders the card as pending, so CONFLICT there is a lie) nor vanish from the stored message.
  it("resolves past a block this build does not recognise and writes it back untouched", async () => {
    const unknownBlock = { kind: "future_widget", payload: { anything: 1 } };
    const tx = baseTx({ kind: "ask", text: "Where next?", status: "pending", input: "text" });
    tx.message.findFirst = vi.fn().mockResolvedValue({
      id: "ask-msg-1",
      blocks: [
        unknownBlock,
        { kind: "ask", text: "Where next?", status: "pending", input: "text" },
      ],
    });

    const result = await resumeAskWithComposerTextInTransaction(tx as never, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      text: "Kyoto",
    });

    expect(result).toMatchObject({ resolvable: true });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "ask-msg-1" },
      data: {
        blocks: [
          unknownBlock,
          { kind: "ask", text: "Where next?", status: "answered", input: "text" },
        ],
      },
    });
  });
});

describe("sendUserMessage", () => {
  it("creates the message, run, and event in one transaction and publishes once", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn(),
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
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      sendUserMessage(
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
          linkMessageToRun: true,
        },
        fanout,
      ),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: "task-1", runId: "run-1" });

    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trigger: "user",
          clientNonce: "send:message-1",
          sourceMessageId: "message-1",
        }),
      }),
    );
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: { runId: "run-1" },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "thread.message.created", runId: "run-1" }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 8 }));
  });

  it("persists steering instead of starting a parallel run when the bot is busy", async () => {
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
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

    await expect(
      sendUserMessage(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text: "hello" }],
        prompt: "hello",
        trigger: "follow_up",
      }),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: null, runId: "run-0" });

    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    // Only conversation runs take steering; a routine card run's reply never reaches the thread.
    expect(tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(conversationRunFilter) }),
    );
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: { runId: "run-0" },
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "message-1", botId: "bot-1", userId: "user-1", runId: "run-0" },
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
      message: { create: vi.fn() },
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
    expect(tx.message.create).not.toHaveBeenCalled();
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
      run: { findFirst: vi.fn().mockResolvedValue({ id: "run-1" }) },
      steeringMessage: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "steer-1",
            messageId: "message-1",
            message: {
              seq: 5,
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
          {
            id: "steer-2",
            messageId: "message-2",
            message: { seq: 6, blocks: [{ kind: "text", text: "Second" }] },
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

describe("clearThread", () => {
  it("releases the computer execution lease without dropping the computer", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 42, historyCompactionGeneration: 0 })
          .mockResolvedValue({ nextEventSeq: 1 }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]),
        updateMany: vi.fn(),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      computerExecutionLease: { updateMany: vi.fn() },
      computer: { updateMany: vi.fn() },
      message: { deleteMany: vi.fn() },
      event: {
        deleteMany: vi.fn(),
        create: vi.fn().mockResolvedValue({
          ...event(0),
          type: "thread.cleared",
        }),
      },
      bot: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      clearThread(prisma, { spaceId: "workspace-1", threadId: "thread-1", botId: "bot-1" }, fanout),
    ).resolves.toMatchObject({
      event: { type: "thread.cleared" },
      cancelledRunIds: ["run-1"],
    });
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
    // Every deleted message counts as compacted, so compaction cannot summarize cleared history.
    expect(tx.thread.update).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: {
        historyCompactedUpToSeq: 41,
        historyCompactionSummary: null,
        historyCompactionGeneration: { increment: 1 },
      },
    });
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 0 }));
  });

  it("scopes group clear lease cleanup to cancelled run ids", async () => {
    const fanout = new TestFanout();
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 3, historyCompactionGeneration: 0 })
          .mockResolvedValue({ nextEventSeq: 1 }),
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
      message: { deleteMany: vi.fn() },
      event: {
        deleteMany: vi.fn(),
        create: vi.fn().mockResolvedValue({
          ...event(0),
          type: "thread.cleared",
        }),
      },
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
  function rewindTx(overrides: {
    message?: { seq: number } | null;
    historyCompactedUpToSeq?: number | null;
  }) {
    return {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({
            nextMessageSeq: 9,
            historyCompactedUpToSeq: overrides.historyCompactedUpToSeq ?? null,
            historyCompactionGeneration: 2,
          })
          .mockResolvedValue({ nextEventSeq: 21 }),
      },
      message: {
        findFirst: vi
          .fn()
          .mockResolvedValue(overrides.message === undefined ? { seq: 4 } : overrides.message),
        deleteMany: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]),
        updateMany: vi.fn(),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      computerExecutionLease: { updateMany: vi.fn() },
      computer: { updateMany: vi.fn() },
      event: {
        findFirst: vi.fn().mockResolvedValue({ seq: 11 }),
        deleteMany: vi.fn(),
        create: vi.fn().mockResolvedValue({
          ...event(20),
          type: "thread.rewound",
          payload: { fromSeq: 4 },
        }),
      },
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

  it("deletes only the target message onwards and cancels active runs", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = rewindTx({});

    await expect(rewindThread(rewindPrisma(tx), input, fanout)).resolves.toMatchObject({
      event: { type: "thread.rewound" },
      cancelledRunIds: ["run-1"],
      fromSeq: 4,
      compactionReset: false,
    });
    expect(tx.message.deleteMany).toHaveBeenCalledWith({
      where: { threadId: "thread-1", seq: { gte: 4 } },
    });
    // Events carry their own seq: cut at the target's creation event, not at the message seq.
    expect(tx.event.deleteMany).toHaveBeenCalledWith({
      where: { threadId: "thread-1", seq: { gte: 11 } },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["run-1"] } },
        data: expect.objectContaining({ status: "cancelled" }),
      }),
    );
    expect(tx.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-1"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "thread.rewound", payload: { fromSeq: 4 } }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 20 }));
  });

  it("keeps compaction when the target is newer than the compaction cursor", async () => {
    const tx = rewindTx({ historyCompactedUpToSeq: 2 });

    await expect(rewindThread(rewindPrisma(tx), input)).resolves.toMatchObject({
      compactionReset: false,
    });
    expect(tx.thread.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ historyCompactionGeneration: { increment: 1 } }),
      }),
    );
  });

  it("resets compaction when the target sits under the compaction cursor", async () => {
    const tx = rewindTx({ historyCompactedUpToSeq: 4 });

    await expect(rewindThread(rewindPrisma(tx), input)).resolves.toMatchObject({
      compactionReset: true,
      historyCompactionGeneration: 2,
    });
    expect(tx.thread.update).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: {
        historyCompactedUpToSeq: null,
        historyCompactionSummary: null,
        historyCompactionGeneration: { increment: 1 },
      },
    });
  });

  it("returns null and changes nothing when the target is not a user message", async () => {
    const tx = rewindTx({ message: null });

    await expect(rewindThread(rewindPrisma(tx), input)).resolves.toBeNull();
    expect(tx.message.deleteMany).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
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
