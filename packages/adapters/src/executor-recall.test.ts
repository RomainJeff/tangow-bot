import type { AgentRunRequest, SemanticMemoryRecallRequest } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { recordingSessionLog } from "./session-log/recording.test-support.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "docker" }),
}));

function fixture(runUserId = "user-1") {
  const taskPrompt = "What did Ava decide?";
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: runUserId,
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };
  const log = recordingSessionLog();
  const prisma = {
    sessionEntry: log.sessionEntry,
    $queryRaw: log.queryRaw,
    $transaction: async (work: (tx: unknown) => unknown) => work(prisma),
    run: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findFirst: vi.fn(async () => ({ visibility: "private" })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        userId: "user-1",
        visibility: runUserId === "user-1" ? "private" : "space",
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        memoryScope: "isolated",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      count: vi.fn(async () => 0),
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
      })),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: taskPrompt })),
    },
    connection: { findMany: vi.fn(async () => []) },
    spaceMember: { findUnique: async () => ({ modelAuto: false }) },
    spaceModelCategory: { findMany: async () => [] },
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
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  const resolveDecisions = vi.fn(async () => null);
  const recall = vi.fn(async (_request: SemanticMemoryRecallRequest) => ({
    ok: true as const,
    value: [{ memory: "Ava decided to ship behind a feature flag.", score: 0.9 }],
  }));
  const runtimeRun = vi.fn(async function* () {
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    sessionLog: log.sessionLog,
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: {
      resolve: async () => ({
        defaultScope: "isolated" as const,
        provider: {
          describe: () => ({
            id: "test-memory",
            contractVersion: "1",
            adapterVersion: "1",
            capabilities: {
              recall: true,
              save: true,
              purgeHistory: true,
              sharedScope: true,
            } as const,
          }),
          recall,
          save: vi.fn(),
          purgeHistory: vi.fn(),
        },
      }),
    },
    events: {
      append: vi.fn(async () => undefined),
      pauseRunForInput: vi.fn(async () => true),
      finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
    },
    decisionProviders: { resolve: resolveDecisions },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    recall,
    resolveDecisions,
    runtimeRun,
    async run() {
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
    },
  };
}

describe("automatic semantic recall", () => {
  it("recalls durable memory on a thread that was never compacted", async () => {
    const f = fixture();

    await f.run();

    expect(f.recall).toHaveBeenCalledOnce();
    const [request] = f.recall.mock.calls[0]!;
    expect(request.query).toBe("What did Ava decide?");
    expect(request.scope).toBe("isolated");
    // No compaction yet, so the provider must not be pointed at a history generation.
    expect(request).not.toHaveProperty("historyGeneration");
    expect(request.limit).toBeGreaterThan(0);

    const [runtimeRequest] = f.runtimeRun.mock.calls[0]! as unknown as [AgentRunRequest];
    expect(runtimeRequest.history).toEqual([]);
    expect(runtimeRequest.prompt).toContain(
      "<recalled_memory>\n- Ava decided to ship behind a feature flag.\n</recalled_memory>\n\nWhat did Ava decide?",
    );
  });
});

describe("semantic memory and decisions on a shared bot", () => {
  it("serve none of a member's runs, even with a connection the member set up", async () => {
    // The resolvers answer for anyone here, as for a member who set up the Space's connection.
    const f = fixture("member-1");

    await f.run();

    expect(f.recall).not.toHaveBeenCalled();
    expect(f.resolveDecisions).not.toHaveBeenCalled();
    const [request] = f.runtimeRun.mock.calls[0]! as unknown as [AgentRunRequest];
    expect(request.tools.map((tool) => tool.name)).not.toContain("recall_memory");
    expect(request.tools.map((tool) => tool.name)).toContain("remember");
  });
});
