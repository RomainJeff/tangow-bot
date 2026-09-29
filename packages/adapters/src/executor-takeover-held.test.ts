import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import type * as ComputerWorkspaceModule from "./computer-workspace.js";
import { createRunExecutor } from "./executor.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { DESKTOP_HELD_FOR_TAKEOVER_MESSAGE } from "./takeover-resume.js";

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

async function runHeld() {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "waiting_takeover",
    trigger: "user",
    leaseFence: 0,
    checkpoint: null as string | null,
  };
  let messageSeq = 0;
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
      findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })),
      update: vi.fn(async () => ({ nextMessageSeq: 1, nextEventSeq: 1 })),
    },
    message: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        messageSeq += 1;
        return { id: `message-${messageSeq}`, seq: messageSeq, ...data };
      }),
    },
    event: { create: vi.fn(async () => ({ id: "event-1" })) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Find the game" })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
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
    externalEffect: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: object }) => ({ ...data, id: "effect-1" })),
      update: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  (prisma as unknown as { $transaction: unknown }).$transaction = vi.fn(
    async (fn: (tx: typeof prisma) => unknown) => fn(prisma),
  );
  let tools: ConnectorTool[] = [];
  const results: Record<string, unknown> = {};
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    tools = request.tools;
    results.snapshot = await request.executeTool!("browser_snapshot", {}, "call-1");
    results.navigate = await request.executeTool!(
      "browser_navigate",
      { url: "https://example.test/games" },
      "call-2",
    );
    yield { type: "done" as const, text: "Done" };
  });
  const pauseRunForTakeover = vi.fn(async () => true);
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: { discoverTools: async () => [], resolveCall: async () => undefined },
    sandbox: { describe: () => ({ capabilities: { graphical: true } }) },
    browser: new FakeBrowserProvider(),
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: {
      append: vi.fn(async () => undefined),
      finalizeRun,
      notify: vi.fn(async () => undefined),
      pauseRunForTakeover,
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun(run.id, "worker-1");
  return { tools, results, pauseRunForTakeover, finalizeRun };
}

describe("a run held for takeover", () => {
  it("CT5: lets the bot look at the page while the user holds the screen, but not act on it", async () => {
    const held = await runHeld();

    const names = held.tools.map((tool) => tool.name);
    expect(names).toContain("browser_snapshot");
    expect(names).toContain("browser_navigate");
    expect(held.results.snapshot).not.toHaveProperty("error");
    expect(held.results.navigate).toEqual({ error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE });
    expect(held.finalizeRun).not.toHaveBeenCalled();
    expect(held.pauseRunForTakeover).toHaveBeenCalledOnce();
  });
});
