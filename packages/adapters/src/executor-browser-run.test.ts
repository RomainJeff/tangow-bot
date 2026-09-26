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

/** Clicks the Search button; later calls are not scripted. */
function clickSearch(request: DecisionRequest): DecisionResponse {
  const operation = request.questions.operation;
  const target = request.questions.click_target;
  if (operation?.type !== "choice" || target?.type !== "choice") throw new Error("expected click");
  const key = Object.entries(target.options).find(([, text]) => text.endsWith('"Search"'))![0];
  const spread = (keys: string[], chosen: string) =>
    Object.fromEntries(keys.map((k) => [k, k === chosen ? 0.95 : 0.05 / (keys.length - 1)]));
  const ops = Object.keys(operation.options);
  const options = Object.keys(target.options);
  return {
    answers: {
      operation: {
        type: "choice",
        choice: "click",
        confidence: 0.95,
        probabilities: spread(ops, "click"),
      },
      click_target: {
        type: "choice",
        choice: key,
        confidence: 0.95,
        probabilities: spread(options, key),
      },
    },
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
        html: `<input aria-label="Query" /><button>Search</button>`,
      },
    },
  });
  let tools: ConnectorTool[] = [];
  let instructions = "";
  const results: unknown[] = [];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    tools = request.tools;
    instructions = request.instructions;
    results.push(await request.executeTool!("browser_navigate", { url: PAGE }, "call-1"));
    results.push(
      await request.executeTool!(
        "browser_run",
        { goal: "Search for tents", values: { query: "tents" }, maxSteps: 1 },
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
  const effects = prisma.externalEffect.create.mock.calls.map(
    ([args]) => (args as { data: { kind?: string } }).data.kind,
  );
  return {
    browser,
    results,
    effects,
    offered: tools.some((tool) => tool.name === "browser_run"),
    instructed: instructions.includes("hand the whole page task to browser_run"),
  };
}

describe("browser_run executor wiring", () => {
  it("offers browser_run only when the Space decision provider resolves", async () => {
    for (const resolve of [
      async () => null,
      async () => {
        throw new Error("decision connection unreadable");
      },
    ]) {
      const hidden = await runWithDecisionProvider(resolve);
      expect(hidden).toMatchObject({ offered: false, instructed: false });
      expect(hidden.results[1]).toMatchObject({ status: "unavailable" });
      expect(hidden.results[0]).not.toHaveProperty("next");
      expect(hidden.browser.acts).toHaveLength(0);
    }

    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    try {
      const provider = new FakeDecisionProvider({ script: [clickSearch] });
      const generations: string[] = [];
      const trace: ToolCallTrace = {
        generation: (name) => {
          generations.push(name);
          return { end: () => undefined };
        },
      };
      const connected = await runWithDecisionProvider(async () => provider, trace);
      expect(connected).toMatchObject({ offered: true, instructed: true });
      // The page result itself points at browser_run, where a light model actually looks.
      expect(connected.results[0]).toMatchObject({ next: expect.stringContaining("browser_run") });
      expect(connected.results[1]).toMatchObject({
        status: "step_limit",
        steps: [{ op: "click", role: "button", name: "Search", ok: true }],
      });
      expect(connected.browser.acts).toHaveLength(1);
      expect(generations).toEqual(["decision step 1"]);
      // One effect for the whole call, however many steps ran inside it.
      expect(connected.effects.filter((name) => name === "browser_run")).toHaveLength(1);
      expect(sink.events.find((event) => event.message === "agent.browser.run")).toMatchObject({
        runId: "run-1",
        status: "step_limit",
        steps: 1,
      });
    } finally {
      installLogger(createLogger({ service: "rakazo", level: "off", sinks: [] }));
    }
  });
});
