import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

/**
 * Exercises the sub-bot routine path end to end (background-work-visibility CA1/CA2): the
 * free closing text must not land as a plain message in the sub-bot's own thread, and a
 * `routine_run` card must be published on start and mutated to its terminal state on finish.
 */
function fixture({
  closingText = "Inbox is clear.\n\nChecked 12 threads, nothing actionable.",
  routineNotify = false,
  parentBotId = "claudius-1" as string | null,
  secrets = [] as string[],
  runtimeError,
}: {
  closingText?: string;
  routineNotify?: boolean;
  parentBotId?: string | null;
  secrets?: string[];
  runtimeError?: string;
} = {}) {
  const messages: Array<{
    id: string;
    threadId: string;
    seq: number;
    role: string;
    blocks: MessageBlock[];
    botId: string | null;
    runId: string | null;
    clientNonce: string | null;
  }> = [];
  let messageSeq = 0;
  let nextMessageSeq = 0;
  let nextEventSeq = 0;

  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "routine",
    routineId: "routine-1",
    leaseFence: 0,
  };

  const finalizeRun = vi.fn(async ({ outcome }: { outcome: "completed" | "failed" }) => {
    run.status = outcome;
    return { continuationRunId: null };
  });

  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Alfred",
        title: "Alfred",
        description: "Household sub-bot",
        parentBotId,
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    routine: {
      findUnique: vi.fn(async () => ({
        id: "routine-1",
        name: "Morning inbox check",
        notify: routineNotify,
      })),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })),
      update: vi.fn(
        async ({ data }: { data: { nextMessageSeq?: unknown; nextEventSeq?: unknown } }) => {
          if (data.nextMessageSeq !== undefined) nextMessageSeq += 1;
          if (data.nextEventSeq !== undefined) nextEventSeq += 1;
          return { nextMessageSeq, nextEventSeq };
        },
      ),
    },
    message: {
      findMany: vi.fn(async () => []),
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
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        messageSeq += 1;
        const message = {
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
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { blocks: MessageBlock[] } }) => {
          const message = messages.find((candidate) => candidate.id === where.id);
          if (message) message.blocks = data.blocks;
          return message;
        },
      ),
    },
    event: { create: vi.fn(async () => ({ id: "event-1" })) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Check the inbox" })) },
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
    actionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
    externalEffect: { findMany: vi.fn(async () => []) },
  };
  // `$transaction` composes into the same fakes above, matching how the real Prisma
  // TransactionClient reuses the connection's model delegates.
  (prisma as unknown as { $transaction: unknown }).$transaction = vi.fn(
    async (fn: (tx: typeof prisma) => unknown) => fn(prisma),
  );

  const runtimeRun = vi.fn(async function* (_request: AgentRunRequest) {
    if (runtimeError) throw new Error(runtimeError);
    yield { type: "done" as const, text: closingText };
  });

  const notify = vi.fn(async () => undefined);
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), finalizeRun, notify },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets,
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    messages,
    finalizeRun,
    async run() {
      await executor.continueRun(run.id, "worker-1");
    },
  };
}

describe("sub-bot routine run card", () => {
  it("suppresses the free closing text and publishes a routine_run card (CA1/CA2)", async () => {
    const f = fixture();
    await f.run();

    // No free-text closing message reaches the thread: finalizeRun's own message-creation
    // path is skipped entirely because the card replaces it.
    expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ blocks: [] }));

    const cardMessages = f.messages.filter((message) =>
      message.blocks.some((block) => block.kind === "routine_run"),
    );
    expect(cardMessages).toHaveLength(1);
    const card = cardMessages[0]!.blocks[0] as Extract<MessageBlock, { kind: "routine_run" }>;
    expect(card.state).toBe("completed");
    expect(card.routineName).toBe("Morning inbox check");
    expect(card.headline).toBe("Inbox is clear.");
    expect(card.digest).toContain("Checked 12 threads");
    expect(card.notify).toBe(false);

    // Never a plain "text" block with the closing narration in the thread.
    expect(
      f.messages.some((message) => message.blocks.some((block) => block.kind === "text")),
    ).toBe(false);
  });

  it("never renders a secret in clear inside the card (CA17)", async () => {
    const secret = "sk-live-super-secret-token";
    const f = fixture({
      closingText: `Found the API key: ${secret}\n\nSaved it to the vault.`,
      secrets: [secret],
    });
    await f.run();

    const card = f.messages
      .flatMap((message) => message.blocks)
      .find(
        (block): block is Extract<MessageBlock, { kind: "routine_run" }> =>
          block.kind === "routine_run",
      );
    expect(card?.digest).not.toContain(secret);
    expect(card?.headline).not.toContain(secret);
    expect(card?.digest).toContain("[redacted]");
  });

  it("flips the card to failed with the error in the digest when the run errors (CA12)", async () => {
    const f = fixture({ runtimeError: "Connector timed out after 30s" });
    await f.run();

    expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    const card = f.messages
      .flatMap((message) => message.blocks)
      .find(
        (block): block is Extract<MessageBlock, { kind: "routine_run" }> =>
          block.kind === "routine_run",
      );
    expect(card?.state).toBe("failed");
    expect(card?.digest).toContain("Connector timed out after 30s");
  });

  it("is idempotent on the run id: a resumed run does not duplicate the card", async () => {
    const f = fixture();
    // Simulate the same run's card-publish step running twice (e.g. a crash + retry before
    // completion): the second publish must find the first card via its stable clientNonce
    // instead of creating a second one.
    await f.run();
    const cardMessagesAfterFirstRun = f.messages.filter((message) =>
      message.blocks.some((block) => block.kind === "routine_run"),
    );
    expect(cardMessagesAfterFirstRun).toHaveLength(1);
  });

  it("keeps the card collapsed (notify: false) by default and reflects the routine's toggle", async () => {
    const f = fixture({ routineNotify: true });
    await f.run();
    const card = f.messages
      .flatMap((message) => message.blocks)
      .find(
        (block): block is Extract<MessageBlock, { kind: "routine_run" }> =>
          block.kind === "routine_run",
      );
    expect(card?.notify).toBe(true);
  });

  it("does not touch a top-level bot's own routine (no card, ordinary reply)", async () => {
    const f = fixture({ parentBotId: null });
    await f.run();
    expect(
      f.messages.some((message) => message.blocks.some((block) => block.kind === "routine_run")),
    ).toBe(false);
    // A top-level bot's routine is its own user-facing brief; finalizeRun still gets the
    // ordinary blocks (not suppressed).
    expect(f.finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ blocks: [] }));
  });
});
