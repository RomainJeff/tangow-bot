import type {
  AgentRunRequest,
  ComputerRef,
  NativeProcess,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";

const mockProvisionComputer = vi.fn(
  async (): Promise<ComputerRef> => ({
    id: "computer-1",
    providerRef: "computer-1",
    botId: "bot-1",
    kind: "desktop",
  }),
);
const mockAcquireComputerExecutionLease = vi.fn(async () => null);
vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: (...args: unknown[]) =>
    mockAcquireComputerExecutionLease(...(args as [])),
  provisionComputer: (...args: unknown[]) => mockProvisionComputer(...(args as [])),
}));

vi.mock("./delegated-tasks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./delegated-tasks.js")>();
  return {
    ...actual,
    createDelegatedTasks: vi.fn(),
    deliverSpecialistRunEnd: vi.fn(async () => undefined),
  };
});

import {
  createDelegatedTasks,
  DelegationLimitError,
  deliverSpecialistRunEnd,
} from "./delegated-tasks.js";
import { createRunExecutor } from "./executor.js";

const mockCreateDelegatedTasks = vi.mocked(createDelegatedTasks);
const mockDeliverSpecialistRunEnd = vi.mocked(deliverSpecialistRunEnd);

/**
 * Executor-level seam fixture: a fake `runtime.run` drives
 * `continueRun` end to end with prisma fully substituted — no Postgres, same pattern as
 * `executor-readonly-approval.test.ts` — so the tool-dispatch and completion insertion
 * points are exercised through the real `continueRun`, not through a helper called in
 * isolation.
 */
function fixture(
  {
    scopedTaskId,
    outcome,
    harness,
    executionTarget,
    choiceVersion,
    missionComputerId,
    nativeRuntimes,
    sourceBlocks,
    delegateArgs,
  }: {
    scopedTaskId?: string;
    outcome:
      | "delegate_dispatch"
      | "delegate_close_dispatch"
      | "delegate_cancel_dispatch"
      | "completed"
      | "failed";
    harness?: "codex-native" | "claude-native" | null;
    executionTarget?: string | null;
    choiceVersion?: number | null;
    missionComputerId?: string | null;
    nativeRuntimes?: Record<string, { describe: () => unknown; run: unknown }>;
    sourceBlocks?: unknown[];
    /** Extra arguments the model passes to its delegate call. */
    delegateArgs?: Record<string, unknown>;
  } = { outcome: "delegate_dispatch" },
) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    sourceMessageId: sourceBlocks ? "message-source" : null,
    scopedTaskId: scopedTaskId ?? null,
    harness: harness ?? null,
    executionTarget: executionTarget ?? null,
    choiceVersion: choiceVersion ?? null,
    leaseFence: 0,
  };
  const finalizeRun = vi.fn(async ({ outcome: finalizedOutcome }: { outcome: string }) => ({
    continuationRunId: null,
    outcome: finalizedOutcome,
  }));
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
        name: "Coordinator",
        title: "Coordinator",
        description: "Test coordinator",
        computerId: "computer-1",
        computer: {
          id:
            outcome === "delegate_dispatch" ||
            outcome === "delegate_close_dispatch" ||
            outcome === "delegate_cancel_dispatch"
              ? "computer-db-1"
              : "computer-1",
          scope: "dedicated",
        },
      })),
      findMany: vi.fn(async () => []),
    },
    scopedTask: {
      findUnique: vi.fn(async () =>
        scopedTaskId ? { missionComputerId: missionComputerId ?? null } : null,
      ),
    },
    computer: {
      findUniqueOrThrow: vi.fn(async ({ where: { id } }: { where: { id: string } }) => ({
        id,
        scope: "dedicated",
      })),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
    message: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) =>
        id === run.sourceMessageId ? { blocks: sourceBlocks ?? [], replyTo: null } : null,
      ),
      findFirst: vi.fn(async () => null),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Delegate work" })) },
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
    externalEffect: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "effect-1" })),
      update: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  let delegateResult: unknown;
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    if (outcome === "delegate_dispatch") {
      delegateResult = await request.executeTool!(
        "delegate",
        {
          profile_bot_id: "profile-1",
          name: "Analyst",
          brief: "Summarize the report",
          ...delegateArgs,
        },
        "call-1",
      );
      yield { type: "done" as const, text: "Delegated." };
      return;
    }
    if (outcome === "delegate_close_dispatch") {
      await request.executeTool!(
        "delegate_close",
        { work_id: "work-1", reason: "The result is consumed." },
        "call-close-1",
      );
      yield { type: "done" as const, text: "Closed." };
      return;
    }
    if (outcome === "delegate_cancel_dispatch") {
      await request.executeTool!(
        "delegate_cancel",
        { work_id: "work-1", reason: "No longer needed." },
        "call-cancel-1",
      );
      yield { type: "done" as const, text: "Cancelled." };
      return;
    }
    if (outcome === "completed") {
      yield { type: "done" as const, text: "Here is the summary." };
      return;
    }
    throw new Error("codex-native auth refused offline");
  });
  const deps = {
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    nativeRuntimes,
    connector: { discoverTools: async () => [], resolveCall: async () => undefined },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), pauseRunForInput: vi.fn(), finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    messaging: { hasIdentity: vi.fn(async () => false) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0];
  const executor = createRunExecutor(deps);
  return {
    deps,
    finalizeRun,
    runtimeRun,
    /** What the model received back from its delegate call. */
    delegateResult: () => delegateResult,
    async run() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
    },
  };
}

