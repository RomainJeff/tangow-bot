import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { conversationRunFilter } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  cancelSupersededQueuedRuns,
  reactToThreadMessage,
  sendThreadMessage,
  stopThreadRuns,
  type ThreadTarget,
  threadHead,
  threadSnapshot,
} from "./thread-target.js";

vi.mock("../../../packages/db/src/sessions.js", async () =>
  (await import("@rakazo/db/sessions.test-support")).stubbedDbSessions(),
);

describe("threadHead", () => {
  it("returns the durable cursor without loading a snapshot", async () => {
    const findFirst = vi.fn().mockResolvedValue({ seq: 12 });
    const prisma = { event: { findFirst } } as unknown as PrismaClient;
    const target = { threadId: "thread-1" } as ThreadTarget;

    await expect(threadHead(prisma, target)).resolves.toEqual({
      threadId: "thread-1",
      cursor: 12,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { threadId: "thread-1" },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
  });
});

describe("queued run supersession", () => {
  it("only cancels queued runs started by user messages or reactions", async () => {
    const tx = {
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-old", taskId: "task-old" }]),
        updateMany: vi.fn(),
      },
      task: { updateMany: vi.fn() },
    };
    await cancelSupersededQueuedRuns(tx as never, {
      threadId: "thread-1",
      botIds: ["bot-1"],
      keepRunIds: ["run-new"],
    });
    expect(tx.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ trigger: "user", sourceMessage: { role: "user" } }, { trigger: "reaction" }],
        }),
      }),
    );
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["run-old"] } } }),
    );
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["task-old"] } },
      data: { status: "cancelled" },
    });
  });
});

describe("reaction messages", () => {
  it("appends repeated reactions as quiet replies and deduplicates retries", async () => {
    const messages = new Map<string, { id: string }>();
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      message: {
        findFirst: vi.fn().mockResolvedValue({ id: "parent" }),
        findUnique: vi.fn(
          async ({ where }: { where: { threadId_clientNonce: { clientNonce: string } } }) =>
            messages.get(where.threadId_clientNonce.clientNonce) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: { clientNonce: string } }) => {
          const message = { id: `reaction-${messages.size}`, ...data };
          messages.set(data.clientNonce, message);
          return message;
        }),
      },
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: `event-${eventSeq}`,
          createdAt: new Date(),
          ...data,
        })),
      },
      task: { create: vi.fn() },
      run: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "space-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;
    for (const [clientNonce, reaction] of [
      ["first", "❤️"],
      ["second", "👍"],
      ["third", "❤️"],
      ["third", "❤️"],
    ] as const) {
      await reactToThreadMessage({ prisma }, actor, target, {
        messageId: "parent",
        reaction,
        clientNonce,
      });
    }
    expect(tx.message.create).toHaveBeenCalledTimes(3);
    expect(tx.event.create).toHaveBeenCalledTimes(3);
    expect(tx.message.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        role: "user",
        blocks: [{ kind: "text", text: "❤️" }],
        replyToMessageId: "parent",
        clientNonce: "third",
      }),
    });
    expect(tx.event.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        type: "thread.message.created",
        payload: {
          messageId: "reaction-2",
          role: "user",
          blocks: [{ kind: "text", text: "❤️" }],
          replyToMessageId: "parent",
        },
      }),
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.message.findFirst).toHaveBeenCalledWith({
      where: { id: "parent", threadId: "thread-1" },
      select: { id: true },
    });
    tx.message.findFirst.mockResolvedValueOnce(null);
    await expect(
      reactToThreadMessage({ prisma }, actor, target, {
        messageId: "elsewhere",
        reaction: "❤️",
        clientNonce: "fourth",
      }),
    ).rejects.toThrow();
    expect(tx.message.create).toHaveBeenCalledTimes(3);
  });
});

