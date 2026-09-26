import type { AgentRunRequest } from "@rakazo/adapter-kit";
import {
  legacyScopedToolEffectIdempotencyKey,
  toolEffectIdempotencyKey,
} from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it, vi } from "vitest";
import type * as AutoReviewModule from "./auto-review.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import type * as MemoryManagementModule from "./memory-management-tools.js";
import { runMemoryManagementTool } from "./memory-management-tools.js";
import { MemoryClassificationConsentRequired } from "./memory-method-classification.js";

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

vi.mock("./memory-management-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MemoryManagementModule>()),
  runMemoryManagementTool: vi.fn(async () => ({ ok: true })),
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

function fixture(runId = "run-1", options: { trigger?: string; groupId?: string | null } = {}) {
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const scratchpadRows: Array<{
    id: string;
    spaceId: string;
    botId: string;
    userId: string;
    title: string;
    status: string;
    notes: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const run = {
    id: runId,
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: options.trigger ?? "user",
    leaseFence: 0,
  };
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
        userId: run.userId,
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({ id: run.botId })),
    },
    user: { findUniqueOrThrow: vi.fn(async () => ({ email: "fixture@rakazo.test" })) },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: options.groupId ?? null,
      })),
    },
    chatGroup: { findUnique: vi.fn(async () => null) },
    botMemoryMethod: {
      findFirst: vi.fn(async () => ({ id: "method-1" })),
    },
    message: { findMany: vi.fn(async () => []) },
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
    skillSetting: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    botSkill: {
      findMany: vi.fn(async () => [{ skillKey: "builtin:Memory management", enabled: true }]),
      findFirst: vi.fn(async () => ({ enabled: true })),
    },
    scratchpadItem: {
      findMany: vi.fn(async () => scratchpadRows),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            spaceId: string;
            botId: string;
            userId: string;
            title: string;
            status: string;
            notes: string;
          };
        }) => {
          const now = new Date("2026-09-14T00:00:00.000Z");
          const row = {
            id: `scratch-${scratchpadRows.length + 1}`,
            ...data,
            createdAt: now,
            updatedAt: now,
          };
          scratchpadRows.push(row);
          return row;
        },
      ),
    },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect,
  };
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const classifyMemoryForBot = vi.fn(async () => ({
    classificationId: "classification-1",
    documentId: "memory-1",
    revision: 1,
    suggestion: {
      answers: { topic: "interview" },
      abstained: false,
      metadata: { provider: "local", model: "reviewed-examples", schemaVersion: "1" },
    },
    questions: [
      {
        key: "topic",
        label: "Topic",
        options: [{ key: "interview", label: "Interview", description: "" }],
      },
    ],
    reviewPath: "/app/bot-1",
  }));
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
    classifyMemoryForBot,
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    effects,
    results,
    prisma,
    pauseRunForInput,
    scratchpadRows,
    memoryCommit,
    classifyMemoryForBot,
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

