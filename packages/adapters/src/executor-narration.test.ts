import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { TOOL_FINAL_RESPONSE_FALLBACK } from "./user-progress.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  holdComputerExecutionLeaseForTakeover: async () => true,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

/**
 * Transient narration: the executor no longer promotes text streamed alongside a tool call
 * ("I'll check the calendar…") into a durable `user-progress:` message at the moment of the
 * tool call. It is set aside instead, then either dropped (the run answered, or may legitimately
 * stay silent) or published just before a pause card / at the very end of an unanswered,
 * non-silent run.
 *
 * This harness is modelled on routine-run-card.test.ts (prisma/message/event plumbing) and
 * executor-effect-idempotency.test.ts (the actionApprovalRule/actionAutoReviewPreference/
 * externalEffect trio that every `applyTool` call walks through, even for a non-mutating
 * built-in like `message_user`).
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
  checkpoint = null as string | null,
  status = "queued",
  priorMessages = [] as Array<{ blocks: MessageBlock[]; clientNonce: string | null }>,
  runtimeRun,
}: {
  trigger?: string;
  parentBotId?: string | null;
  routineId?: string | null;
  routineNotify?: boolean;
  checkpoint?: string | null;
  status?: string;
  priorMessages?: Array<{ blocks: MessageBlock[]; clientNonce: string | null }>;
  runtimeRun: (request: AgentRunRequest) => AsyncGenerator<AgentRuntimeEvent>;
}) {
  const messages: StoredMessage[] = [];
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
    status,
    trigger,
    routineId,
    leaseFence: 0,
    checkpoint,
  };

  const finalizeRun = vi.fn(
    async ({ outcome }: { outcome: "completed" | "failed"; blocks?: MessageBlock[] }) => {
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
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        parentBotId,
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    routine: {
      findUnique: vi.fn(async () =>
        routineId ? { id: routineId, name: "Routine", notify: routineNotify } : null,
      ),
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
      findMany: vi.fn(async ({ where }: { where?: { runId?: string } } = {}) =>
        where?.runId ? priorMessages : [],
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
  };
  (prisma as unknown as { $transaction: unknown }).$transaction = vi.fn(
    async (fn: (tx: typeof prisma) => unknown) => fn(prisma),
  );

  const notify = vi.fn(async () => undefined);
  const enqueue = vi.fn(async () => undefined);
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: {
      append: vi.fn(async () => undefined),
      finalizeRun,
      notify,
      pauseRunForInput,
      pauseRunForTakeover,
    },
    jobs: { enqueue },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    runRow: run,
    enqueue,
    messages,
    finalizeRun,
    pauseRunForInput,
    pauseRunForTakeover,
    messageCreate,
    async run() {
      await executor.continueRun(run.id, "worker-1");
    },
  };
}

/** All published-message client nonces carrying narration, in publish order. */
function userProgressTexts(messages: StoredMessage[]): string[] {
  return messages
    .filter((message) => message.clientNonce?.startsWith("user-progress:"))
    .flatMap((message) => message.blocks)
    .filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text);
}

function userMessageTexts(messages: StoredMessage[]): string[] {
  return messages
    .filter((message) => message.clientNonce?.startsWith("user-message:"))
    .flatMap((message) => message.blocks)
    .filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text);
}

function finalText(blocks: MessageBlock[]): string {
  return blocks
    .filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("");
}