describe("threadSnapshot", () => {
  it("reloads tool-only live messages for an active run", async () => {
    const run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const findManyEvents = vi.fn().mockResolvedValue([
      {
        id: "event-1",
        threadId: "thread-1",
        botId: "bot-1",
        seq: 4,
        type: "agent.tool.called",
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
        createdAt: new Date("2026-08-23T00:00:00.000Z"),
      },
    ]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue({ seq: 4 }),
        findMany: findManyEvents,
      },
      run: { findFirst: botRunFindFirst([run]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(findManyEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: {
            in: ["thread.progress", "thread.subagent", "agent.tool.called", "agent.tool.completed"],
          },
        }),
      }),
    );
    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        botId: "bot-1",
        blocks: [
          {
            kind: "steps",
            steps: [{ label: "Slack find channels", count: 1 }],
          },
        ],
      }),
    ]);
  });

  it("returns the latest failed run so the client can show its error", async () => {
    const run = {
      id: "run-failed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "Provider is not configured: openrouter",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const findManyEvents = vi.fn();
    const findFirstRun = botRunFindFirst([run]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: findManyEvents,
      },
      run: { findFirst: findFirstRun },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot-1",
          threadId: "thread-1",
          OR: [
            {
              status: {
                in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
              },
            },
            { trigger: { not: "bot_message" }, status: "failed" },
          ],
        }),
      }),
    );
    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          botId: "bot-1",
          threadId: "thread-1",
          status: { in: ["waiting_input", "waiting_takeover"] },
        },
      }),
    );
    expect(snapshot.run).toEqual(
      expect.objectContaining({
        id: "run-failed",
        status: "failed",
        error: "Provider is not configured: openrouter",
      }),
    );
    expect(findManyEvents).not.toHaveBeenCalled();
  });

  it("prefers a waiting peer ask over a concurrent user run", async () => {
    const waitingPeer = {
      id: "run-peer-waiting",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "waiting_input",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const olderUser = {
      id: "run-user",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-user",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const snapshot = await threadSnapshot(
      {
        prisma: {
          $transaction: vi.fn(async (callback: (client: unknown) => unknown) =>
            callback({
              $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
              message: { findMany: vi.fn().mockResolvedValue([]) },
              event: {
                findFirst: vi.fn().mockResolvedValue(null),
                findMany: vi.fn().mockResolvedValue([]),
              },
              run: { findFirst: botRunFindFirst([waitingPeer, olderUser]) },
            }),
          ),
        } as unknown as PrismaClient,
      },
      {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget,
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-peer-waiting", status: "waiting_input" }),
    );
  });

  it("drops a failed run once a newer run has finished", async () => {
    const failed = {
      id: "run-failed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "This operation was aborted",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const completed = {
      id: "run-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:03.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const findFirstRun = botRunFindFirst([failed, completed]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
      },
      run: { findFirst: findFirstRun },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trigger: { not: "bot_message" },
          status: { in: ["failed", "completed", "cancelled"] },
        }),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    expect(snapshot.run).toBeNull();
  });

  it("shows a busy peer run as the bot thread's run without leaking its live events", async () => {
    const peerRunning = {
      id: "run-peer-running",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "running",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const findManyEvents = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: findManyEvents,
      },
      run: { findFirst: botRunFindFirst([peerRunning]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    // The bot really is working, so the chat must say so...
    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-peer-running", status: "running" }),
    );
    // ...without replaying what it is doing for the other bot.
    expect(findManyEvents).not.toHaveBeenCalled();
  });

  it("hides a failed peer run from the bot thread", async () => {
    const peerFailed = {
      id: "run-peer-failed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "failed",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: "peer exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
      },
      run: { findFirst: botRunFindFirst([peerFailed]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(snapshot.run).toBeNull();
  });

  it("does not return a cancelled or completed run", async () => {
    const findManyEvents = vi.fn();
    const findFirstRun = botRunFindFirst([]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: findManyEvents,
      },
      run: { findFirst: findFirstRun },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            {
              status: {
                in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
              },
            },
            { trigger: { not: "bot_message" }, status: "failed" },
          ],
        }),
      }),
    );
    expect(snapshot.run).toBeNull();
    expect(findManyEvents).not.toHaveBeenCalled();
  });
  it("returns a group's latest failed run so a refresh keeps its error", async () => {
    const run = {
      id: "run-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "member exploded",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const findManyRuns = groupRunFindMany({ terminals: [run] });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread-1",
          parentRunId: null,
          trigger: { not: "bot_message" },
          status: { in: ["failed", "completed", "cancelled"] },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 50,
      }),
    );
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread-1",
          parentRunId: null,
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        },
      }),
    );
    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([]);
  });

  it("shows a busy peer run in group activeRuns but hides its failure", async () => {
    const peerActive = {
      id: "run-peer-active",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "running",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const peerFailed = {
      id: "run-peer-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-peer-fail",
      status: "failed",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: "peer exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const findManyRuns = groupRunFindMany({
      active: [peerActive],
      terminals: [peerFailed],
    });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    // The chat must look busy while a peer waits on this bot...
    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-peer-active", status: "running" }),
    ]);
    expect(snapshot.run).toEqual(expect.objectContaining({ id: "run-peer-active" }));
    // ...but the peer's failure belongs to the bot that ordered the work, not to this user.
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        }),
      }),
    );
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trigger: { not: "bot_message" },
          status: { in: ["failed", "completed", "cancelled"] },
        }),
      }),
    );
  });

  it("keeps a peer run parked on ask_user answerable without leaking its live events", async () => {
    const peerAsking = {
      id: "run-peer-asking",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "waiting_input",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const peerRunning = { ...peerAsking, id: "run-peer-running", status: "running" };
    const findManyEvents = vi.fn().mockResolvedValue([]);
    const snapshot = await threadSnapshot(
      {
        prisma: groupPrisma(
          groupRunFindMany({ active: [peerAsking, peerRunning] }),
          findManyEvents,
        ),
      },
      groupTarget(),
    );

    // The ask must be answerable (the client gates AskCard on activeRuns), and the merely-busy
    // peer run keeps the working indicator alive...
    expect(snapshot.activeRuns?.map((run) => run.id)).toEqual([
      "run-peer-asking",
      "run-peer-running",
    ]);
    // ...but no peer narration may be streamed into the transcript.
    expect(findManyEvents).not.toHaveBeenCalled();
  });

  it("includes waiting peer bot_message runs in group activeRuns", async () => {
    const peerWaiting = {
      id: "run-peer-waiting",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "waiting_input",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const findManyRuns = groupRunFindMany({ active: [peerWaiting] });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-peer-waiting", status: "waiting_input" }),
    ]);
  });

  it("keeps a waiting peer ask as the primary run even when a newer busy run exists", async () => {
    // Real DB order is createdAt desc, so the newer busy run for bot-b comes
    // first here, ahead of the older waiting peer run for bot-a.
    const newerBusy = {
      id: "run-newer-busy",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-busy",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:10.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:10.000Z"),
    };
    const olderWaiting = {
      id: "run-older-waiting",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "waiting_input",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const findManyRuns = groupRunFindMany({ active: [newerBusy, olderWaiting] });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    expect(snapshot.run).toEqual(expect.objectContaining({ id: "run-older-waiting" }));
    // activeRuns is unaffected by which one is chosen as primary.
    expect(snapshot.activeRuns.map((run) => run.id)).toEqual([
      "run-newer-busy",
      "run-older-waiting",
    ]);
  });

  it("does not revive an older group failure after a newer run completed", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const completed = {
      id: "run-newer-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: new Date("2026-08-23T00:00:04.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [completed, failed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
    expect(snapshot.activeRuns).toEqual([]);
  });

  it("does not revive a failure when a newer cancelled run has null completedAt", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const cancelled = {
      id: "run-newer-cancelled",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "cancelled",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:03.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [cancelled, failed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
  });

  it("prefers a timestamped terminal over an older failure with null completedAt", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const completed = {
      id: "run-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: new Date("2026-08-23T00:00:04.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [failed, completed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
  });

  it("clamps a long persisted group failure error on refresh", async () => {
    const longError = "x".repeat(400);
    const run = {
      id: "run-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: longError,
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [run] })) },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({
        id: "run-failed",
        status: "failed",
        error: `${"x".repeat(300)}…`,
      }),
    );
  });

  it("keeps a concurrent member failure in run while another member is still active", async () => {
    const active = {
      id: "run-active",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:00.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const failed = {
      id: "run-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-b",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "member exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ active: [active], terminals: [failed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-active", status: "running" }),
    ]);
  });

  it("keeps a failure on refresh when another member starts after it", async () => {
    const lateActive = {
      id: "run-late",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:03.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:03.000Z"),
    };
    const failed = {
      id: "run-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-b",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "member exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const snapshot = await threadSnapshot(
      {
        prisma: groupPrisma(groupRunFindMany({ active: [lateActive], terminals: [failed] })),
      },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-late", status: "running" }),
    ]);
  });
});

