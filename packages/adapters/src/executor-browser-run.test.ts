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
import { BROWSER_ACT_LOCKED_MESSAGE } from "./browser-run.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import type * as ComputerWorkspaceModule from "./computer-workspace.js";
import { createRunExecutor } from "./executor.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { FakeDecisionProvider } from "./fake-decision.js";
import { recordingSessionLog } from "./session-log/recording.test-support.js";

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

/** Answers one step: the operation and, when given, the target whose option text matches. */
function answer(op: string, target?: (text: string) => boolean) {
  return (request: DecisionRequest): DecisionResponse => {
    const spread = (keys: string[], chosen: string) =>
      Object.fromEntries(keys.map((k) => [k, k === chosen ? 0.95 : 0.05 / (keys.length - 1)]));
    const operation = request.questions.operation;
    if (operation?.type !== "choice") throw new Error("expected the operation choice");
    const answers: DecisionResponse["answers"] = {
      operation: {
        type: "choice",
        choice: op,
        confidence: 0.95,
        probabilities: spread(Object.keys(operation.options), op),
      },
    };
    if (target) {
      const question = request.questions[`${op}_target`];
      if (question?.type !== "choice") throw new Error(`expected ${op}_target`);
      const key = Object.entries(question.options).find(([, text]) => target(text))![0];
      answers[`${op}_target`] = {
        type: "choice",
        choice: key,
        confidence: 0.95,
        probabilities: spread(Object.keys(question.options), key),
      };
    }
    return { answers };
  };
}

const clickSearch = answer("click", (text) => text.endsWith('"Search"'));

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
  const log = recordingSessionLog();
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
        id: run.botId,
        name: "Assistant",
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
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
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
        html: `<input aria-label="Query" /><button>Search</button><button>Send report</button>`,
      },
    },
  });
  let tools: ConnectorTool[] = [];
  let instructions = "";
  const results: unknown[] = [];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    tools = request.tools;
    instructions = request.instructions;
    const act = { actions: [{ kind: "click", ref: "e-missing" }] };
    results.push(await request.executeTool!("browser_navigate", { url: PAGE }, "call-1"));
    results.push(await request.executeTool!("browser_act", act, "call-act-before"));
    results.push(
      await request.executeTool!(
        "browser_run",
        { goal: "Search for tents", values: { query: "tents" }, maxSteps: 1 },
        "call-2",
        undefined,
        trace,
      ),
    );
    results.push(await request.executeTool!("browser_act", act, "call-act-after"));
    yield { type: "done" as const, text: "Done" };
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const executor = createRunExecutor({
    sessionLog: log.sessionLog,
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
  it("resolves the connection again when browser_run is called, so a disconnect takes effect", async () => {
    const provider = new FakeDecisionProvider({ script: [clickSearch] });
    let resolves = 0;
    // Connected when the run starts, disconnected by the time the model calls browser_run.
    const outcome = await runWithDecisionProvider(async () => (++resolves === 1 ? provider : null));
    expect(outcome.offered).toBe(true);
    expect(outcome.results[2]).toMatchObject({ status: "unavailable" });
    expect(provider.calls).toHaveLength(0);
  });

  it("offers browser_run only when the Space decision provider resolves", async () => {
    for (const resolve of [
      async () => null,
      async () => {
        throw new Error("decision connection unreadable");
      },
    ]) {
      const hidden = await runWithDecisionProvider(resolve);
      expect(hidden).toMatchObject({ offered: false, instructed: false });
      expect(hidden.results[2]).toMatchObject({ status: "unavailable" });
      expect(hidden.results[0]).not.toHaveProperty("next");
      // Without a provider browser_act is never held back.
      expect(hidden.browser.acts).toHaveLength(2);
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
      // browser_act waits for browser_run, then opens once it stopped short.
      expect(connected.results[1]).toMatchObject({
        error: expect.stringContaining("Call browser_run"),
      });
      expect(connected.results[3]).not.toMatchObject({
        error: expect.stringContaining("Call browser_run"),
      });
      expect(connected.results[2]).toMatchObject({
        status: "step_limit",
        steps: [{ op: "click", role: "button", name: "Search", ok: true }],
      });
      expect(connected.browser.acts).toHaveLength(2);
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

  it("opens browser_act after browser_run stops short, but not when it asks for a value", async () => {
    for (const [script, stop, unlocked] of [
      [
        answer("click", (text) => text.endsWith('"Send report"')),
        { need: { kind: "confirm" } },
        true,
      ],
      [answer("blocked"), { status: "blocked" }, true],
      [
        answer("fill", (text) => text.endsWith("<- none of the provided values")),
        { need: { kind: "value", field: { name: "Query" } } },
        false,
      ],
    ] as const) {
      const provider = new FakeDecisionProvider({ script: [script] });
      const { results, browser } = await runWithDecisionProvider(async () => provider);
      expect(results[2]).toMatchObject(stop);
      if (unlocked) {
        // The act reaches the page (its stale ref fails there), not the lock.
        expect(results[3]).not.toMatchObject({ error: BROWSER_ACT_LOCKED_MESSAGE });
        expect(browser.acts).toHaveLength(1);
      } else {
        // The model passes the value to browser_run instead of finishing the form by hand.
        expect(results[3]).toMatchObject({
          error: expect.stringContaining("call browser_run again with that value in values"),
        });
        expect(browser.acts).toHaveLength(0);
      }
    }
  });
});
