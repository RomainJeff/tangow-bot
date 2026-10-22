import type { Message } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type * as PiProviders from "@earendil-works/pi-ai/providers/all";
import type { AgentRunRequest, SemanticMemoryRecallRequest } from "@rakazo/adapter-kit";
import type { SessionEntry } from "@rakazo/contracts";
import { SessionEntrySchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { recordingSessionLog } from "./session-log/recording.test-support.js";

type Transcript = { messages: Message[] };

const sent = vi.hoisted(() => [] as Transcript[]);

// The real Pi runtime and catalog, with the network call replaced: what reaches `streamSimple` is
// the provider-neutral request every provider adapter serializes.
vi.mock("@earendil-works/pi-ai/providers/all", async (importOriginal) => {
  const actual = await importOriginal<typeof PiProviders>();
  return {
    ...actual,
    builtinModels: (...args: Parameters<typeof actual.builtinModels>) => {
      const models = actual.builtinModels(...args);
      models.streamSimple = (_model, context) => {
        sent.push(structuredClone(context));
        const message = fauxAssistantMessage("Done");
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        });
        return stream;
      };
      return models;
    },
  };
});

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

const BOT = "bot-1";

function chain(bodies: readonly object[]): SessionEntry[] {
  return bodies.map((body, seq) =>
    SessionEntrySchema.parse({
      id: `e-${seq}`,
      sessionId: "session-1",
      seq,
      parentId: seq === 0 ? null : `e-${seq - 1}`,
      ts: new Date(Date.UTC(2026, 9, 11, 9, 0, seq)).toISOString(),
      ...body,
    }),
  );
}

const said = (text: string) => ({
  type: "user.message",
  payload: { blocks: [{ kind: "text", text }], source: "app" },
});
const answered = (runId: string, text: string) => [
  {
    botId: BOT,
    runId,
    type: "run.started",
    payload: {
      trigger: { kind: "direct" },
      model: { provider: "openai", id: "gpt-4o" },
      effort: null,
    },
  },
  { botId: BOT, runId, type: "assistant.text", payload: { blocks: [{ kind: "text", text }] } },
];

/** One user turn of the thread, as the provider receives its first request. */
async function turn(options: {
  runId: string;
  tail: SessionEntry[];
  memory: string;
  openWork: string;
  recalled: string;
  connectorTools?: AgentRunRequest["tools"];
  secrets?: string[];
}): Promise<Transcript> {
  const source = options.tail.at(-1)!;
  const run = {
    id: options.runId,
    botId: BOT,
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    sessionId: "session-1",
    routineId: null,
    sourceMessageId: source.id,
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };
  const log = recordingSessionLog();
  log.sessionLog.readTail.mockResolvedValue(options.tail);
  const prompt = source.type === "user.message" ? source.payload.blocks[0] : undefined;
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
        id: BOT,
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
      findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, botId: BOT, groupId: null })),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.taskId,
        prompt: prompt?.kind === "text" ? prompt.text : "",
      })),
    },
    routine: { findUnique: vi.fn(async () => null) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openai",
        defaultModelId: "gpt-4o",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    skillSetting: { findMany: vi.fn(async () => []) },
    botSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: {
      findMany: vi.fn(async () => [
        {
          id: "item-1",
          title: options.openWork,
          notes: "",
          status: "open",
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ]),
    },
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
  const executor = createRunExecutor({
    sessionLog: log.sessionLog,
    skillLearning: "off",
    prisma,
    runtime: new PiAgentRuntime(),
    connector: { discoverTools: async () => options.connectorTools ?? [] },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      read: async ({ scope }: { scope: string }) => ({
        documents:
          scope === "bot"
            ? [{ path: "facts.md", content: options.memory, revision: 1, updatedAt: "" }]
            : [],
      }),
    },
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
          recall: async (_request: SemanticMemoryRecallRequest) => ({
            ok: true as const,
            value: [{ memory: options.recalled, score: 0.9 }],
          }),
          save: vi.fn(),
          purgeHistory: vi.fn(),
        },
      }),
    },
    events: {
      append: vi.fn(async () => undefined),
      pauseRunForInput: vi.fn(async () => true),
      claimSteering: vi.fn(async () => []),
      finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: options.secrets ?? [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  const before = sent.length;
  await executor.continueRun(run.id, "worker-1");
  const first = sent[before];
  if (!first) throw new Error("the run never reached the provider");
  return first;
}

/** The first `count` messages of a request. Provider adapters never send the timestamps. */
function leading(sent: Transcript, count: number): string {
  return JSON.stringify(
    sent.messages.slice(0, count).map(({ timestamp: _sent, ...message }) => message),
  );
}

const newest = (sent: Transcript) => JSON.stringify(sent.messages.at(-1));

describe("the prompt prefix across turns of one thread", () => {
  it("stays byte-identical up to the new turn while memory, open work and recall change", async () => {
    const history = [said("Plan the launch."), ...answered("run-0", "Launch is Tuesday.")];
    const connectorTools = ["z_lookup", "a_lookup"].map((name) => ({
      name,
      description: "Look up a record.",
      inputSchema: { type: "object", properties: {} },
    }));
    const first = await turn({
      runId: "run-1",
      tail: chain([...history, said("Who writes the post?")]),
      memory: "Prefers short posts. <fake-secret>&",
      secrets: ["<fake-secret>&"],
      openWork: "Draft the post <fake-secret>&",
      recalled: "Last launch slipped a day. <fake-secret>&",
      connectorTools,
    });
    const second = await turn({
      runId: "run-2",
      tail: chain([
        ...history,
        said("Who writes the post?"),
        ...answered("run-1", "Ava writes it."),
        said("And the deadline?"),
      ]),
      memory: "Prefers short posts. Ships on Tuesdays. <fake-secret>&",
      secrets: ["<fake-secret>&"],
      openWork: "Review the post <fake-secret>&",
      recalled: "Ava owns launch copy. <fake-secret>&",
      connectorTools: connectorTools.toReversed(),
    });

    expect(second.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(first.messages).toHaveLength(4);
    const declaredTools = first.messages.find((message) => message.role === "system")?.toolsAdded;
    expect(declaredTools?.slice(-2).map((tool) => tool.name)).toEqual(["a_lookup", "z_lookup"]);
    expect(leading(second, 3)).toBe(leading(first, 3));
    expect(second.messages[3]).toMatchObject({ content: "Who writes the post?" });
    expect(newest(first)).toContain("Prefers short posts.");
    expect(newest(first)).toContain("Draft the post");
    expect(newest(first)).toContain("Last launch slipped a day.");
    expect(newest(second)).toContain("Ships on Tuesdays.");
    expect(newest(second)).toContain("Review the post");
    expect(newest(second)).toContain("Ava owns launch copy.");
    expect(newest(second)).toContain("And the deadline?");
    for (const request of [first, second]) {
      expect(newest(request)).toContain("[redacted]");
      expect(newest(request)).not.toContain("&lt;fake-secret&gt;&amp;");
      expect(newest(request)).not.toContain("<fake-secret>&");
    }
  });
});