describe("executor seam — delegate dispatch and specialist completion", () => {
  beforeEach(() => {
    mockDeliverSpecialistRunEnd.mockClear();
  });

  it("dispatches the delegate tool with the turn's own bot as the non-forgeable actor", async () => {
    const apply = vi.fn(async (_command: unknown, _context: unknown) => ({
      workId: "work-1",
      botId: "bot-specialist",
      replayed: false,
      threadId: "thread-specialist",
    }));
    mockCreateDelegatedTasks.mockReturnValue({ apply, inspect: vi.fn() } as never);

    const f = fixture({ outcome: "delegate_dispatch" });
    await f.run();

    expect(apply).toHaveBeenCalledTimes(1);
    const effectiveModel = f.runtimeRun.mock.calls[0]![0].model;
    expect(mockCreateDelegatedTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({
        coordinatorModel: {
          modelProvider: effectiveModel.provider,
          modelId: effectiveModel.id,
          thinkingLevel: effectiveModel.thinkingLevel ?? "medium",
        },
      }),
    );
    const [command, context] = apply.mock.calls[0]!;
    expect((command as { kind: string }).kind).toBe("delegate");
    // Actor identity comes from the run/bot of this turn, never from tool args — not forgeable.
    // `rights` stays `{}` — the effective MCP ceiling is not carried through this field at
    // all (a boolean per server could not express tool-level
    // allowAllTools/allowedTools granularity). `applyDelegate` computes the ceiling itself,
    // straight from `coordinator.id`, via `computeEffectiveMcpAccess` (delegated-tasks.ts).
    expect((context as { actor: unknown }).actor).toEqual({
      userId: "user-1",
      spaceId: "space-1",
      botId: "bot-1",
      rights: {},
    });
    // The runtime ref can differ; delegation must receive the foreign-keyable DB id.
    expect((context as { missionComputerId?: string }).missionComputerId).toBe("computer-db-1");
    // The delegate tool exposes no rights parameter today, so requestedRights is always {}
    // — accepted on the wire for compatibility, but no longer consulted by applyDelegate.
    expect((command as { requestedRights: unknown }).requestedRights).toEqual({});
    // No harness was asked for: none is invented here, the delegation decides.
    expect(command).not.toHaveProperty("harness");
  });

  it("passes the harness the model asked for under its neutral name", async () => {
    const apply = vi.fn(async (_command: unknown, _context: unknown) => ({
      workId: "work-1",
      botId: "bot-specialist",
      replayed: false,
      threadId: "thread-specialist",
    }));
    mockCreateDelegatedTasks.mockReturnValue({ apply, inspect: vi.fn() } as never);

    const f = fixture({ outcome: "delegate_dispatch", delegateArgs: { harness: "claude" } });
    await f.run();

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "delegate", harness: "claude-native" }),
      expect.anything(),
    );
  });

  it("refuses a harness name it does not know instead of ignoring it", async () => {
    const apply = vi.fn();
    mockCreateDelegatedTasks.mockReturnValue({ apply, inspect: vi.fn() } as never);

    // `toString` is inherited by every object, so a membership test on the names would accept it.
    const f = fixture({ outcome: "delegate_dispatch", delegateArgs: { harness: "toString" } });
    await f.run();

    expect(apply).not.toHaveBeenCalled();
    expect(f.delegateResult()).toEqual({ error: expect.stringContaining("Unknown harness") });
  });

  it("hands a refused delegation back to the model as an explicit error, not a failed run", async () => {
    const refusal = "Delegation refused: this task already has 5 active specialists.";
    const apply = vi.fn(async () => {
      throw new DelegationLimitError(refusal);
    });
    mockCreateDelegatedTasks.mockReturnValue({ apply, inspect: vi.fn() } as never);

    const f = fixture({ outcome: "delegate_dispatch" });
    await f.run();

    expect(f.delegateResult()).toEqual({ error: refusal });
    expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  });

  it("dispatches delegate_close as the coordinator and returns its closure receipt", async () => {
    const apply = vi.fn(async (_command: unknown, _context: unknown) => ({
      workId: "work-1",
      botId: "bot-specialist",
      threadId: "thread-specialist",
      state: "closed",
      replayed: false,
    }));
    mockCreateDelegatedTasks.mockReturnValue({ apply, inspect: vi.fn() } as never);

    const f = fixture({ outcome: "delegate_close_dispatch" });
    await f.run();

    expect(apply).toHaveBeenCalledWith(
      { kind: "close", workId: "work-1" },
      expect.objectContaining({
        actor: expect.objectContaining({ botId: "bot-1", userId: "user-1", spaceId: "space-1" }),
        missionComputerId: "computer-db-1",
      }),
    );
  });

  it("dispatches delegate_cancel as the coordinator, with the turn's own bot as the non-forgeable actor", async () => {
    const apply = vi.fn(async (_command: unknown, _context: unknown) => ({
      workId: "work-1",
      botId: "bot-specialist",
      threadId: "thread-specialist",
      state: "cancelling",
      replayed: false,
    }));
    mockCreateDelegatedTasks.mockReturnValue({ apply, inspect: vi.fn() } as never);

    const f = fixture({ outcome: "delegate_cancel_dispatch" });
    await f.run();

    expect(apply).toHaveBeenCalledWith(
      { kind: "cancel", workId: "work-1", reason: "No longer needed." },
      expect.objectContaining({
        actor: expect.objectContaining({ botId: "bot-1", userId: "user-1", spaceId: "space-1" }),
        missionComputerId: "computer-db-1",
      }),
    );
  });

  it("delivers the specialist's successful result to the coordinator (mutant: removing the call must fail this test)", async () => {
    const f = fixture({ scopedTaskId: "work-1", outcome: "completed" });
    await f.run();

    expect(mockDeliverSpecialistRunEnd).toHaveBeenCalledTimes(1);
    expect(mockDeliverSpecialistRunEnd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workId: "work-1",
        runId: "run-1",
        status: "completed",
        text: expect.any(String),
      }),
    );
  });

  it("delivers a work_return on a failed specialist run instead of silently dropping it", async () => {
    const f = fixture({ scopedTaskId: "work-1", outcome: "failed" });
    await f.run();

    expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    expect(mockDeliverSpecialistRunEnd).toHaveBeenCalledTimes(1);
    expect(mockDeliverSpecialistRunEnd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workId: "work-1", runId: "run-1", status: "failed" }),
    );
  });

  it("returns an open specialist's peer-awakened turn as a work_return", async () => {
    const f = fixture({
      scopedTaskId: "work-1",
      outcome: "completed",
      sourceBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "peer-1",
          fromBotName: "Peer",
          text: "Can you verify this?",
          intent: "question",
          purpose: "peer_message",
        },
      ],
    });
    await f.run();

    expect(mockDeliverSpecialistRunEnd).toHaveBeenCalledTimes(1);
    expect(mockDeliverSpecialistRunEnd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workId: "work-1",
        runId: "run-1",
        status: "completed",
        text: expect.any(String),
      }),
    );
  });

  it("does not touch delegation on an ordinary (non-specialist) run", async () => {
    const f = fixture({ outcome: "completed" });
    await f.run();

    expect(mockDeliverSpecialistRunEnd).not.toHaveBeenCalled();
  });
});

