import type { AgentRunRequest, MemoryStore } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

const document = {
  id: "memory-1",
  path: "MEMORY.md",
  content: "The private launch date is Tuesday.",
  revision: 2,
  accessVersion: 4,
};

function fixture(run: (request: AgentRunRequest) => AsyncGenerator<unknown>) {
  let active = true;
  const persistedManifests: unknown[] = [];
  const memoryCommit = vi.fn(async () => ({
    id: "proposal-1",
    path: "MEMORY.md",
    revision: 1,
    content: "must not persist",
  }));
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const row = {
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
      findUnique: vi.fn(async () => row),
      findUniqueOrThrow: vi.fn(async () => row),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if ("memoryContextManifest" in data) persistedManifests.push(data.memoryContextManifest);
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: row.botId,
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
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: row.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactionMemoryManifest: [],
        historyCompactedUpToSeq: null,
        historyCompactionGeneration: 0,
      })),
    },
    message: { findMany: vi.fn(async () => []) },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: row.taskId,
        prompt: "Help me plan.",
      })),
    },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "test",
        defaultModelId: "test",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    skillSetting: { findMany: vi.fn(async () => []) },
    botSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: {
      findUnique: vi.fn(async () => ({ enabled: false })),
    },
    externalEffect: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "effect-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  const memory: MemoryStore = {
    describe: () => ({
      id: "local",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { search: true, revisions: true, markdownPortable: true },
    }),
    read: vi.fn(async () => ({ documents: active ? [document] : [] })),
    search: vi.fn(async () =>
      active
        ? [
            {
              documentId: document.id,
              revision: document.revision,
              accessVersion: document.accessVersion,
              path: document.path,
              snippet: "stale provider text",
              score: 1,
            },
          ]
        : [],
    ),
    commit: memoryCommit,
    exportMarkdown: async function* () {},
    importMarkdown: async () => ({
      id: "import-1",
      path: "MEMORY.md",
      revision: 1,
      content: "",
    }),
  };
  const executor = createRunExecutor({
    prisma,
    runtime: {
      describe: () => ({ capabilities: { scripted: false } }),
      run: (request: AgentRunRequest) => run(request),
      abort: vi.fn(async () => undefined),
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory,
    memoryProviders: { resolve: async () => null },
    events: {
      append: vi.fn(async () => undefined),
      pauseRunForInput: vi.fn(async () => true),
      finalizeRun,
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    memoryCommit,
    finalizeRun,
    persistedManifests,
    withdraw() {
      active = false;
    },
    run: () => executor.continueRun(row.id, "worker-1"),
  };
}

describe("runtime memory revocation", () => {
  it("aborts after injected memory is withdrawn before a tool, without executing or completing a stale reply", async () => {
    let f!: ReturnType<typeof fixture>;
    f = fixture(async function* (request) {
      await request.beforeModelCall?.();
      f.withdraw();
      const result = await request.executeTool!(
        "remember",
        { content: "must not persist" },
        "call-1",
      );
      expect(result).toMatchObject({
        error: expect.stringContaining("Memory access changed"),
      });
      yield { type: "done", text: "stale answer" };
    });

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.finalizeRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error: expect.stringContaining("Memory access changed"),
      }),
    );
  });

  it("persists a hydrated dynamic recall and blocks the next model continuation after withdrawal", async () => {
    let f!: ReturnType<typeof fixture>;
    let continuationBlocked = false;
    let recalled: unknown;
    f = fixture(async function* (request) {
      await request.beforeModelCall?.();
      recalled = await request.executeTool!(
        "recall_memory",
        { query: "launch date" },
        "call-recall",
      );
      f.withdraw();
      await expect(request.beforeModelCall?.()).rejects.toThrow("Memory access changed");
      continuationBlocked = true;
      yield { type: "done", text: "stale continuation" };
    });

    await f.run();

    expect(continuationBlocked).toBe(true);
    expect(recalled).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ id: "memory-1", memory: document.content })],
    });
    expect(f.persistedManifests).toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: "memory-1",
          revision: 2,
          accessVersion: 4,
        }),
      ]),
    );
    expect(f.finalizeRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
  });
});
