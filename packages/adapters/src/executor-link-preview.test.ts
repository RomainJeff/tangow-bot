import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import type { FakeWebProvider } from "./fake-web.js";
import { recordingSessionLog } from "./session-log/recording.test-support.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  holdComputerExecutionLeaseForTakeover: async () => true,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

/**
 * When a bot run ends, the executor queues one `link.preview` job for it. This harness is modelled
 * on routine-run-card.test.ts (prisma/message/event plumbing) and executor-effect-idempotency.test.ts
 * (the approval and effect lookups every `applyTool` call walks through).
 */
type StoredMessage = {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: MessageBlock[];
  botId: string | null;
  runId: string | null;
  clientNonce: string | null;
};

type ThreadMessage = {
  id: string;
  seq: number;
  role: string;
  runId: string | null;
  blocks: MessageBlock[];
  replyToMessageId?: string | null;
};

type StoredEffect = {
  id: string;
  runId?: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  reviewDecision?: string;
};

function fixture({
  trigger = "user",
  parentBotId = null as string | null,
  routineId = null as string | null,
  routineNotify = false,
  crons = ["0 9 * * *"],
  clientNonce = null as string | null,
  groupId = null as string | null,
  requireToolApproval = true,
  chattyReplies = false,
  secrets = [] as string[],
  checkpoint = null as string | null,
  status = "queued",
  priorMessages = [] as Array<{ blocks: MessageBlock[]; clientNonce: string | null }>,
  threadMessages = [] as ThreadMessage[],
  steering = [] as Array<{ id: string; messageId: string; text: string; blocks: MessageBlock[] }>,
  web,
  runtimeRun,
}: {
  trigger?: string;
  parentBotId?: string | null;
  routineId?: string | null;
  routineNotify?: boolean;
  crons?: string[];
  clientNonce?: string | null;
  groupId?: string | null;
  requireToolApproval?: boolean;
  chattyReplies?: boolean;
  secrets?: string[];
  checkpoint?: string | null;
  status?: string;
  priorMessages?: Array<{ blocks: MessageBlock[]; clientNonce: string | null }>;
  /** The thread history window, newest first (what the executor loads for a user turn). */
  threadMessages?: ThreadMessage[];
  /** User messages waiting to be steered into the run: handed out by the first claim. */
  steering?: Array<{ id: string; messageId: string; text: string; blocks: MessageBlock[] }>;
  web?: FakeWebProvider;
  runtimeRun: (request: AgentRunRequest) => AsyncGenerator<AgentRuntimeEvent>;
}) {
  const messages: StoredMessage[] = [];
  let messageSeq = 0;
  let nextMessageSeq = 0;
  let nextEventSeq = 0;
  // Whether anything written during the run marked the thread unread (a bot message does by default).
  let threadUnread = false;

  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status,
    trigger,
    routineId,
    clientNonce,
    requireToolApproval,
    leaseFence: 0,
    checkpoint,
  };

  const finalizeRun = vi.fn(
    async ({
      outcome,
    }: {
      outcome: "completed" | "failed";
      blocks?: MessageBlock[];
      markUnread?: boolean;
    }) => {
      run.status = outcome;
      return { continuationRunId: null };
    },
  );

  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });

  const pauseRunForTakeover = vi.fn(async (_input: { reason: string }) => {
    run.status = "waiting_takeover";
    return true;
  });

  const effects: StoredEffect[] = [];
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: { id?: string; runId?: string; status?: string; kind?: string };
      } = {}) =>
        effects.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (where?.kind && effect.kind !== where.kind) return false;
          if (where?.runId && effect.runId && effect.runId !== where.runId) return false;
          if (where?.id && effect.id !== where.id) return false;
          return true;
        }),
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<StoredEffect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Partial<StoredEffect> }) => {
        Object.assign(effects.find((effect) => effect.id === where.id)!, data);
      },
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: Partial<StoredEffect>;
      }) => {
        const effect = effects.find(
          (effect) => effect.id === where.id && effect.status === where.status,
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };

  const bubbleQueries: unknown[] = [];
  const messageCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    messageSeq += 1;
    const message: StoredMessage = {
      id: `message-${messageSeq}`,
      threadId: data.threadId as string,
      seq: nextMessageSeq,
      role: data.role as string,
      blocks: data.blocks as MessageBlock[],
      botId: (data.botId as string) ?? null,
      runId: (data.runId as string) ?? null,
      clientNonce: (data.clientNonce as string) ?? null,
    };
    messages.push(message);
    return message;
  });

  const log = recordingSessionLog();

  const prisma = {
    sessionEntry: log.sessionEntry,
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => ({
        bot: { notifyOnFinish: true },
        thread: { groupId },
      })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        parentBotId,
        chattyReplies,
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    user: { findUnique: vi.fn(async () => null) },
    routine: {
      findUnique: vi.fn(async () =>
        routineId ? { id: routineId, name: "Routine", notify: routineNotify, crons } : null,
      ),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId })),
      findFirst: vi.fn(async () => ({ groupId })),
      count: vi.fn(async () => 0),
      update: vi.fn(
        async ({
          data,
        }: {
          data: { nextMessageSeq?: unknown; nextEventSeq?: unknown; unread?: boolean };
        }) => {
          if (data.unread) threadUnread = true;
          if (data.nextMessageSeq !== undefined) nextMessageSeq += 1;
          if (data.nextEventSeq !== undefined) nextEventSeq += 1;
          return { nextMessageSeq, nextEventSeq };
        },
      ),
    },
    message: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where?: { runId?: string; clientNonce?: { startsWith: string } };
        } = {}) => {
          // The end-of-run lookup of delivered bubbles: this run's bot messages by nonce prefix,
          // earlier attempts' (priorMessages) and this attempt's alike.
          if (where?.runId && where.clientNonce) {
            bubbleQueries.push({ where });
            return [
              ...priorMessages,
              ...messages.filter((message) => message.runId === where.runId),
            ].filter(
              (message) => message.clientNonce?.startsWith(where.clientNonce!.startsWith) ?? false,
            );
          }
          return where?.runId ? priorMessages : threadMessages;
        },
      ),
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { id?: string; threadId_clientNonce?: { clientNonce: string } };
        }) => {
          if (where.id) return messages.find((message) => message.id === where.id) ?? null;
          if (where.threadId_clientNonce) {
            return (
              messages.find(
                (message) => message.clientNonce === where.threadId_clientNonce!.clientNonce,
              ) ?? null
            );
          }
          return null;
        },
      ),
      create: messageCreate,
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { blocks: MessageBlock[] } }) => {
          const message = messages.find((candidate) => candidate.id === where.id);
          if (message) message.blocks = data.blocks;
          return message;
        },
      ),
    },
    chatGroup: {
      findUnique: vi.fn(async () => ({
        id: groupId,
        name: "Crew",
        description: "",
        members: [],
      })),
    },
    chatGroupMember: { findMany: vi.fn(async () => []) },
    event: { create: vi.fn(async () => ({ id: "event-1" })) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Help the user" })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    skillSetting: { findMany: vi.fn(async () => []) },
    botSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect,
    // The routine card update takes the thread lock before rewriting the card.
    $queryRaw: vi.fn(async () => []),
  };
  (prisma as unknown as { $transaction: unknown }).$transaction = vi.fn(
    async (fn: (tx: typeof prisma) => unknown) => fn(prisma),
  );

  const append = vi.fn(async (_event: { type: string }) => undefined);
  const notify = vi.fn(async () => undefined);
  const send = vi.fn(async (_message: { kind: string; title: string; body: string }) => undefined);
  const enqueue = vi.fn(async (_job?: { name: string }) => undefined);
  const executor = createRunExecutor({
    sessionLog: log.sessionLog,
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: {
      append,
      claimSteering: vi.fn(async () => steering.splice(0)),
      finalizeRun,
      notify,
      pauseRunForInput,
      pauseRunForTakeover,
    },
    jobs: { enqueue },
    notifications: { send },
    secrets,
    web,
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    runRow: run,
    enqueue,
    /** The lookups of delivered message_user bubbles at the end of a run. */
    bubbleQueries,
    /** Events appended to the thread (progress, tool calls, ...). */
    appended: append,
    /** Push notifications sent to the user. */
    pushes: send,
    messages,
    /** True once a message written during the run marked the thread unread. */
    threadUnread: () => threadUnread,
    finalizeRun,
    pauseRunForInput,
    pauseRunForTakeover,
    messageCreate,
    async run() {
      await executor.continueRun(run.id, "worker-1");
    },
  };
}