describe("transient narration", () => {
  it("CA1: a user-triggered run that narrates, calls a tool, then answers posts no user-progress message and keeps the narration out of the final reply", async () => {
    const f = fixture({
      trigger: "user",
      async *runtimeRun() {
        yield { type: "text", text: "I'll check the calendar for you..." };
        yield { type: "tool", name: "check_calendar", args: {}, executionId: "call-1" };
        yield { type: "text", text: "You have 3 meetings today." };
        yield { type: "done" };
      },
    });

    await f.run();

    expect(userProgressTexts(f.messages)).toEqual([]);
    expect(f.finalizeRun).toHaveBeenCalledOnce();
    const blocks = f.finalizeRun.mock.calls[0]![0].blocks ?? [];
    const text = finalText(blocks);
    expect(text).toBe("You have 3 meetings today.");
    expect(text).not.toContain("I'll check the calendar");
  });

  it("CA2: a run that narrates, calls a tool, then replies only via message_user bubbles posts no user-progress message, only the bubble", async () => {
    const f = fixture({
      trigger: "user",
      async *runtimeRun(request) {
        yield { type: "text", text: "Let me look that up..." };
        yield { type: "tool", name: "lookup_thing", args: {}, executionId: "call-1" };
        await request.executeTool!("message_user", { message: "Here you go!" }, "call-2");
        yield { type: "done" };
      },
    });

    await f.run();

    expect(userProgressTexts(f.messages)).toEqual([]);
    expect(userMessageTexts(f.messages)).toEqual(["Here you go!"]);
    expect(f.finalizeRun).toHaveBeenCalledOnce();
    const blocks = f.finalizeRun.mock.calls[0]![0].blocks ?? [];
    expect(finalText(blocks)).toBe("");
  });

  it("CA3: a run that narrates then asks the user publishes the held narration as user-progress before the ask card", async () => {
    const f = fixture({
      trigger: "user",
      async *runtimeRun() {
        yield { type: "text", text: "I'll check available slots first..." };
        yield { type: "tool", name: "ask_user", args: {}, executionId: "call-1" };
        yield { type: "ask", text: "Which time works for you?" };
      },
    });

    await f.run();

    expect(userProgressTexts(f.messages)).toEqual(["I'll check available slots first..."]);
    expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    // The narration message was created before the run paused for the user's answer, so the
    // context for the question is already on screen when the ask card lands.
    const narrationCallOrder = f.messageCreate.mock.invocationCallOrder[0]!;
    const pauseCallOrder = f.pauseRunForInput.mock.invocationCallOrder[0]!;
    expect(narrationCallOrder).toBeLessThan(pauseCallOrder);
  });

  it("CA4: the bot's own routine run that narrates, calls a tool, and finishes in silence creates no message at all", async () => {
    const f = fixture({
      trigger: "routine",
      parentBotId: null,
      async *runtimeRun() {
        yield { type: "text", text: "Checking on things..." };
        yield { type: "tool", name: "check_things", args: {}, executionId: "call-1" };
        yield { type: "done" };
      },
    });

    await f.run();

    expect(f.messages).toEqual([]);
    expect(f.finalizeRun).toHaveBeenCalledOnce();
    const blocks = f.finalizeRun.mock.calls[0]![0].blocks ?? [];
    expect(finalText(blocks)).toBe("");
    expect(finalText(blocks)).not.toContain("done.");
  });

  it("CA9: a user run that only calls tools and ends without any text still finalizes with the missing-reply notice", async () => {
    const f = fixture({
      trigger: "user",
      async *runtimeRun() {
        yield { type: "tool", name: "check_things", args: {}, executionId: "call-1" };
        yield { type: "done" };
      },
    });

    await f.run();

    expect(f.finalizeRun).toHaveBeenCalledOnce();
    const blocks = f.finalizeRun.mock.calls[0]![0].blocks ?? [];
    expect(blocks.some((block) => block.kind === "steps")).toBe(true);
    expect(finalText(blocks)).toBe(TOOL_FINAL_RESPONSE_FALLBACK);
  });

  it("CA5: a run not allowed to stay silent that narrates, calls a tool, and gets only the runtime's missing-reply fallback publishes the narration and still posts the fallback", async () => {
    const f = fixture({
      trigger: "user",
      async *runtimeRun() {
        yield { type: "text", text: "Digging into this..." };
        yield { type: "tool", name: "dig_in", args: {}, executionId: "call-1" };
        yield { type: "text", text: TOOL_FINAL_RESPONSE_FALLBACK };
        yield { type: "done", text: TOOL_FINAL_RESPONSE_FALLBACK };
      },
    });

    await f.run();

    expect(userProgressTexts(f.messages)).toEqual(["Digging into this..."]);
    expect(f.finalizeRun).toHaveBeenCalledOnce();
    const blocks = f.finalizeRun.mock.calls[0]![0].blocks ?? [];
    expect(finalText(blocks)).toBe(TOOL_FINAL_RESPONSE_FALLBACK);
  });

  it("CA8: narration set aside during the run is never restored from the runtime's cumulative done.text", async () => {
    // A sub-bot routine run's own card digest is built from `text`/`assembled`, so a leak here
    // is directly observable: the digest would carry the narration prefix instead of staying
    // clean. Narration before a tool call, then no further streamed text — only the runtime's
    // final `done` event, whose `text` is cumulative (narration + whatever came after) the way
    // some providers report a turn's full text instead of incremental deltas.
    const f = fixture({
      trigger: "routine",
      parentBotId: "parent-bot-1",
      routineId: "routine-1",
      async *runtimeRun() {
        yield { type: "text", text: "Looking into it..." };
        yield { type: "tool", name: "some_tool", args: {}, executionId: "call-1" };
        yield { type: "done", text: "Looking into it...All set, done!" };
      },
    });

    await f.run();

    const card = f.messages
      .flatMap((message) => message.blocks)
      .find(
        (block): block is Extract<MessageBlock, { kind: "routine_run" }> =>
          block.kind === "routine_run",
      );
    expect(card).toBeDefined();
    expect(card?.digest ?? "").not.toContain("Looking into it");
    expect(card?.headline ?? "").not.toContain("Looking into it");
  });

  it("CT0: a takeover publishes the attempt's tool steps with the pause card so a resume can replay them", async () => {
    const f = fixture({
      trigger: "user",
      async *runtimeRun(request) {
        yield {
          type: "tool",
          name: "check_things",
          args: { page: "login" },
          executionId: "call-1",
        };
        yield {
          type: "tool",
          name: "request_takeover",
          args: { reason: "Enter the code" },
          executionId: "call-2",
        };
        await request.executeTool!("request_takeover", { reason: "Enter the code" }, "call-2");
        yield { type: "takeover", reason: "Enter the code" };
      },
    });

    await f.run();

    expect(f.pauseRunForTakeover).toHaveBeenCalledOnce();
    expect(f.finalizeRun).not.toHaveBeenCalled();
    const blocks = f.messages.at(-1)!.blocks;
    expect(blocks.map((block) => block.kind)).toEqual(["steps", "computer"]);
    const steps = blocks[0] as Extract<MessageBlock, { kind: "steps" }>;
    const calls = steps.steps.flatMap((step) => step.calls ?? []);
    expect(calls.map((call) => call.id)).toEqual(["call-1", "call-2"]);
    expect(blocks[1]).toEqual({ kind: "computer", state: "Needs you", text: "Enter the code" });
  });

  it("CT1: a run resumed after takeover quotes why the screen was handed over and asks the bot to observe first", async () => {
    let prompt = "";
    const f = fixture({
      trigger: "user",
      checkpoint: "takeover",
      priorMessages: [
        {
          blocks: [{ kind: "computer", state: "Needs you", text: "Enter the 2FA code" }],
          clientNonce: null,
        },
      ],
      async *runtimeRun(request) {
        prompt = request.prompt;
        yield { type: "text", text: "Continuing." };
        yield { type: "done" };
      },
    });

    await f.run();

    expect(prompt).toContain('because: "Enter the 2FA code"');
    expect(prompt).toContain("observe the screen");
  });

  it("CT2: an expired takeover resumes with the ask-if-unsure note", async () => {
    let prompt = "";
    const f = fixture({
      trigger: "user",
      checkpoint: "takeover-expired",
      async *runtimeRun(request) {
        prompt = request.prompt;
        yield { type: "text", text: "Continuing." };
        yield { type: "done" };
      },
    });

    await f.run();

    expect(prompt).toContain("ask the user whether they finished");
    expect(prompt).not.toContain("because:");
  });

  const pickTheLink: Array<{ blocks: MessageBlock[]; clientNonce: string | null }> = [
    {
      blocks: [{ kind: "computer", state: "Needs you", text: "Pick the link" }],
      clientNonce: null,
    },
  ];

  it("CT3: a message sent while the user holds the screen is answered, then the run keeps waiting", async () => {
    let prompt = "";
    const f = fixture({
      trigger: "user",
      status: "waiting_takeover",
      priorMessages: pickTheLink,
      async *runtimeRun(request) {
        prompt = request.prompt;
        yield { type: "text", text: "It shows GTA." };
        yield { type: "done" };
      },
    });

    await f.run();

    expect(prompt).toContain("wrote their latest message from there");
    expect(prompt).toContain('because: "Pick the link"');
    expect(f.finalizeRun).not.toHaveBeenCalled();
    expect(f.pauseRunForTakeover).toHaveBeenCalledOnce();
    expect(f.pauseRunForTakeover.mock.calls[0]![0]).toMatchObject({ reason: "Pick the link" });
    expect(finalText(f.messages.at(-1)!.blocks)).toBe("It shows GTA.");
    expect(f.runRow.status).toBe("waiting_takeover");
  });

  it("CT4: an I'm done that lands while the held run answers resumes the task instead of waiting again", async () => {
    const f: ReturnType<typeof fixture> = fixture({
      trigger: "user",
      status: "waiting_takeover",
      priorMessages: pickTheLink,
      async *runtimeRun() {
        yield { type: "text", text: "It shows GTA." };
        f.runRow.checkpoint = "takeover";
        yield { type: "done" };
      },
    });

    await f.run();

    expect(f.pauseRunForTakeover).not.toHaveBeenCalled();
    expect(f.finalizeRun).not.toHaveBeenCalled();
    expect(f.enqueue).toHaveBeenCalled();
    expect(f.runRow.status).toBe("queued");
    expect(f.runRow.checkpoint).toBe("takeover");
  });
});