describe("executor native MCP placement contract", () => {
  it("arms the ticket with the full Docker ID sent by the supervisor, not the database ID", async () => {
    // Independent supervisor contract: Docker inspect().Id is the full container ID.
    const dockerId = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const placement: ComputerRef = {
      id: dockerId,
      providerRef: dockerId,
      botId: "bot-1",
      kind: "docker",
    };
    mockProvisionComputer.mockResolvedValueOnce(placement);
    const f = fixture({
      outcome: "completed",
      harness: "codex-native",
      executionTarget: "computer-1",
      choiceVersion: 1,
    });
    const credential = {
      type: "oauth",
      access: "fake-access",
      refresh: "fake-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "fake-account",
    };
    const secret = { id: "secret-1", ciphertext: JSON.stringify(credential) };
    Object.assign(f.deps.prisma, {
      spaceModelPreference: {
        findFirst: async () => ({
          modelId: "gpt-test",
          credential: { provider: "openai-codex", secretId: secret.id },
        }),
      },
      secret: { findFirst: async () => secret },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $queryRaw: async () => [], secret: { findFirst: async () => secret } }),
      nativeSession: { findUnique: async () => null, updateMany: async () => ({ count: 1 }) },
      lifecycleEvent: { create: async () => ({}) },
    });
    Object.assign(f.deps, {
      secretStore: { load: (ciphertext: string) => ciphertext },
      modelOAuth: { toAuth: async () => "fake-access", refresh: vi.fn() },
    });
    // Stop after arm at the external process boundary; no native runtime is injected.
    const process: NativeProcess = {
      write: async () => {
        throw new Error("fixture stops after arm");
      },
      stdout: (async function* () {})(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 1 }),
      stop: async () => "stopped",
    };
    const startNativeProcess = vi.fn<NonNullable<SandboxProvider["startNativeProcess"]>>(
      async () => process,
    );
    Object.assign(f.deps.sandbox, { startNativeProcess });
    const arm = vi.fn(async () => undefined);
    f.deps.nativeMcp = {
      issue: async () => ({
        ticket: "fake-ticket",
        endpoint: {
          url: "http://rakazo-mcp:7091/native-mcp",
          httpHeaders: { Authorization: "Bearer fake-ticket" },
        },
        close: async () => undefined,
      }),
      arm,
      disarm: async () => undefined,
    };

    await f.run();

    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ error: "fixture stops after arm" }),
    );
    expect(startNativeProcess).toHaveBeenCalledWith(
      placement,
      expect.anything(),
      expect.anything(),
    );
    expect(arm).toHaveBeenCalledWith(
      "fake-ticket",
      expect.objectContaining({ runId: "run-1", computerId: dockerId }),
    );
  });
});

