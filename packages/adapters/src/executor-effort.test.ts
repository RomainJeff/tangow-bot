import type { AgentRunRequest, DecisionProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import type * as ComputerWorkspaceModule from "./computer-workspace.js";
import { createRunExecutor } from "./executor.js";
import { FakeDecisionProvider } from "./fake-decision.js";
import { PiAgentRuntime } from "./pi-runtime.js";

vi.mock("./computer-workspace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerWorkspaceModule>()),
  checkpointRunComputerWorkspace: async () => undefined,
}));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({
    id: "computer-1",
    botId: "bot-1",
    kind: "fake",
    providerRef: "c1",
  }),
}));

/** The level the runtime was handed for one run of a bot on a reasoning model. */
async function runtimeThinkingLevel(
  botThinkingLevel: string | null,
  decisionProvider: DecisionProvider | null,
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
    sourceMessageId: "message-2",
    leaseFence: 0,
  };
  const turn = (id: string, seq: number, role: "user" | "bot", text: string) => ({
    id,
    threadId: run.threadId,
    seq,
    role,
    runId: null,
    botId: role === "bot" ? run.botId : null,
    blocks: [{ kind: "text", text }],
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
        thinkingLevel: botThinkingLevel,
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
      findMany: vi.fn(async () => [
        turn("message-2", 2, "user", "Thanks!"),
        turn("message-1", 1, "bot", "Here is the summary."),
      ]),
      findFirst: vi.fn(async () => null),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Thanks!" })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "anthropic/claude-opus-4.8",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    agentSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    skillSetting: { findMany: vi.fn(async () => []) },
    botSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
    externalEffect: { findMany: vi.fn(async () => []) },
  };
  let model: AgentRunRequest["model"] | undefined;
  const pi = new PiAgentRuntime();
  const executor = createRunExecutor({
    prisma,
    runtime: {
      describe: () => ({ capabilities: { scripted: false } }),
      thinkingLevels: (requested: AgentRunRequest["model"]) => pi.thinkingLevels(requested),
      run: async function* (request: AgentRunRequest) {
        model = request.model;
        yield { type: "done" as const, text: "You're welcome." };
      },
    },
    connector: { discoverTools: async () => [], resolveCall: async () => undefined },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    decisionProviders: { resolve: async () => decisionProvider },
    events: {
      append: vi.fn(async () => undefined),
      finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun(run.id, "worker-1");
  return model?.thinkingLevel;
}

const answerLowest = {
  answers: {
    effort: {
      type: "score" as const,
      score: 0,
      confidence: 0.9,
      probabilities: { "0": 0.9, "1": 0.1 },
    },
  },
};

describe("run effort", () => {
  it("runs at the level the decision model picks when the bot has none", async () => {
    const provider = new FakeDecisionProvider({ script: [answerLowest] });
    expect(await runtimeThinkingLevel(null, provider)).toBe("low");
    expect(provider.calls.map((request) => request.state)).toEqual([
      { message: "Thanks!", earlier: [{ role: "assistant", text: "Here is the summary." }] },
    ]);
  });

  it("keeps the bot's hand-picked level", async () => {
    const provider = new FakeDecisionProvider({ script: [answerLowest] });
    expect(await runtimeThinkingLevel("high", provider)).toBe("high");
    expect(provider.calls).toHaveLength(0);
  });

  it("keeps today's default without a decision model", async () => {
    expect(await runtimeThinkingLevel(null, null)).toBeNull();
  });
});