function isTerminalRunQuery(where: RunWhereClause | undefined) {
  const statuses = typeof where?.status === "object" ? where.status?.in : undefined;
  return Array.isArray(statuses) && statuses.includes("failed") && statuses.includes("completed");
}

type RunWhereClause = {
  status?: { in?: string[] } | string;
  trigger?: { not?: string };
  OR?: RunWhereClause[];
};

/** The subset of Prisma's run filter the snapshot actually builds: status, trigger, and one OR. */
function matchesRunWhere(
  row: { trigger?: string; status?: string },
  where: RunWhereClause | undefined,
): boolean {
  if (!where) return true;
  if (typeof where.status === "string" && row.status !== where.status) return false;
  const statuses = typeof where.status === "object" ? where.status?.in : undefined;
  if (statuses && !statuses.includes(row.status ?? "")) return false;
  if (where.trigger?.not !== undefined && row.trigger === where.trigger.not) return false;
  if (where.OR && !where.OR.some((clause) => matchesRunWhere(row, clause))) return false;
  return true;
}

function botRunFindFirst(
  rows: Array<{
    id: string;
    status: string;
    trigger?: string;
    createdAt?: Date;
  }>,
) {
  return vi
    .fn()
    .mockImplementation(async (args: { where?: RunWhereClause; select?: { id?: boolean } }) => {
      const matched = rows
        .filter((row) => matchesRunWhere(row, args.where))
        .sort((a, b) => {
          const byCreated = (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
          return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
        });
      const row = matched[0] ?? null;
      if (!row) return null;
      return args.select?.id ? { id: row.id } : row;
    });
}

function groupRunFindMany(input: { active?: unknown[]; terminals?: unknown[] }) {
  return vi.fn().mockImplementation(async (args: { where?: RunWhereClause }) => {
    const rows = isTerminalRunQuery(args.where) ? (input.terminals ?? []) : (input.active ?? []);
    return rows.filter((row) =>
      matchesRunWhere(row as { trigger?: string; status?: string }, args.where),
    );
  });
}

function groupPrisma(
  findManyRuns: ReturnType<typeof groupRunFindMany>,
  findManyEvents = vi.fn().mockResolvedValue([]),
) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
    message: { findMany: vi.fn().mockResolvedValue([]) },
    event: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: findManyEvents,
    },
    run: { findMany: findManyRuns },
  };
  return {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
}