describe("executor seam — codex-native goes through deps.nativeRuntimes", () => {
  it("routes a codex-native run through an injected fixture runtime instead of the real CodexNativeRuntime", async () => {
    mockCreateDelegatedTasks.mockReturnValue({ apply: vi.fn(), inspect: vi.fn() } as never);
    const fixtureRun = vi.fn(async function* () {
      yield { type: "done" as const, text: "Scripted via injected fixture." };
    });
    const f = fixture({
      outcome: "completed",
      harness: "codex-native",
      executionTarget: "computer-1",
      choiceVersion: 1,
      nativeRuntimes: {
        "codex-native": { describe: () => ({ capabilities: { scripted: true } }), run: fixtureRun },
      },
    });
    await f.run();

    expect(fixtureRun).toHaveBeenCalledTimes(1);
  });

  it("still constructs the real CodexNativeRuntime when no fixture is injected (non-regression)", async () => {
    mockCreateDelegatedTasks.mockReturnValue({ apply: vi.fn(), inspect: vi.fn() } as never);
    const f = fixture({
      outcome: "completed",
      harness: "codex-native",
      executionTarget: "computer-1",
      choiceVersion: 1,
    });
    // No nativeRuntimes injected: falls through to constructing the real
    // CodexNativeRuntime, never the generic scripted `deps.runtime` — evidenced by its
    // own (unrelated) offline-auth refusal, proving it was actually reached.
    await f.run();
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error: expect.stringContaining("ChatGPT subscription"),
      }),
    );
  });

  it("constructs the real ClaudeNativeRuntime when no fixture is injected", async () => {
    mockCreateDelegatedTasks.mockReturnValue({ apply: vi.fn(), inspect: vi.fn() } as never);
    const f = fixture({
      outcome: "completed",
      harness: "claude-native",
      executionTarget: "computer-1",
      choiceVersion: 1,
    });

    await f.run();

    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error: expect.stringContaining("connected Claude subscription"),
      }),
    );
  });
});

