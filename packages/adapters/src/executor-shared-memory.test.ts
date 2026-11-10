import type {
  AdapterContext,
  AgentRunRequest,
  ConnectorTool,
  MemoryCommitRequest,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { recordingSessionLog } from "./session-log/recording.test-support.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "docker" }),
}));

/** A run of `runUserId` on the owner's bot that calls `remember` once with `args`. */
function fixture(options: {
  visibility: string;
  runUserId: string;
  args: object;
  /** The person set up semantic memory, so their own facts go to `save_memory`. */
  semantic?: boolean;
}) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: options.runUserId,
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
      findFirst: vi.fn(async () => ({ visibility: options.visibility })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        userId: "owner",
        visibility: options.visibility,
        connectors: [],
        name: "Notes",
        title: "Notes",
        description: "",
        memoryScope: null,
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
      findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Remember" })) },
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
    botMcpServer: { findMany: vi.fn(async () => []) },
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
  const commit = vi.fn(async (request: MemoryCommitRequest, _context: AdapterContext) => ({
    id: "doc-1",
    path: request.path,
    revision: 1,
    content: request.content,
  }));
  let remember: ConnectorTool | undefined;
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    remember = request.tools.find((tool) => tool.name === "remember");
    await request.executeTool!("remember", { content: "Ship on Thursdays", ...options.args }, "c1");
    yield { type: "done" as const, text: "Noted." };
  });
  const executor = createRunExecutor({
    sessionLog: log.sessionLog,
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }), commit },
    memoryProviders: {
      resolve: async () =>
        options.semantic
          ? {
              defaultScope: "isolated" as const,
              provider: {
                describe: () => ({ capabilities: { recall: true, save: true } }),
                recall: async () => ({ ok: true as const, value: [] }),
                save: vi.fn(),
                purgeHistory: vi.fn(),
              },
            }
          : null,
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
    async run() {
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      const [[request, context]] = commit.mock.calls as [[MemoryCommitRequest, AdapterContext]];
      return {
        saved: { scope: request.scope, as: context.userId, sourceRunId: request.sourceRunId },
        offersTeam: Boolean(
          (remember!.inputSchema as { properties: Record<string, unknown> }).properties.team,
        ),
        description: remember!.description,
      };
    },
  };
}

describe("remember on a shared bot", () => {
  it("saves a member's team fact under the owner and keeps the run that wrote it", async () => {
    const f = fixture({ visibility: "space", runUserId: "dana", args: { team: true } });

    await expect(f.run()).resolves.toMatchObject({
      saved: { scope: "team", as: "owner", sourceRunId: "run-1" },
      offersTeam: true,
    });
  });

  it("saves a member's own fact in their own memory of the bot", async () => {
    const f = fixture({ visibility: "people", runUserId: "dana", args: {} });

    await expect(f.run()).resolves.toMatchObject({ saved: { scope: "bot", as: "dana" } });
  });

  it("offers no team flag on a private bot and ignores one", async () => {
    const f = fixture({ visibility: "private", runUserId: "owner", args: { team: true } });

    await expect(f.run()).resolves.toMatchObject({
      saved: { scope: "bot", as: "owner", sourceRunId: "run-1" },
      offersTeam: false,
    });
  });

  it("keeps remember for the team when the owner's own facts go to semantic memory", async () => {
    const f = fixture({ visibility: "space", runUserId: "owner", args: {}, semantic: true });

    await expect(f.run()).resolves.toEqual({
      saved: { scope: "team", as: "owner", sourceRunId: "run-1" },
      offersTeam: false,
      description: expect.stringContaining("everyone who uses this bot"),
    });
  });
});
