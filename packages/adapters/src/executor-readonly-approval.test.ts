import type { AgentRunRequest, ConnectorCall, ConnectorTool } from "@rakazo/adapter-kit";
import type { ActionApprovalRule } from "@rakazo/core";
import { DISMISSED_EFFECT_RESULT } from "@rakazo/core";
import { approvalEffectKey, toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isApprovalPausedResult } from "./approval-effect.js";
import type * as AutoReviewModule from "./auto-review.js";
import { runAutoReviewJudge } from "./auto-review.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { catalogEntries, resolveCatalogCall } from "./lazy-tool-catalog.js";
import { recordingSessionLog } from "./session-log/recording.test-support.js";

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
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  reviewDecision?: string;
  runId?: string;
  answeredAt?: Date;
};

function fixture({
  name = "demo_get_item",
  catalog = false,
  rules = [] as ActionApprovalRule[],
  autoReview = false,
  trigger = "user",
  requireToolApproval = true,
} = {}) {
  const tool: ConnectorTool = {
    name,
    description: "Read an item",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    route: { connectorId: "demo", resourceId: "resource-1", toolName: name },
  };
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const prompts: string[] = [];
  const pauses: { status: string; finishedAt: Date }[] = [];
  let takeover = false;
  let clock = 0;
  const tick = () => new Date(++clock);
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger,
    requireToolApproval,
    leaseFence: 0,
  };
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: { id?: string; runId?: string; status?: string; kind?: string; result?: unknown };
      } = {}) =>
        effects.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (where?.result && effect.result != null) return false;
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
  const log = recordingSessionLog();
  const prisma = {
    sessionEntry: log.sessionEntry,
    $queryRaw: log.queryRaw,
    $transaction: async (work: (tx: unknown) => unknown) => work(prisma),
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
      findFirst: vi.fn(
        async ({ where }: { where: { status: { in: string[] } } }) =>
          pauses.findLast((pause) => where.status.in.includes(pause.status)) ?? null,
      ),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })),
      update: vi.fn(async () => ({ sessionId: "session-main", botId: run.botId })),
    },
    event: { create: vi.fn(async () => ({ id: "event-1" })) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Read the item" })) },
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
    // Per-bot skill visibility: no settings and no overrides.
    skillSetting: { findMany: vi.fn(async () => []) },
    botSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => rules) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: autoReview })) },
    externalEffect,
  };
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    pauses.push({ status: "waiting_input", finishedAt: tick() });
    return true;
  });
  const pauseRunForTakeover = vi.fn(async () => {
    run.status = "waiting_takeover";
    pauses.push({ status: "waiting_takeover", finishedAt: tick() });
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const execute = vi.fn(async function* (call: ConnectorCall) {
    yield { type: "result" as const, data: { item: call.args.id } };
  });
  let calls = [{ args: { id: "item-1" }, executionId: "call-1" }];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    prompts.push(request.prompt);
    if (takeover) {
      yield { type: "takeover" as const, reason: "Sign in" };
      return;
    }
    for (const call of calls) {
      const result = await request.executeTool!(
        catalog ? "demo_execute_tool" : name,
        catalog ? { id: `resource-1:${name}`, arguments: call.args } : call.args,
        call.executionId,
      );
      results.push(result);
      if (isApprovalPausedResult(result)) return;
    }
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    sessionLog: log.sessionLog,
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () =>
        catalog
          ? [
              {
                name: "demo_execute_tool",
                description: "Execute a catalog tool",
                inputSchema: { type: "object" },
                route: { connectorId: "demo", toolName: "__catalog_execute" },
              },
            ]
          : [tool],
      resolveCall: async (call: ConnectorCall) =>
        catalog ? resolveCatalogCall(call, catalogEntries([tool])) : undefined,
      execute,
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: {
      append: vi.fn(async () => undefined),
      pauseRunForInput,
      pauseRunForTakeover,
      notify: vi.fn(async () => undefined),
      finalizeRun,
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    effects,
    results,
    prompts,
    execute,
    pauseRunForInput,
    setCalls(next: typeof calls) {
      calls = next;
    },
    setTakeover(next: boolean) {
      takeover = next;
    },
    answer(index: number, status: "approved" | "denied", result?: unknown) {
      Object.assign(effects[index]!, { status, answeredAt: tick(), result });
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

describe("connector read-only metadata and approval enforcement", () => {
  beforeEach(() => {
    vi.mocked(runAutoReviewJudge).mockReset();
  });

  it.each(["shell", "write_file"])(
    "forces owner approval for webhook-triggered %s despite an allow rule",
    async (name) => {
      const f = fixture({
        name,
        trigger: "webhook",
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: name }],
      });
      await f.run();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(runAutoReviewJudge).not.toHaveBeenCalled();
    },
  );

  it("tells the resumed run about the denial it resumes for, once", async () => {
    const f = fixture({
      rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
    });
    await f.run();
    f.answer(0, "denied");
    f.setCalls([{ args: { id: "item-2" }, executionId: "call-2" }]);
    await f.run();
    expect(f.prompts[1]).toContain("the user declined");
    expect(f.prompts[1]).toContain('demo_get_item: {"id":"item-1"}');

    f.answer(1, "approved");
    f.setCalls([{ args: { id: "item-2" }, executionId: "call-3" }]);
    await f.run();
    expect(f.prompts[2]).toContain('demo_get_item: {"id":"item-2"}');
    expect(f.prompts[2]).not.toContain("the user declined");
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.results.at(-1)).toEqual({ item: "item-2" });
  });

  it("does not repeat a denial after a later takeover pause", async () => {
    const f = fixture({
      rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
    });
    await f.run();
    f.answer(0, "denied");
    f.setTakeover(true);
    await f.run();
    expect(f.prompts[1]).toContain("the user declined");
    f.setTakeover(false);
    f.setCalls([]);
    await f.run();
    expect(f.prompts[2]).not.toContain("the user declined");
  });

  it("does not report a denial for a card put away by a typed reply", async () => {
    const f = fixture({
      rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
    });
    await f.run();
    f.answer(0, "denied", DISMISSED_EFFECT_RESULT);
    f.setCalls([]);
    await f.run();
    expect(f.prompts[1]).not.toContain("the user declined");
    f.answer(0, "denied");
    await f.run();
    expect(f.prompts[2]).toContain("the user declined");
  });

  describe.each([false, true])("catalog = %s", (catalog) => {
    it.each(["tool", "connector"] as const)(
      "honors an explicit %s approval rule",
      async (matchKind) => {
        const f = fixture({
          catalog,
          autoReview: true,
          rules: [
            {
              effect: "require_approval",
              matchKind,
              matchValue: matchKind === "tool" ? "demo_get_item" : "demo",
            },
          ],
        });
        await f.run();
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.pauseRunForInput).toHaveBeenCalledOnce();
        expect(f.pauseRunForInput).toHaveBeenCalledWith(
          expect.objectContaining({
            blocks: [expect.objectContaining({ kind: "ask", approvalEffectId: f.effects[0]!.id })],
          }),
        );
        expect(isApprovalPausedResult(f.results[0])).toBe(true);
        expect(runAutoReviewJudge).not.toHaveBeenCalled();
      },
    );

    it("replays the approved arguments once and returns the result on retry", async () => {
      const f = fixture({
        catalog,
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
      });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      f.setCalls([{ args: { id: "model-reconstructed" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          args: { id: "item-1" },
          executionId: approvalEffectKey("run-1", "demo_get_item", { id: "item-1" }),
        }),
        expect.anything(),
      );
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("executes a later identical-args call after an approved replay when approval is not required by default", async () => {
      const args = { id: "item-1" };
      const rules: ActionApprovalRule[] = [
        { effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" },
      ];
      const f = fixture({ catalog, rules });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      rules[0]!.effect = "always_allow";
      f.setCalls([
        { args, executionId: "call-2" },
        { args, executionId: "call-3" },
      ]);
      await f.run();
      expect(f.execute).toHaveBeenCalledTimes(2);
      expect(f.effects).toHaveLength(2);
      expect(f.effects[0]?.idempotencyKey).toBe(approvalEffectKey("run-1", "demo_get_item", args));
      expect(f.effects[1]?.idempotencyKey).toBe(
        toolEffectIdempotencyKey("run-1", "demo_get_item", args, 1),
      );
      expect(f.results.slice(1)).toEqual([{ item: "item-1" }, { item: "item-1" }]);
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("honors a persisted denial on a new tool call id", async () => {
      const f = fixture({
        catalog,
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
      });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "denied";
      f.setCalls([{ args: { id: "item-1" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.results.at(-1)).toEqual({ error: "User denied this action." });
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("consumes the saved approval after the user chooses always allow", async () => {
      const rules: ActionApprovalRule[] = [
        { effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" },
      ];
      const f = fixture({ catalog, rules });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      rules[0]!.effect = "always_allow";
      f.setCalls([{ args: { id: "model-reconstructed" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("allows ordinary reads without approval or automatic review", async () => {
      const f = fixture({ catalog, autoReview: true });
      f.setCalls([
        { args: { id: "item-1" }, executionId: "call-1" },
        { args: { id: "item-1" }, executionId: "call-2" },
      ]);
      await f.run();
      expect(f.execute).toHaveBeenCalledTimes(2);
      expect(f.results).toEqual([{ item: "item-1" }, { item: "item-1" }]);
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(runAutoReviewJudge).not.toHaveBeenCalled();
    });

    it("replays a non-approval connector effect when the tool-call id changes", async () => {
      const f = fixture({ catalog });
      f.setCalls([{ args: { id: "item-1" }, executionId: "call-1" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.effects[0]?.idempotencyKey).toBe(
        toolEffectIdempotencyKey("run-1", "demo_get_item", { id: "item-1" }),
      );

      f.setCalls([{ args: { id: "item-1" }, executionId: "call-new" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.effects).toHaveLength(1);
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
    });

    it("keeps an explicit allow rule ahead of automatic review", async () => {
      const f = fixture({
        catalog,
        name: "demo_send_message",
        autoReview: true,
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "demo_send_message" }],
      });
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(runAutoReviewJudge).not.toHaveBeenCalled();
    });

    it("forces owner approval for webhook-triggered writes despite an allow rule", async () => {
      const f = fixture({
        catalog,
        name: "demo_send_message",
        trigger: "webhook",
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "demo_send_message" }],
      });
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(runAutoReviewJudge).not.toHaveBeenCalled();
    });

    it("applies the normal rules to an opted-out webhook run", async () => {
      const allowed = fixture({
        catalog,
        name: "demo_send_message",
        trigger: "webhook",
        requireToolApproval: false,
      });
      await allowed.run();
      expect(allowed.execute).toHaveBeenCalledOnce();
      expect(allowed.pauseRunForInput).not.toHaveBeenCalled();

      const asked = fixture({
        catalog,
        name: "demo_send_message",
        trigger: "webhook",
        requireToolApproval: false,
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_send_message" }],
      });
      await asked.run();
      expect(asked.execute).not.toHaveBeenCalled();
      expect(asked.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it.each(["ask", "error", "pass"] as const)(
      "honors automatic review %s despite a read-only hint",
      async (decision) => {
        vi.mocked(runAutoReviewJudge).mockResolvedValue({
          decision,
          reason: "Review result",
          model: "scripted/checker",
        });
        const f = fixture({ catalog, name: "demo_send_message", autoReview: true });
        await f.run();
        expect(runAutoReviewJudge).toHaveBeenCalledOnce();
        expect(f.effects[0]?.reviewDecision).toBe(decision);
        expect(f.execute).toHaveBeenCalledTimes(decision === "pass" ? 1 : 0);
        expect(f.pauseRunForInput).toHaveBeenCalledTimes(decision === "pass" ? 0 : 1);
      },
    );
  });
});