describe("mutating tool effect idempotency keys", () => {
  it("executes different tools that share a reused provider tool-call id", async () => {
    const f = fixture("run-a");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "team preference" },
        executionId: "call_0",
      },
      {
        name: "scratchpad_add",
        args: { title: "follow up with design" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    // remember stores one bullet and appends it; it never replaces the document.
    expect(f.memoryCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "MEMORY.md",
        content: "- team preference",
        mode: "append",
      }),
      expect.anything(),
    );
    expect(f.scratchpadRows).toHaveLength(1);
    expect(f.effects.map((effect) => effect.idempotencyKey)).toEqual([
      toolEffectIdempotencyKey("run-a", "remember", {
        path: "MEMORY.md",
        content: "team preference",
      }),
      toolEffectIdempotencyKey("run-a", "scratchpad_add", {
        title: "follow up with design",
      }),
    ]);
    expect(f.effects.every((effect) => effect.status === "completed")).toBe(true);
    expect(f.results[0]).toEqual({ ok: true });
    expect(f.results[1]).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({ title: "follow up with design" }),
      }),
    );
  });

  it("executes the same provider tool-call id on different runs", async () => {
    const first = fixture("run-1");
    first.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "first bot note" },
        executionId: "call_0",
      },
    ]);
    await first.run();

    const second = fixture("run-2");
    // Shared ExternalEffect table: prior completed rows remain visible by idempotency key.
    second.effects.push(...first.effects);
    second.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "second bot note" },
        executionId: "call_0",
      },
    ]);
    await second.run();

    expect(second.memoryCommit).toHaveBeenCalledOnce();
    expect(second.effects.map((effect) => effect.idempotencyKey)).toEqual([
      toolEffectIdempotencyKey("run-1", "remember", {
        path: "MEMORY.md",
        content: "first bot note",
      }),
      toolEffectIdempotencyKey("run-2", "remember", {
        path: "MEMORY.md",
        content: "second bot note",
      }),
    ]);
    expect(second.results[0]).toEqual({ ok: true });
  });

  it("replays a true retry of the same effect without re-executing", async () => {
    const f = fixture("run-retry");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "call_0",
      },
    ]);
    await f.run();
    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);

    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "call_0",
      },
    ]);
    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-retry", "remember", {
        path: "MEMORY.md",
        content: "durable fact",
      }),
    );
    expect(f.results[1]).toEqual({ ok: true });
  });

  it("replays the same logical effect when restart assigns a new tool-call id", async () => {
    const f = fixture("run-replay-id");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "toolu_abc",
      },
    ]);
    await f.run();
    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);

    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "toolu_xyz",
      },
    ]);
    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-replay-id", "remember", {
        path: "MEMORY.md",
        content: "durable fact",
      }),
    );
    expect(f.results[1]).toEqual({ ok: true });
  });

  it("executes the same tool twice in one run when args differ but the provider id is reused", async () => {
    const f = fixture("run-args");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "first fact" },
        executionId: "call_0",
      },
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "second fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledTimes(2);
    expect(f.effects).toHaveLength(2);
    expect(f.effects[0]?.idempotencyKey).not.toBe(f.effects[1]?.idempotencyKey);
    expect(f.results).toEqual([{ ok: true }, { ok: true }]);
  });

  it("replays a legacy bare provider idempotency key for the same run and tool", async () => {
    const f = fixture("run-legacy");
    f.effects.push({
      id: "legacy-1",
      runId: "run-legacy",
      kind: "remember",
      idempotencyKey: "call_0",
      status: "completed",
      request: { path: "MEMORY.md", content: "legacy fact" },
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "legacy fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });

  it("replays a legacy scoped key that included the provider tool-call id", async () => {
    const args = { path: "MEMORY.md", content: "legacy scoped fact" };
    const f = fixture("run-legacy-scoped");
    f.effects.push({
      id: "legacy-scoped-1",
      runId: "run-legacy-scoped",
      kind: "remember",
      idempotencyKey: legacyScopedToolEffectIdempotencyKey(
        "run-legacy-scoped",
        "remember",
        "call_0",
        args,
      ),
      status: "completed",
      request: args,
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args,
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });

  it("does not reuse an incomplete legacy effect when the request differs", async () => {
    const f = fixture("run-legacy-mismatch");
    f.effects.push({
      id: "legacy-open",
      runId: "run-legacy-mismatch",
      kind: "remember",
      idempotencyKey: "call_0",
      status: "intended",
      request: { path: "MEMORY.md", content: "old fact" },
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "new fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(2);
    expect(f.effects[1]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-legacy-mismatch", "remember", {
        path: "MEMORY.md",
        content: "new fact",
      }),
    );
    expect(f.results[0]).toEqual({ ok: true });
  });

  it("executes two identical-args mutating calls in one live run", async () => {
    const args = { path: "MEMORY.md", content: "same fact" };
    const f = fixture("run-live-repeat");
    f.setCalls([
      { name: "remember", args, executionId: "call_a" },
      { name: "remember", args, executionId: "call_b" },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledTimes(2);
    expect(f.effects).toHaveLength(2);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-live-repeat", "remember", args),
    );
    expect(f.effects[1]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-live-repeat", "remember", args, 1),
    );
    expect(f.results).toEqual([{ ok: true }, { ok: true }]);
  });

  it("replays a legacy scoped key when restart assigns a new tool-call id", async () => {
    const args = { path: "MEMORY.md", content: "legacy scoped fact" };
    const f = fixture("run-legacy-new-id");
    f.effects.push({
      id: "legacy-scoped-old-id",
      runId: "run-legacy-new-id",
      kind: "remember",
      idempotencyKey: legacyScopedToolEffectIdempotencyKey(
        "run-legacy-new-id",
        "remember",
        "call_old",
        args,
      ),
      status: "completed",
      request: args,
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args,
        executionId: "call_new",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });

  it("classifies only through the active bot callback and returns a review suggestion without editing memory", async () => {
    const f = fixture("run-memory-classification");
    f.setCalls([
      {
        name: "classify_memory",
        args: { memoryId: "memory-1", botId: "attacker-bot", methodId: "attacker-method" },
        executionId: "classification-call",
      },
    ]);

    await f.run();

    expect(f.classifyMemoryForBot).toHaveBeenCalledExactlyOnceWith({
      actor: { userId: "user-1", spaceId: "space-1" },
      botId: "bot-1",
      memoryId: "memory-1",
    });
    expect(f.results[0]).toMatchObject({
      classificationId: "classification-1",
      suggestion: { answers: { topic: "interview" } },
      reviewPath: "/app/bot-1",
    });
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]).toMatchObject({ kind: "classify_memory", status: "completed" });
  });

  it("rejects a hostile classification tool call in a group even when the runtime emits it", async () => {
    const f = fixture("run-group-memory-classification", { groupId: "group-1" });
    f.setCalls([
      {
        name: "classify_memory",
        args: { memoryId: "memory-1" },
        executionId: "classification-call",
      },
    ]);

    await f.run();

    expect(f.classifyMemoryForBot).not.toHaveBeenCalled();
    expect(f.results[0]).toEqual({ error: "Memory management is unavailable in this run." });
    expect(f.effects).toHaveLength(0);
  });

  it.each(["prepare_memory_method", "review_memory_classification", "change_memory"])(
    "waits for human approval and replays only the exact approved %s payload",
    async (name) => {
      vi.mocked(runMemoryManagementTool).mockClear();
      const f = fixture(`run-approve-${name}`);
      f.prisma.actionAutoReviewPreference.findUnique.mockResolvedValue({ enabled: true });
      const args = { action: "withdraw", documentId: "memory-1", expectedRevision: 1 };
      f.setCalls([{ name, args, executionId: "original" }]);
      await f.run();
      expect(runMemoryManagementTool).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(f.effects[0]).toMatchObject({ kind: name, status: "intended", request: args });
      f.effects[0]!.status = "approved";
      f.setCalls([
        { name, args: { ...args, documentId: "unapproved-memory" }, executionId: "resume" },
      ]);
      await f.run();
      expect(runMemoryManagementTool).toHaveBeenCalledExactlyOnceWith(
        f.prisma,
        expect.objectContaining({ userId: "user-1", spaceId: "space-1", isDeploymentOwner: false }),
        "bot-1",
        name,
        args,
        f.effects[0]!.id,
      );
      expect(f.effects[0]!.status).toBe("completed");
      await f.run();
      expect(runMemoryManagementTool).toHaveBeenCalledTimes(1);
    },
  );

  it("does not execute a denied memory change", async () => {
    vi.mocked(runMemoryManagementTool).mockClear();
    const f = fixture("run-denied-memory");
    f.setCalls([
      {
        name: "change_memory",
        args: { action: "withdraw", documentId: "memory-1", expectedRevision: 1 },
        executionId: "denied",
      },
    ]);
    await f.run();
    f.effects[0]!.status = "denied";
    await f.run();
    expect(runMemoryManagementTool).not.toHaveBeenCalled();
    expect(f.effects[0]!.status).toBe("denied");
  });

  it("rejects a revoked capability before any approval or memory operation", async () => {
    vi.mocked(runMemoryManagementTool).mockClear();
    const f = fixture("run-revoked-memory");
    f.prisma.botSkill.findFirst.mockResolvedValue({ enabled: false });
    f.setCalls([
      {
        name: "change_memory",
        args: { action: "withdraw", documentId: "memory-1", expectedRevision: 1 },
        executionId: "revoked",
      },
    ]);
    await f.run();
    expect(f.results[0]).toEqual({ error: "Memory management is unavailable in this run." });
    expect(runMemoryManagementTool).not.toHaveBeenCalled();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(0);
  });

  it("does not fall back when classification consent is missing", async () => {
    const f = fixture("run-memory-classification-consent");
    f.classifyMemoryForBot.mockRejectedValueOnce(
      new MemoryClassificationConsentRequired("/app/memory?collection=personal&memory=memory-1"),
    );
    f.setCalls([
      {
        name: "classify_memory",
        args: { memoryId: "memory-1" },
        executionId: "classification-call",
      },
    ]);

    await f.run();

    expect(f.results[0]).toEqual({
      error:
        "Allow memory analysis in Settings → Models → Judgment model → Data sharing, then retry. No suggestion was created.",
      reviewPath: "/app/memory?collection=personal&memory=memory-1",
    });
    expect(f.memoryCommit).not.toHaveBeenCalled();
  });
});