function groupTarget() {
  return {
    kind: "group",
    groupId: "group-1",
    groupName: "Group",
    members: [],
    threadId: "thread-1",
  } as unknown as ThreadTarget;
}

describe("sendThreadMessage", () => {
  it("rejects a new bot message while a run is waiting on an approval ask", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn().mockResolvedValue({ nextMessageSeq: 2 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "hi" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({
          id: "ask-msg-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "effect-1",
              text: "Allow this?",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-waiting", taskId: "task-1", status: "waiting_input" }]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn() },
      task: { create: vi.fn(), updateMany: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn() } as never,
          jobs: { enqueue: vi.fn() } as never,
        },
        actor,
        target,
        {
          text: "hi",
          clientNonce: "nonce-1",
        },
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Answer the pending ask first.",
    });
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
  });

  it("never steers a message into a run that only reports through a routine card", async () => {
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 2, nextEventSeq: 2 }) },
      message: {
        create: vi.fn().mockResolvedValue({ id: "msg-1", threadId: "thread-1", seq: 1 }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          // Every active run, as the ask and conflict checks see them: a routine card run.
          .mockResolvedValueOnce([{ id: "run-card", taskId: "task-card", status: "running" }])
          // The conversation runs among them: none.
          .mockResolvedValueOnce([])
          // No superseded queued user run to cancel.
          .mockResolvedValueOnce([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 1 }) },
      task: {
        create: vi.fn().mockResolvedValue({ id: "task-1" }),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn(async () => undefined) } as never,
        jobs: { enqueue: vi.fn(async () => undefined) } as never,
      },
      { spaceId: "workspace-1", userId: "user-1" } as Actor,
      target,
      { text: "hi", clientNonce: "nonce-1" },
    );

    // The ask/conflict lookup still sees the card run, so it can answer its own ask.
    expect(tx.run.findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty("NOT");
    expect(tx.run.findMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ["run-card"] }, ...conversationRunFilter },
      select: { id: true },
    });
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.run.create).toHaveBeenCalled();
  });

  describe("link previews", () => {
    function sendHarness(enqueue = vi.fn(async () => undefined)) {
      const tx = {
        thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 2, nextEventSeq: 2 }) },
        message: {
          create: vi.fn().mockResolvedValue({ id: "msg-1", threadId: "thread-1", seq: 1 }),
          update: vi.fn(),
        },
        run: {
          findMany: vi.fn().mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
          create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
        },
        steeringMessage: { create: vi.fn() },
        event: { create: vi.fn().mockResolvedValue({ seq: 1 }) },
        task: { create: vi.fn().mockResolvedValue({ id: "task-1" }), updateMany: vi.fn() },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const target = {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget;
      const send = (input: { linkPreview?: false }) =>
        sendThreadMessage(
          {
            prisma,
            events: { notify: vi.fn(async () => undefined) } as never,
            jobs: { enqueue } as never,
          },
          { spaceId: "workspace-1", userId: "user-1" } as Actor,
          target,
          { text: "see https://example.test/a", clientNonce: "nonce-1", ...input },
        );
      return { tx, enqueue, send };
    }

    it("queues the preview after the commit, with the message id only", async () => {
      const { tx, enqueue, send } = sendHarness();

      await send({});

      const jobs = enqueue.mock.calls.map(([job]) => job as { name: string; payload: unknown });
      expect(jobs.at(-1)).toMatchObject({
        name: "link.preview",
        payload: { messageId: "msg-1" },
        maxAttempts: 1,
      });
      expect(JSON.stringify(jobs.at(-1))).not.toContain("example.test");
      expect(tx.message.create.mock.calls[0]![0].data.blocks).toEqual([
        { kind: "text", text: "see https://example.test/a" },
      ]);
    });

    it("writes the removal marker at creation and queues nothing for linkPreview: false", async () => {
      const { tx, enqueue, send } = sendHarness();

      await send({ linkPreview: false });

      expect(tx.message.create.mock.calls[0]![0].data.blocks).toEqual([
        { kind: "text", text: "see https://example.test/a" },
        { kind: "link_preview", removed: true },
      ]);
      expect(enqueue.mock.calls.map(([job]) => (job as { name: string }).name)).not.toContain(
        "link.preview",
      );
    });

    it("sends the message even when the preview job cannot be queued", async () => {
      const enqueue = vi.fn(async (job: { name: string }) => {
        if (job.name === "link.preview") throw new Error("queue closed");
      });
      const { send } = sendHarness(enqueue as never);

      await expect(send({})).resolves.toBeDefined();
    });
  });

  it("rejects a new bot message while a run is waiting on a secret ask", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn().mockResolvedValue({ nextMessageSeq: 2 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "my password is hunter2" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({
          id: "ask-msg-1",
          blocks: [
            {
              kind: "ask",
              text: "Enter your one-time code",
              input: "secret",
              purpose: "otp",
              status: "pending",
            },
          ],
        }),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-waiting", taskId: "task-1", status: "waiting_input" }]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn() },
      task: { create: vi.fn(), updateMany: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn() } as never,
          jobs: { enqueue: vi.fn() } as never,
        },
        actor,
        target,
        { text: "my password is hunter2", clientNonce: "nonce-secret-bot" },
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Answer the pending ask first.",
    });
    // The composer text must never be routed into a secret write or steered onto the run.
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });

  it("resolves a pending ask_user with the composer text instead of refusing the message", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 2 })
          .mockResolvedValueOnce({ nextEventSeq: 3 })
          .mockResolvedValueOnce({ nextEventSeq: 4 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Lisbon, flexible dates" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn().mockResolvedValue({ id: "msg-1" }),
        findFirst: vi.fn().mockResolvedValue({
          id: "ask-msg-1",
          blocks: [{ kind: "ask", text: "Which city?", status: "pending", input: "text" }],
        }),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-waiting", taskId: "task-1", status: "waiting_input" }]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: new Date() }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn() },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValueOnce({ seq: 2 }).mockResolvedValueOnce({ seq: 3 }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "Lisbon, flexible dates",
          clientNonce: "nonce-ask",
        },
      ),
    ).resolves.toMatchObject({
      runId: "run-waiting",
      taskId: "task-1",
      runIds: ["run-waiting"],
    });

    // The card resolves in place — never a new run, never a steering message (threat model T6).
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-waiting",
        spaceId: "workspace-1",
        threadId: "thread-1",
        status: "waiting_input",
      },
      data: { status: "queued", checkpoint: null },
    });
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.run.findMany).toHaveBeenCalled();
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "msg-1" },
      data: { runId: "run-waiting" },
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
  });

  it("rejects the send when the bot has another active run beside the pending ask_user", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn().mockResolvedValue({ nextMessageSeq: 2 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Lisbon, flexible dates" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({
          id: "ask-msg-1",
          blocks: [{ kind: "ask", text: "Which city?", status: "pending", input: "text" }],
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-waiting", taskId: "task-1", status: "waiting_input" },
          { id: "run-takeover", taskId: "task-2", status: "waiting_takeover" },
        ]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: new Date() }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn() },
      task: { create: vi.fn(), updateMany: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn() } as never,
          jobs: { enqueue: vi.fn() } as never,
        },
        actor,
        target,
        { text: "Lisbon, flexible dates", clientNonce: "nonce-two-runs" },
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Answer the pending ask first.",
    });
    // The second run would be left neither steered nor rejected, so nothing may resolve.
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
  });

  it("carries the reply quote on the event that resolves a pending ask_user", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Lisbon" }],
          botId: null,
          replyToMessageId: "ask-msg-1",
          replyQuote: "Which city?",
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn().mockResolvedValue({ id: "msg-1" }),
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            id: "ask-msg-1",
            blocks: [{ kind: "text", text: "Which city?" }],
          })
          .mockResolvedValue({
            id: "ask-msg-1",
            blocks: [{ kind: "ask", text: "Which city?", status: "pending", input: "text" }],
          }),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-waiting", taskId: "task-1", status: "waiting_input" }]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: new Date() }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn() },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number } }) => ({
          ...data,
          id: `event-${data.seq}`,
        })),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        {
          text: "Lisbon",
          replyToMessageId: "ask-msg-1",
          replyQuote: "Which city?",
          clientNonce: "nonce-ask-quote",
        },
      ),
    ).resolves.toMatchObject({ runId: "run-waiting" });

    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.message.created",
        payload: expect.objectContaining({
          messageId: "msg-1",
          replyToMessageId: "ask-msg-1",
          replyQuote: "Which city?",
        }),
      }),
    });
  });

  it("resolves one bot's pending ask_user and steers another without a global throw", async () => {
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 2 })
          .mockResolvedValueOnce({ nextEventSeq: 3 })
          .mockResolvedValueOnce({ nextEventSeq: 4 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "@everyone Kyoto works, keep going" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn().mockResolvedValue({ id: "msg-1" }),
        findFirst: vi.fn().mockResolvedValue({
          id: "ask-msg-a",
          blocks: [{ kind: "ask", text: "Which city?", status: "pending", input: "text" }],
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-a-waiting", taskId: "task-a", botId: "bot-a", status: "waiting_input" },
          { id: "run-b-queued", taskId: "task-b", botId: "bot-b", status: "queued" },
        ]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-a" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: new Date() }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn(),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValueOnce({ seq: 2 }).mockResolvedValueOnce({ seq: 3 }),
      },
      steeringMessage: { create: vi.fn() },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      { text: "@everyone Kyoto works, keep going", clientNonce: "nonce-group-ask" },
    );

    // bot-a's ask resolves in place; bot-b, already queued, is steered — no CONFLICT anywhere.
    expect(result).toMatchObject({ runIds: ["run-a-waiting", "run-b-queued"] });
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-a-waiting",
        spaceId: "workspace-1",
        threadId: "thread-1",
        status: "waiting_input",
      },
      data: { status: "queued", checkpoint: null },
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-b", userId: "user-1", runId: "run-b-queued" },
    });
    // Never a steering row for the resolved ask (threat model T6).
    expect(tx.steeringMessage.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ botId: "bot-a" }) }),
    );
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "thread.message.created",
          payload: expect.objectContaining({ runIds: ["run-a-waiting", "run-b-queued"] }),
        }),
      }),
    );
  });

  it("throws CONFLICT for the whole group send when a targeted bot has a secret ask pending", async () => {
    const tx = {
      thread: { update: vi.fn().mockResolvedValueOnce({ nextMessageSeq: 2 }) },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "@everyone here's the code" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({
          id: "ask-msg-a",
          blocks: [{ kind: "ask", text: "Enter your code", input: "secret", status: "pending" }],
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-a-waiting", taskId: "task-a", botId: "bot-a", status: "waiting_input" },
          { id: "run-b-queued", taskId: "task-b", botId: "bot-b", status: "queued" },
        ]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-a" }),
        updateMany: vi.fn(),
        create: vi.fn(),
      },
      task: { create: vi.fn(), updateMany: vi.fn() },
      event: { create: vi.fn() },
      steeringMessage: { create: vi.fn() },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn(),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn() } as never,
          jobs: { enqueue: vi.fn() } as never,
        },
        actor,
        target,
        { text: "@everyone here's the code", clientNonce: "nonce-group-secret" },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "Answer the pending ask first." });

    // The whole send aborts: bot-b never gets steered, bot-a's run is never touched.
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("steers a waiting-takeover run instead of refusing the message", async () => {
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 2 })
          .mockResolvedValueOnce({ nextEventSeq: 3 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "skip that" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-waiting", taskId: "task-1", status: "waiting_takeover" }]),
        findUnique: vi.fn().mockResolvedValue({
          status: "waiting_takeover",
          startedAt: new Date(),
        }),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2 }) },
      task: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "skip that",
          clientNonce: "nonce-takeover",
        },
      ),
    ).resolves.toMatchObject({
      runId: "run-waiting",
      taskId: "task-1",
      seq: 1,
      runIds: ["run-waiting"],
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: "msg-1",
        botId: "bot-1",
        userId: "user-1",
        runId: "run-waiting",
      },
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
  });
  it("rejects a quote excerpt without a reply target", async () => {
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn() } as never,
          jobs: { enqueue: vi.fn() } as never,
        },
        actor,
        target,
        { text: "hi", replyQuote: "just this span", clientNonce: "nonce-1" },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("persists the quote excerpt alongside the reply target", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          blocks: [{ kind: "text", text: "the parent says just this span inside it" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: "just this span",
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "just this span",
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.findFirst).toHaveBeenCalledWith({
      where: { id: "parent", threadId: "thread-1" },
      select: { id: true, blocks: true },
    });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        replyToMessageId: "parent",
        replyQuote: "just this span",
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({ replyQuote: "just this span" }),
      }),
    });
  });

  it("drops a quote excerpt that doesn't match the parent's text", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          blocks: [{ kind: "text", text: "the parent says something else entirely" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: null,
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "words the parent never said",
        clientNonce: "nonce-1",
      },
    );

    // The send still lands as a plain reply — the fabricated excerpt is dropped.
    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        replyToMessageId: "parent",
        replyQuote: undefined,
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.not.objectContaining({ replyQuote: expect.anything() }),
      }),
    });
  });

  it("accepts a quote excerpt that matches formatted parent text", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          // Rendered as "42% growth", stored with markdown source.
          blocks: [{ kind: "text", text: "we saw **42%** growth last week" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: "42% growth",
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "42% growth",
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ replyQuote: "42% growth" }),
    });
  });

  it.each([
    ["table cells", "| Name | Value |\n|:-----|------:|\n| Alice | 5 |", "Alice 5"],
    ["indented code", "    2. restart()", "2. restart()"],
    ["fenced code", "```text\n2. restart()\n```", "2. restart()"],
    ["lists after code fences", "```text\n1. code\n```\n1. First\n2. Second", "First\nSecond"],
    ["tab-indented code", "\t2. restart()", "2. restart()"],
    ["three-space lists", "   1. First\n   2. Second", "First\nSecond"],
    [
      "ordered list items",
      "1. Review the diff\n2. Run the tests",
      "Review the diff\nRun the tests",
    ],
    [
      "parenthesized list items",
      "1) Review the diff\n2) Run the tests",
      "Review the diff\nRun the tests",
    ],
    [
      "quoted list items",
      "> 1. Review the diff\n> 2. Run the tests",
      "Review the diff\nRun the tests",
    ],
  ])("accepts a quote excerpt spanning rendered %s", async (_name, parentText, replyQuote) => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          blocks: [
            {
              kind: "text",
              text: parentText,
            },
          ],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote,
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote,
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ replyQuote }),
    });
  });

  it("drops a quote excerpt that only matches after stripping punctuation", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          blocks: [
            {
              kind: "text",
              text: "C++ is fast and key:value pairs; version 1.2 and 2. items\n    2. restart()\n```text\n1. alpha\n2. beta\n```\n~~~text\n1. gamma\n2. delta\n~~~\n```text\n> ```\n1. epsilon\n2. zeta\n```\n> ```text\n> > ```\n> 1. eta\n> 2. theta\n> ```\n# 1. heading\n# 2. another heading\n\n    > 1. literal\n    > 2. another literal",
            },
          ],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: null,
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    for (const replyQuote of [
      "C is fast",
      "key value pairs",
      "version 12",
      "and items",
      "3. restart()",
      "    3. restart()",
      "99. C++ is fast",
      "alpha\nbeta",
      "gamma\ndelta",
      "epsilon\nzeta",
      "eta\ntheta",
      "heading\nanother heading",
      "literal\nanother literal",
    ]) {
      await sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        { text: "why this?", replyToMessageId: "parent", replyQuote },
      );
    }

    for (const call of tx.message.create.mock.calls) {
      expect(call[0].data.replyQuote).toBeUndefined();
    }
  });

  it("persists the quote excerpt on a group send", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          blocks: [{ kind: "text", text: "the parent says just this span inside it" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: "just this span",
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi
          .fn()
          .mockResolvedValue({ id: "run-1", taskId: "task-1", botId: "bot-a", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "just this span",
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        replyToMessageId: "parent",
        replyQuote: "just this span",
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({ replyQuote: "just this span" }),
      }),
    });
  });
});