describe("link previews of a run (CA 13, CA 14, CA 70, CA 72)", () => {
  const previewJobs = (f: ReturnType<typeof fixture>) =>
    (f.enqueue.mock.calls as unknown as Array<[{ name: string; payload: unknown }]>)
      .map(([job]) => job)
      .filter((job) => job.name === "link.preview");

  it("queues one link.preview job, by run id, after a completed run", async () => {
    const f = fixture({
      trigger: "user",
      async *runtimeRun() {
        yield { type: "text", text: "Done: https://example.test/a" };
        yield { type: "done" };
      },
    });

    await f.run();

    expect(previewJobs(f)).toEqual([
      expect.objectContaining({
        name: "link.preview",
        payload: { runId: "run-1" },
        maxAttempts: 1,
      }),
    ]);
    // After the commit: finalizeRun has already returned.
    expect(f.finalizeRun.mock.invocationCallOrder[0]!).toBeLessThan(
      f.enqueue.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("pushes a finished reply's words without its markdown", async () => {
    const f = fixture({
      trigger: "user",
      async *runtimeRun() {
        yield { type: "text", text: "**Done**: see [the report](https://example.test/a)" };
        yield { type: "done" };
      },
    });

    await f.run();

    expect(f.pushes.mock.calls.map(([message]) => message.body)).toEqual(["Done: see the report"]);
  });

  it("pushes nothing for a finished reply with no words, but still pushes its failure", async () => {
    const image = "![](https://example.test/a.png)";
    const finished = fixture({
      trigger: "user",
      async *runtimeRun() {
        yield { type: "text", text: image };
        yield { type: "done" };
      },
    });
    const failed = fixture({
      trigger: "user",
      async *runtimeRun() {
        yield { type: "text", text: image };
        throw new Error("model exploded");
      },
    });

    await finished.run();
    await failed.run();

    expect(finished.pushes.mock.calls.map(([message]) => message.body)).toEqual([]);
    expect(failed.pushes.mock.calls.map(([message]) => message.body)).toEqual(["model exploded"]);
  });

  it.each([
    ["a bot-to-bot run", { trigger: "bot_message" }],
    ["a routine card run", { trigger: "routine", routineId: "routine-1", parentBotId: "bot-0" }],
  ])("queues nothing for %s", async (_name, options) => {
    const f = fixture({
      ...options,
      async *runtimeRun() {
        yield { type: "text", text: "Done: https://example.test/a" };
        yield { type: "done" };
      },
    });

    await f.run();

    expect(previewJobs(f)).toEqual([]);
  });

  it("queues nothing for a run that failed", async () => {
    const f = fixture({
      trigger: "user",
      async *runtimeRun() {
        yield { type: "text", text: "Done: https://example.test/a" };
        throw new Error("model exploded");
      },
    });

    await f.run();

    expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    expect(previewJobs(f)).toEqual([]);
  });

  it("keeps no URL or hash in the audit event of a finished tool call (CA 72)", async () => {
    const f = fixture({
      trigger: "user",
      async *runtimeRun(request) {
        const page = {
          content: [{ type: "text", text: "see https://b.test/y" }],
          details: { url: "https://final.test/z", results: [{ url: "https://hit.test/a" }] },
        };
        for (const name of ["web_fetch", "web_search", "browser_navigate"]) {
          await request.onToolCompleted?.({
            name,
            executionId: name,
            durationMs: 3,
            result: page,
          });
        }
        yield { type: "text", text: "Done: https://example.test/a" };
        yield { type: "done" };
      },
    });

    await f.run();

    const payloads = (
      f.appended.mock.calls as unknown as Array<[{ type: string; payload: unknown }]>
    )
      .map(([event]) => event)
      .filter((event) => event.type === "agent.tool.completed")
      .map((event) => event.payload);
    expect(payloads).toHaveLength(3);
    expect(JSON.stringify(payloads)).not.toMatch(/https?:|openedUrl|seenUrlHashes|[0-9a-f]{64}/);
  });
});
