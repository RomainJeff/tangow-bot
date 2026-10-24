import type { AgentRunRequest, ConnectorCall, ConnectorTool } from "@rakazo/adapter-kit";
import type { ActionApprovalRule } from "@rakazo/core";
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
  run?: { threadId: string; botId: string; status: string };
};

function fixture({
  name = "demo_get_item",
  catalog = false,
  rules = [] as ActionApprovalRule[],
  autoReview = false,
  trigger = "user",
  requireToolApproval = true,
  inputSchema = {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  } as Record<string, unknown>,
  routeToolName = undefined as string | undefined,
} = {}) {
  const tool: ConnectorTool = {
    name,
    description: "Read an item",
    readOnly: true,
    inputSchema,
    route: { connectorId: "demo", resourceId: "resource-1", toolName: routeToolName ?? name },
  };
  const effects: Effect[] = [];
  const results: unknown[] = [];
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
        where?: {
          id?: string;
          runId?: string | { not: string };
          status?: string;
          kind?: string;
          run?: Partial<NonNullable<Effect["run"]>>;
        };
      } = {}) =>
        effects.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (where?.kind && effect.kind !== where.kind) return false;
          if (typeof where?.runId === "object" && effect.runId === where.runId.not) return false;
          if (typeof where?.runId === "string" && effect.runId && effect.runId !== where.runId) {
            return false;
          }
          if (where?.id && effect.id !== where.id) return false;
          if (where?.run) {
            const { run } = effect;
            if (!run) return false;
            for (const key of ["threadId", "botId", "status"] as const) {
              if (where.run[key] !== undefined && run[key] !== where.run[key]) return false;
            }
          }
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
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
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
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const execute = vi.fn(async function* (call: ConnectorCall) {
    yield { type: "result" as const, data: { item: call.args.id } };
  });
  let calls: Array<{ args: Record<string, unknown>; executionId: string }> = [
    { args: { id: "item-1" }, executionId: "call-1" },
  ];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
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
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    effects,
    results,
    execute,
    pauseRunForInput,
    setCalls(next: typeof calls) {
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

  describe("Composio batch", () => {
    const name = "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL";
    const inputSchema = {
      type: "object",
      properties: { tools: { type: "array" }, thought: { type: "string" } },
      required: ["tools"],
    };
    const purchaseRule: ActionApprovalRule = {
      effect: "require_approval",
      matchKind: "category",
      matchValue: "purchase",
    };
    const charge = { tool_slug: "STRIPE_CREATE_CHARGE", arguments: { amount: 10 } };
    const read = { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} };
    const mail = {
      tool_slug: "GMAIL_SEND_EMAIL",
      account: "gmail_test",
      arguments: { recipient_email: "someone@example.com", subject: "Hi", body: "Hello" },
    };
    const batch = (...tools: object[]) => ({ tools, thought: "Do it" });

    it.each([false, true])("asks for a charge inside a batch (catalog = %s)", async (catalog) => {
      const f = fixture({ name, catalog, inputSchema, rules: [purchaseRule] });
      f.setCalls([{ args: batch(charge), executionId: "c1" }]);
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledWith(
        expect.objectContaining({
          blocks: [
            expect.objectContaining({
              kind: "ask",
              text: "Review before STRIPE_CREATE_CHARGE → 10",
              detail: "amount: 10",
            }),
          ],
        }),
      );
    });

    it("lets a charge inside a batch ask over an always-allow on the wrapper", async () => {
      const f = fixture({
        name,
        catalog: true,
        inputSchema,
        rules: [purchaseRule, { effect: "always_allow", matchKind: "tool", matchValue: name }],
      });
      f.setCalls([{ args: batch(read, charge), executionId: "c1" }]);
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("asks for a charge inside a batch whose tool was renamed to stay unique", async () => {
      const f = fixture({
        name: "installed__install-2__COMPOSIO_MULTI_EXECUTE_TOOL",
        routeToolName: "COMPOSIO_MULTI_EXECUTE_TOOL",
        inputSchema,
        rules: [purchaseRule],
      });
      f.setCalls([{ args: batch(charge), executionId: "c1" }]);
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("runs a batch of reads under the same rule", async () => {
      const f = fixture({ name, catalog: true, inputSchema, rules: [purchaseRule] });
      f.setCalls([{ args: batch(read), executionId: "c1" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    });

    it("sends an approved mail draft by replaying the batch once", async () => {
      const f = fixture({ name, catalog: true, inputSchema });
      f.setCalls([{ args: batch(mail), executionId: "c1" }]);
      await f.run();
      f.effects[0]!.status = "approved";
      f.setCalls([{ args: batch(mail), executionId: "c2" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.execute).toHaveBeenCalledWith(
        expect.objectContaining({ args: batch(mail) }),
        expect.anything(),
      );
      expect(f.effects[0]!.status).toBe("completed");
    });
  });

  describe("outbound mail", () => {
    const inputSchema = {
      type: "object",
      properties: {
        to: { type: "string" },
        recipient_email: { type: "string" },
        cc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
        notes: { type: "string" },
        is_html: { type: "boolean" },
        include_signature: { type: "boolean" },
      },
    };
    const send = {
      recipient_email: "someone@example.com",
      cc: ["copy@example.com"],
      subject: "Test Chief",
      body: "Hello from Chief.",
      is_html: false,
      include_signature: false,
    };
    const draftCard = {
      kind: "ask",
      actions: [
        { id: "allow", label: "Send" },
        { id: "deny", label: "Discard" },
      ],
      draft: {
        app: { name: "Gmail", logo: null },
        recipients: [
          { role: "to", address: "someone@example.com" },
          { role: "cc", address: "copy@example.com" },
        ],
        subject: "Test Chief",
        body: "Hello from Chief.",
      },
    };
    const classicActions = [
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ];
    const always = (matchKind: "tool" | "connector" | "category", matchValue: string) => [
      { effect: "always_allow" as const, matchKind, matchValue },
    ];

    it.each([
      ["no rule", {}],
      ["an always-allow rule on the tool", { rules: always("tool", "GMAIL_SEND_EMAIL") }],
      ["an always-allow rule on the connector", { rules: always("connector", "gmail") }],
      ["an always-allow rule on email", { rules: always("category", "email") }],
      ["Auto Review on", { autoReview: true }],
      ["a webhook routine trusted to act", { trigger: "webhook", requireToolApproval: false }],
      ["the catalog wrapper", { catalog: true }],
    ])("pauses a mail send on a draft under %s", async (_, options) => {
      const f = fixture({ name: "GMAIL_SEND_EMAIL", inputSchema, ...options });
      f.setCalls([{ args: send, executionId: "c1" }]);
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(runAutoReviewJudge).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledWith(
        expect.objectContaining({ blocks: [expect.objectContaining(draftCard)] }),
      );
    });

    it("pauses the traced send inside a Composio batch on a draft", async () => {
      const f = fixture({
        name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL",
        catalog: true,
        inputSchema: { type: "object", properties: { tools: { type: "array" } } },
        rules: always("tool", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL"),
      });
      f.setCalls([
        {
          args: {
            tools: [{ tool_slug: "GMAIL_SEND_EMAIL", account: "gmail_test", arguments: send }],
            thought: "Send the test mail",
          },
          executionId: "c1",
        },
      ]);
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledWith(
        expect.objectContaining({ blocks: [expect.objectContaining(draftCard)] }),
      );
    });

    it("shows a send it cannot read on the plain card, every argument shown, never always", async () => {
      const f = fixture({
        name: "GMAIL_SEND_EMAIL",
        inputSchema,
        rules: always("tool", "GMAIL_SEND_EMAIL"),
      });
      f.setCalls([
        { args: { to: "a@example.com", body: "Hi", notes: "evil@example.com" }, executionId: "c1" },
      ]);
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledWith(
        expect.objectContaining({
          blocks: [
            expect.objectContaining({
              detail: "to: a@example.com\nbody: Hi\nnotes: evil@example.com",
              actions: classicActions,
            }),
          ],
        }),
      );
    });

    it("asks for a batch it cannot read even with no rule", async () => {
      const f = fixture({
        name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL",
        inputSchema: { type: "object", properties: { tools: {} } },
      });
      f.setCalls([{ args: { tools: "[not json" }, executionId: "c1" }]);
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledWith(
        expect.objectContaining({
          blocks: [
            expect.objectContaining({ detail: "tools: [not json", actions: classicActions }),
          ],
        }),
      );
    });

    it("refuses a batch that sends among other actions before anything is recorded", async () => {
      const f = fixture({
        name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL",
        inputSchema: { type: "object", properties: { tools: { type: "array" } } },
      });
      f.setCalls([
        {
          args: {
            tools: [
              { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} },
              { tool_slug: "GMAIL_SEND_EMAIL", arguments: send },
            ],
          },
          executionId: "c1",
        },
      ]);
      await f.run();
      expect(f.results).toEqual([{ error: "Send this message on its own." }]);
      expect(f.effects).toEqual([]);
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    });

    const waitingDraft = (run: Partial<NonNullable<Effect["run"]>> = {}): Effect => ({
      id: "waiting",
      kind: "GMAIL_SEND_EMAIL",
      idempotencyKey: "waiting-key",
      status: "intended",
      request: { recipient_email: "first@example.com", body: "First" },
      runId: "run-0",
      run: { threadId: "thread-1", botId: "bot-1", status: "waiting_input", ...run },
    });

    it("refuses a second draft while one from this bot waits in the thread", async () => {
      const f = fixture({ name: "GMAIL_SEND_EMAIL", inputSchema });
      f.effects.push(waitingDraft());
      f.setCalls([{ args: send, executionId: "c1" }]);
      await f.run();
      expect(f.results).toEqual([{ error: "A draft is already waiting for the user." }]);
      expect(f.effects.map((effect) => effect.id)).toEqual(["waiting"]);
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    });

    it.each([
      ["another bot", { botId: "bot-2" }],
      ["another thread", { threadId: "thread-2" }],
      ["a run that is no longer waiting", { status: "completed" }],
    ])("still shows a card when the waiting draft belongs to %s", async (_, run) => {
      const f = fixture({ name: "GMAIL_SEND_EMAIL", inputSchema });
      f.effects.push(waitingDraft(run));
      f.setCalls([{ args: send, executionId: "c1" }]);
      await f.run();
      expect(f.pauseRunForInput).toHaveBeenCalledWith(
        expect.objectContaining({ blocks: [expect.objectContaining(draftCard)] }),
      );
    });

    it("leaves a send that is not mail to the usual gate", async () => {
      const f = fixture({
        name: "TWILIO_SEND_SMS",
        inputSchema: { type: "object", properties: { to: {}, body: {} } },
      });
      f.setCalls([{ args: { to: "+15555550100", body: "Hi" }, executionId: "c1" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    });
  });
});
