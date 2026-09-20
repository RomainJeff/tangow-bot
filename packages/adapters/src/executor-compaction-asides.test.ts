import type { AgentRunRequest, SemanticMemoryRecallRequest } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

function fixture(options: {
  summary: string | null;
  compactedUpToSeq: number | null;
  messages: { id: string; seq: number; role: string; blocks: { kind: string; text: string }[] }[];
}) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
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
        memoryScope: "isolated",
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
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: options.summary,
        historyCompactedUpToSeq: options.compactedUpToSeq,
        historyCompactionGeneration: 0,
      })),
    },
    // The executor loads newest-first and reverses; hand it the same order.
    message: { findMany: vi.fn(async () => [...options.messages].reverse()) },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "What did Ava decide?" })),
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
    externalEffect: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "effect-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  const recall = vi.fn(async (_request: SemanticMemoryRecallRequest) => ({
    ok: true as const,
    value: [{ memory: "Ava decided to ship behind a feature flag.", score: 0.9 }],
  }));
  const runtimeRun = vi.fn(async function* () {
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
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
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    recall,
    runtimeRun,
    async run() {
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
    },
  };
}

describe("thread asides and the compaction summary", () => {
  const summary = "Everything through message 4.";

  // "Created by …" and group-invite notes are stored as messages and consume a sequence
  // number like any other. The summary is only trusted when the messages after its cursor
  // form an unbroken run, so an aside must stay in place until that check has run — and
  // must still never reach the model as a turn.
  const conversation = [
    { id: "m-5", seq: 5, role: "user", blocks: [{ kind: "text", text: "First question" }] },
    {
      id: "m-6",
      seq: 6,
      role: "system",
      blocks: [{ kind: "meta", text: "Added to the group chat" }],
    },
    { id: "m-7", seq: 7, role: "assistant", blocks: [{ kind: "text", text: "First answer" }] },
  ];

  it("keeps summarising a thread that holds an aside after the cursor", async () => {
    const f = fixture({ summary, compactedUpToSeq: 4, messages: conversation });

    await f.run();

    const [request] = f.runtimeRun.mock.calls[0]! as unknown as [AgentRunRequest];
    const contents = (request.history ?? []).map((entry) => entry.content);
    expect(contents.some((content) => content.includes(summary))).toBe(true);
    expect(contents.some((content) => content.includes("Added to the group chat"))).toBe(false);
    expect(contents.some((content) => content.includes("First answer"))).toBe(true);
  });

  it("drops the aside on a thread that was never compacted", async () => {
    const f = fixture({ summary: null, compactedUpToSeq: null, messages: conversation });

    await f.run();

    const [request] = f.runtimeRun.mock.calls[0]! as unknown as [AgentRunRequest];
    const contents = (request.history ?? []).map((entry) => entry.content);
    expect(contents.some((content) => content.includes("Added to the group chat"))).toBe(false);
    expect(contents.some((content) => content.includes("First question"))).toBe(true);
  });
});
