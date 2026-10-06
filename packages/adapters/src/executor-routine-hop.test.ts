import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it, vi } from "vitest";
import type * as AutoReviewModule from "./auto-review.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

vi.mock("./auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AutoReviewModule>()),
  resolveAutoReviewChecker: () => ({ provider: "scripted", model: "checker" }),
  isAutoReviewCheckerConfigured: () => true,
  runAutoReviewJudge: vi.fn(),
}));

type Effect = {
  id: string;
  runId?: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  reviewDecision?: string;
};

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  executionId: string;
};

type RunOverrides = {
  trigger?: string;
  sourceMessageId?: string | null;
  routineId?: string | null;
  /** Hop on the bot message that woke the run. */
  messageHop?: number;
  /** `inheritedHop` of the run's routine. */
  routineHop?: number | null;
  /** A schedule_create request the user already approved on its card. */
  approved?: Record<string, unknown>;
};

function fixture(overrides: RunOverrides = {}, runId = "run-1") {
  const effects: Effect[] = overrides.approved
    ? [
        {
          id: "effect-approved",
          runId,
          kind: "schedule_create",
          idempotencyKey: approvalEffectKey(runId, "schedule_create", overrides.approved),
          status: "approved",
          request: overrides.approved,
        },
      ]
    : [];
  const results: unknown[] = [];
  const run = {
    id: runId,
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: overrides.trigger ?? "user",
    sourceMessageId: overrides.sourceMessageId ?? null,
    routineId: overrides.routineId ?? null,
    leaseFence: 0,
  };
  const routineCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "routine-new",
    ...data,
    crons: data.crons,
  }));
  const memoryCommit = vi.fn(async () => ({ revision: "rev-1" }));
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
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string; status: string }; data: Partial<Effect> }) => {
        const effect = effects.find(
          (effect) => effect.id === where.id && effect.status === where.status,
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };
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
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
    message: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => ({
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-2",
            fromBotName: "B",
            text: "hi",
            hop: overrides.messageHop ?? 1,
          },
        ],
      })),
    },
    routine: {
      create: routineCreate,
      findUnique: vi.fn(async () => ({ inheritedHop: overrides.routineHop ?? null })),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Update shared state" })),
    },
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
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  let calls: ToolCall[] = [];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    for (const call of calls) {
      const result = await request.executeTool!(call.name, call.args, call.executionId);
      results.push(result);
    }
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: async () => ({ documents: [] }),
      search: async () => [],
      commit: memoryCommit,
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    effects,
    results,
    routineCreate,
    memoryCommit,
    setCalls(next: ToolCall[]) {
      calls = next;
    },
    async run() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(prisma.attempt.update).not.toHaveBeenCalled();
      expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    },
  };
}

const schedule = {
  name: "schedule_create",
  args: { name: "Check back", prompt: "Look again", every: 1, unit: "hours" },
  executionId: "call_0",
};

// A run another bot or a webhook woke creates a routine only once the user approved its card.
describe("schedule_create in a bot-to-bot chain", () => {
  it("stores one hop more than the message that woke the run", async () => {
    const f = fixture({
      trigger: "bot_message",
      sourceMessageId: "message-1",
      messageHop: 4,
      approved: schedule.args,
    });
    f.setCalls([schedule]);
    await f.run();

    expect(f.routineCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ inheritedHop: 5 }),
    });
    expect(f.results[0]).toMatchObject({ ok: true, routineId: "routine-new" });
  });

  it("keeps counting from the routine's own hop in a webhook wake", async () => {
    const f = fixture({
      trigger: "webhook",
      routineId: "routine-1",
      routineHop: 3,
      approved: schedule.args,
    });
    f.setCalls([schedule]);
    await f.run();

    expect(f.routineCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ inheritedHop: 4 }),
    });
  });

  it("refuses at the chain limit and creates nothing", async () => {
    const f = fixture({
      trigger: "bot_message",
      sourceMessageId: "message-1",
      messageHop: 6,
      approved: schedule.args,
    });
    f.setCalls([schedule]);
    await f.run();

    expect(f.results[0]).toEqual({
      error: "bot-to-bot chain limit reached; ask the user to set up this routine",
    });
    expect(f.routineCreate).not.toHaveBeenCalled();
  });

  it("leaves the hop empty in a run a person started", async () => {
    const f = fixture();
    f.setCalls([schedule]);
    await f.run();

    expect(f.routineCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ inheritedHop: null }),
    });
  });
});