describe("executor seam — specialist run authorized on its mission Computer", () => {
  beforeEach(() => {
    mockAcquireComputerExecutionLease.mockClear();
  });

  it("authorizes a specialist run whose target matches the scoped task's missionComputerId", async () => {
    mockCreateDelegatedTasks.mockReturnValue({ apply: vi.fn(), inspect: vi.fn() } as never);
    const fixtureRun = vi.fn(async function* () {
      yield { type: "done" as const, text: "On mission Computer." };
    });
    const f = fixture({
      outcome: "completed",
      scopedTaskId: "work-1",
      harness: "codex-native",
      executionTarget: "computer-mission-1",
      choiceVersion: 1,
      missionComputerId: "computer-mission-1",
      nativeRuntimes: {
        "codex-native": { describe: () => ({ capabilities: { scripted: true } }), run: fixtureRun },
      },
    });
    await f.run();

    expect(fixtureRun).toHaveBeenCalledTimes(1);
  });

  it("leases and provisions the scoped task's mission Computer, not the specialist bot's own Computer", async () => {
    mockCreateDelegatedTasks.mockReturnValue({ apply: vi.fn(), inspect: vi.fn() } as never);
    const fixtureRun = vi.fn(async function* () {
      yield { type: "done" as const, text: "On mission Computer." };
    });
    const f = fixture({
      outcome: "completed",
      scopedTaskId: "work-1",
      harness: "codex-native",
      executionTarget: "computer-mission-1",
      choiceVersion: 1,
      missionComputerId: "computer-mission-1",
      nativeRuntimes: {
        "codex-native": { describe: () => ({ capabilities: { scripted: true } }), run: fixtureRun },
      },
    });
    await f.run();

    expect(mockAcquireComputerExecutionLease).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ computerId: "computer-mission-1" }),
    );
  });

  it("still leases the bot's own Computer for an ordinary run", async () => {
    mockCreateDelegatedTasks.mockReturnValue({ apply: vi.fn(), inspect: vi.fn() } as never);
    const f = fixture({ outcome: "completed" });
    await f.run();

    expect(mockAcquireComputerExecutionLease).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ computerId: "computer-1" }),
    );
  });

  it("still refuses an ordinary run whose target is not its own Computer (non-regression)", async () => {
    mockCreateDelegatedTasks.mockReturnValue({ apply: vi.fn(), inspect: vi.fn() } as never);
    const f = fixture({
      outcome: "completed",
      harness: "codex-native",
      executionTarget: "computer-other",
      choiceVersion: 1,
    });

    await expect(f.run()).rejects.toThrow();
  });
});