describe("stopThreadRuns", () => {
  it("snapshots every lease when group members share a team computer", async () => {
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    });
    const transaction = {
      $queryRaw: vi.fn(),
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-a", botId: "bot-a" },
          { id: "run-b", botId: "bot-b" },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: {
        // Production team ownership is lease-only: Computer.executionRunId stays null.
        findMany: vi.fn().mockImplementation(async ({ where }: { where: { OR?: unknown[] } }) => {
          expect(where.OR).toEqual(
            expect.arrayContaining([
              { id: { in: ["computer-db-team"] } },
              { executionRunId: { in: ["run-a", "run-b"] } },
            ]),
          );
          return [
            {
              id: "computer-db-team",
              homeKey: "home-team",
              kind: "fake",
              providerRef: "computer-team",
              executionBotId: null,
              executionRunId: null,
            },
          ];
        }),
      },
      computerExecutionLease: {
        findMany: vi.fn().mockResolvedValue([
          { computerId: "computer-db-team", botId: "bot-a", runId: "run-a", fence: 2 },
          { computerId: "computer-db-team", botId: "bot-b", runId: "run-b", fence: 4 },
        ]),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      bot: {
        update: vi.fn(async ({ where }: { where: { id: string } }) => ({
          spaceId: "workspace-1",
          thread: { id: `thread-of-${where.id}` },
          computer: { state: "running" },
        })),
      },
      // Simulate workers clearing leases / execution columns as soon as the
      // transaction commits. A post-commit lookup would now miss both sandboxes.
      computer: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computerExecutionLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      event: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaClient;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Test group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    const append = vi.fn().mockResolvedValue({});
    await stopThreadRuns(
      {
        prisma,
        sandbox: { releaseScreen, execute } as unknown as SandboxProvider,
        events: { append } as unknown as ThreadEvents,
      },
      actor,
      target,
    );

    expect(transaction.computerExecutionLease.findMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-a", "run-b"] } },
      select: { computerId: true, botId: true, runId: true, fence: true },
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-team", "run-a"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-a", botId: "bot-a" }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-team", "run-b"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-b", botId: "bot-b" }),
    );
    expect(releaseScreen).toHaveBeenCalledTimes(2);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-a",
        cancelRunWork: true,
        runId: "run-a",
        screenLeaseId: "run-a:2",
      }),
    );
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-b",
        cancelRunWork: true,
        runId: "run-b",
        screenLeaseId: "run-b:4",
      }),
    );
    expect(append.mock.calls).toEqual([
      [
        {
          spaceId: "workspace-1",
          threadId: "thread-of-bot-a",
          botId: "bot-a",
          type: "computer.status",
          payload: { status: "running" },
        },
      ],
      [
        {
          spaceId: "workspace-1",
          threadId: "thread-of-bot-b",
          botId: "bot-b",
          type: "computer.status",
          payload: { status: "running" },
        },
      ],
    ]);
    expect(prisma.computer.findMany).not.toHaveBeenCalled();
    expect(prisma.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-a", "run-b"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(prisma.computer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { executionRunId: { in: ["run-a", "run-b"] } } }),
    );
  });

  it("does not tear down a stale legacy execution run when the lease owns a cancelled run", async () => {
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    });
    const transaction = {
      $queryRaw: vi.fn(),
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-a", botId: "bot-a" }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: {
        // Selected via lease for cancelled run A, but legacy columns still name
        // unrelated live run B. Legacy teardown must not cancel/release B.
        findMany: vi.fn().mockResolvedValue([
          {
            id: "computer-db-a",
            homeKey: "home-a",
            kind: "fake",
            providerRef: "computer-a",
            executionBotId: "bot-b",
            executionRunId: "run-b",
          },
        ]),
      },
      computerExecutionLease: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { computerId: "computer-db-a", botId: "bot-a", runId: "run-a", fence: 2 },
          ]),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      bot: {
        update: vi.fn(async ({ where }: { where: { id: string } }) => ({
          spaceId: "workspace-1",
          thread: { id: `thread-of-${where.id}` },
          computer: { state: "running" },
        })),
      },
      computer: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computerExecutionLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      event: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaClient;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Test group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    const append = vi.fn().mockResolvedValue({});
    await stopThreadRuns(
      {
        prisma,
        sandbox: { releaseScreen, execute } as unknown as SandboxProvider,
        events: { append } as unknown as ThreadEvents,
      },
      actor,
      target,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-a" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-a", "run-a"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-a", botId: "bot-a" }),
    );
    expect(execute).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-a", "run-b"]),
      }),
      expect.anything(),
    );
    expect(releaseScreen).toHaveBeenCalledTimes(1);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-a" }),
      expect.objectContaining({
        botId: "bot-a",
        runId: "run-a",
        screenLeaseId: "run-a:2",
      }),
    );
    expect(releaseScreen).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: "run-b" }),
    );
  });
});

