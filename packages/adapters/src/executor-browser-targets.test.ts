import type {
  AgentRunRequest,
  BrowserActRequest,
  ConnectorTool,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  ToolCallTrace,
} from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import type * as ComputerWorkspaceModule from "./computer-workspace.js";
import { createRunExecutor } from "./executor.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { FakeDecisionProvider } from "./fake-decision.js";

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

const PAGE = "https://example.test/reports";

class CountingBrowser extends FakeBrowserProvider {
  readonly acts: BrowserActRequest[] = [];
  override async act(...args: Parameters<FakeBrowserProvider["act"]>) {
    this.acts.push(args[1]);
    return super.act(...args);
  }
}

function chooseDownloadCsv(request: DecisionRequest): DecisionResponse {
  const question = request.questions.target;
  if (question?.type !== "choice") throw new Error("expected a choice");
  const choice = Object.entries(question.options).find(([, text]) =>
    text.endsWith('"Download CSV"'),
  )![0];
  const probabilities = Object.fromEntries(Object.keys(question.options).map((key) => [key, 0]));
  probabilities[choice] = 0.95;
  probabilities.none = 0.05;
  return { answers: { target: { type: "choice", choice, confidence: 0.95, probabilities } } };
}

function landed(): DecisionResponse {
  const probabilities = { landed: 0.9, dialog: 0.025, error: 0.025, auth: 0.025, unchanged: 0.025 };
  return {
    answers: { outcome: { type: "choice", choice: "landed", confidence: 0.9, probabilities } },
  };
}

async function runWithDecisionProvider(
  resolve: () => Promise<DecisionProvider | null>,
  trace?: ToolCallTrace,
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
    message: { findMany: vi.fn(async () => []) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Get the CSV" })) },
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
  const browser = new CountingBrowser({
    pages: {
      [PAGE]: {
        title: "Reports",
        html: `<a href="${PAGE}">Download</a><a href="${PAGE}">Download CSV</a>`,
      },
    },
  });
  let tools: ConnectorTool[] = [];
  const results: unknown[] = [];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    tools = request.tools;
    results.push(await request.executeTool!("browser_navigate", { url: PAGE }, "call-1"));
    results.push(
      await request.executeTool!(
        "browser_act",
        { actions: [{ kind: "click", target: "the Download CSV link" }] },
        "call-2",
        undefined,
        trace,
      ),
    );
    yield { type: "done" as const, text: "Done" };
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: { discoverTools: async () => [], resolveCall: async () => undefined },
    sandbox: { describe: () => ({ capabilities: { graphical: true } }) },
    browser,
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    decisionProviders: { resolve },
    events: { append: vi.fn(async () => undefined), finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalledOnce();
  expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  const act = tools.find((tool) => tool.name === "browser_act")!;
  const items = (act.inputSchema as { properties: { actions: { items: { properties: object } } } })
    .properties.actions.items.properties;
  return { browser, results, hasTarget: "target" in items };
}

describe("run decision provider wiring", () => {
  it("offers browser_act targets only when the Space decision provider resolves", async () => {
    const broken = await runWithDecisionProvider(async () => {
      throw new Error("decision connection unreadable");
    });
    expect(broken.hasTarget).toBe(false);
    expect(broken.results[1]).toMatchObject({ ok: false, error: expect.stringMatching(/ref/) });
    expect(broken.browser.acts).toHaveLength(0);

    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    try {
      const provider = new FakeDecisionProvider({ script: [chooseDownloadCsv, landed] });
      const generations: string[] = [];
      const trace: ToolCallTrace = {
        generation: (name) => {
          generations.push(name);
          return { end: () => undefined };
        },
      };
      const connected = await runWithDecisionProvider(async () => provider, trace);
      expect(generations).toEqual(["decision target", "decision verify"]);
      expect(connected.hasTarget).toBe(true);
      expect(provider.calls).toHaveLength(2);
      expect(connected.browser.acts).toHaveLength(1);
      expect(connected.results[1]).toMatchObject({
        ok: true,
        completed: 1,
        outcome: { kind: "landed", probability: 0.9 },
      });
      expect(sink.events.find((event) => event.message === "agent.run.decision")).toMatchObject({
        decisionCalls: 1,
        decisionExecuted: 1,
        verifyCalls: 1,
        verifyAnswered: 1,
      });
    } finally {
      installLogger(createLogger({ service: "rakazo", level: "off", sinks: [] }));
    }
  });
});