describe("sendThreadMessage while a proposal card waits", () => {
  const card = {
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
  function proposalTx(options: { kind?: string; runStatus?: string } = {}) {
    return {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: {
        update: vi.fn().mockResolvedValue({ nextMessageSeq: 2, nextEventSeq: 3 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Plutôt le mardi" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn().mockResolvedValue({ id: "msg-1" }),
        findFirst: vi.fn().mockResolvedValue({ id: "card-msg", blocks: [card] }),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-waiting", taskId: "task-1", status: "waiting_input" }]),
        findFirst: vi.fn().mockResolvedValue({
          botId: "bot-1",
          userId: "user-1",
          status: options.runStatus ?? "waiting_input",
        }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: new Date() }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      externalEffect: {
        findFirst: vi.fn().mockResolvedValue({
          id: "effect-1",
          kind: options.kind ?? "routine_proposal",
          status: "intended",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }) },
      task: { create: vi.fn(), updateMany: vi.fn() },
    };
  }
  const send = (tx: ReturnType<typeof proposalTx>) =>
    sendThreadMessage(
      {
        prisma: {
          message: { findUnique: vi.fn().mockResolvedValue(null) },
          $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
        } as unknown as PrismaClient,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      { spaceId: "workspace-1", userId: "user-1" } as Actor,
      {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget,
      { text: "Plutôt le mardi", clientNonce: "nonce-dismiss" },
    );

  it("puts the card away and steers the reply into the run it resumes", async () => {
    const tx = proposalTx();
    await expect(send(tx)).resolves.toMatchObject({
      runId: "run-waiting",
      runIds: ["run-waiting"],
    });
    expect(tx.externalEffect.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "denied" }) }),
    );
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-1", userId: "user-1", runId: "run-waiting" },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "msg-1" },
      data: { runId: "run-waiting" },
    });
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });

  it("steers the reply when a Create tap resumed the run first", async () => {
    const tx = proposalTx({ runStatus: "queued" });
    await expect(send(tx)).resolves.toMatchObject({ runIds: ["run-waiting"] });
    expect(tx.externalEffect.updateMany).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-1", userId: "user-1", runId: "run-waiting" },
    });
  });

  it("still asks to answer a Create bot card first", async () => {
    const tx = proposalTx({ kind: "spawn_bot" });
    await expect(send(tx)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Answer the pending ask first.",
    });
    expect(tx.externalEffect.updateMany).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
  });
});
