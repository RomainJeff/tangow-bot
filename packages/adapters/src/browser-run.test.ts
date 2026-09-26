import type {
  AdapterContext,
  BrowserActRequest,
  BrowserActResult,
  BrowserSnapshotNode,
  BrowserSnapshotResult,
  ComputerRef,
  DecisionRequest,
  DecisionResponse,
} from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserRunOptions } from "./browser-run.js";
import { browserRunFromTool } from "./browser-run.js";
import { browserNavigateFromTool } from "./browser-tools.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import type { FakeDecisionStep } from "./fake-decision.js";
import { FakeDecisionProvider } from "./fake-decision.js";
import { pageBrowserSessionKey } from "./page-browser-session.js";
import { RunTraceRecorder } from "./pi-run-trace.js";
import { encodeTrace } from "./trace-export.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  runId: "run-1",
  botId: "b1",
  signal: new AbortController().signal,
};
const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
const START = "https://example.test/start";
const SECRET = "sk-secret-value";

const pages = {
  welcome: {
    title: "Welcome",
    html: `<h1>Plan your trip</h1><a href="${START}#help">Help</a><button>Get started</button>`,
  },
  details: {
    title: "Trip details",
    html: `<p>Where and when?</p><input aria-label="Destination" />
      <select aria-label="Month"><option value="">Choose</option><option value="2027-04">avril 2027</option></select>
      <button>Continue</button>`,
  },
  travellers: {
    title: "Travellers",
    html: `<p>Who is going?</p><button>Just me</button><button>With family</button>`,
  },
  summary: {
    title: "Summary",
    html: `<p>All set: review your trip.</p><a href="${START}#edit">Edit</a><button>Pay 1 200 €</button><button>Go to next step</button>`,
  },
};

/**
 * The in-process page browser with click transitions: clicking a named control loads the
 * next page, as a multi-page onboarding would.
 */
class FlowBrowser extends FakeBrowserProvider {
  readonly acts: BrowserActRequest[] = [];
  private elements: BrowserSnapshotNode[] = [];

  constructor(
    private readonly transitions: Record<string, keyof typeof pages> = {},
    start: keyof typeof pages = "welcome",
  ) {
    super({ pages: { [START]: pages[start] } });
  }

  override async snapshot(...args: Parameters<FakeBrowserProvider["snapshot"]>) {
    const snap = await super.snapshot(...args);
    this.elements = snap.elements;
    return snap;
  }

  override async act(...args: Parameters<FakeBrowserProvider["act"]>): Promise<BrowserActResult> {
    const [target, request, ctx] = args;
    this.acts.push(request);
    const step = request.actions[0]!;
    const name = this.elements.find((element) => element.ref === step.ref)?.name;
    const result = await super.act(...args);
    const next = name === undefined ? undefined : this.transitions[name];
    if (result.ok && step.kind === "click" && next) {
      const session = this.sessions.get(pageBrowserSessionKey(target, ctx));
      session.load(
        `https://example.test/${next}`,
        `<title>${pages[next].title}</title>${pages[next].html}`,
      );
      const snap: BrowserSnapshotResult = session.snapshot();
      this.elements = snap.elements;
      return { ...result, ...snap };
    }
    this.elements = result.elements ?? this.elements;
    return result;
  }
}

async function open(browser: FlowBrowser) {
  await browserNavigateFromTool(browser, computer, context, { url: START });
  return browser;
}

interface Pick {
  op: string;
  /** Element name for click, or `name <- valueKey` for fill/select (`?` for none). */
  target?: string;
  probability?: number;
  goalDone?: number;
  consequential?: number;
}

/** Scripts one step by element names and value keys, never by ref numbering. */
function step(pick: Pick): (request: DecisionRequest) => DecisionResponse {
  return (request) => {
    const answers: DecisionResponse["answers"] = {};
    const operation = request.questions.operation;
    if (operation?.type !== "choice") throw new Error("expected the operation choice");
    if (!(pick.op in operation.options)) throw new Error(`operation ${pick.op} not offered`);
    answers.operation = choice(Object.keys(operation.options), pick.op, 0.9);
    if (pick.target !== undefined) {
      const question = request.questions[`${pick.op}_target`];
      if (question?.type !== "choice") throw new Error(`no ${pick.op}_target question`);
      const [name, value] = pick.target.split(" <- ");
      const key = Object.entries(question.options).find(([, text]) => {
        if (!text.includes(`"${name}"`)) return false;
        if (value === undefined) return true;
        return value === "?"
          ? text.endsWith("<- none of the provided values")
          : text.endsWith(`<- ${value}`);
      })?.[0];
      if (!key) throw new Error(`no option for ${pick.target}`);
      answers[`${pick.op}_target`] = choice(
        Object.keys(question.options),
        key,
        pick.probability ?? 0.95,
      );
    }
    if (request.questions.goal_done) {
      answers.goal_done = { type: "noul", probability: pick.goalDone ?? 0.1 };
    }
    if (request.questions.click_consequential) {
      answers.click_consequential = { type: "noul", probability: pick.consequential ?? 0.02 };
    }
    return { answers, usage: { inputTokens: 1_000, cost: 0.00004 } };
  };
}

function choice(keys: string[], chosen: string, probability: number) {
  const others = keys.filter((key) => key !== chosen);
  const probabilities = Object.fromEntries(
    others.map((key) => [key, (1 - probability) / others.length]),
  );
  probabilities[chosen] = probability;
  return { type: "choice" as const, choice: chosen, confidence: probability, probabilities };
}

function run(
  browser: FlowBrowser,
  script: FakeDecisionStep[],
  args: Record<string, unknown>,
  extra: Partial<BrowserRunOptions> = {},
) {
  const provider = new FakeDecisionProvider({ script });
  const result = browserRunFromTool(browser, computer, context, args, {
    provider,
    secrets: [SECRET],
    sleep: async () => undefined,
    ...extra,
  });
  return { provider, result };
}

const onboarding = {
  "Get started": "details",
  Continue: "travellers",
  "Just me": "summary",
} as const;

describe("browser_run", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo", level: "off", sinks: [] }));
  });

  it("completes a multi-page flow: buttons, a field from values, a drop-down by label", async () => {
    const browser = await open(new FlowBrowser(onboarding));
    const { provider, result } = run(
      browser,
      [
        step({ op: "click", target: "Get started" }),
        step({ op: "fill", target: "Destination <- destination" }),
        // A malformed speculative head is ignored; the chosen operation's head is used.
        (request) => ({
          answers: {
            ...step({ op: "select", target: "Month <- month" })(request).answers,
            fill_target: {
              type: "choice",
              choice: "not-an-option",
              confidence: 1,
              probabilities: {},
            },
          },
        }),
        step({ op: "click", target: "Continue" }),
        step({ op: "click", target: "Just me" }),
        step({ op: "done", goalDone: 0.9 }),
      ],
      {
        goal: "Start the trip form for one traveller and stop on the summary",
        values: { destination: "Lisbon", month: "avril 2027" },
      },
    );
    const outcome = await result;
    expect(outcome).toMatchObject({
      status: "done",
      url: "https://example.test/summary",
      title: "Summary",
      steps: [
        { op: "click", role: "button", name: "Get started", ok: true },
        { op: "fill", role: "textbox", name: "Destination", value: "destination", ok: true },
        { op: "select", role: "combobox", name: "Month", value: "month", ok: true },
        { op: "click", role: "button", name: "Continue", ok: true },
        { op: "click", role: "button", name: "Just me", ok: true },
      ],
    });
    expect(outcome).not.toHaveProperty("need");
    expect(browser.acts.map((act) => act.actions)).toEqual([
      [{ kind: "click", ref: expect.any(String) }],
      [{ kind: "fill", ref: expect.any(String), text: "Lisbon" }],
      [{ kind: "fill", ref: expect.any(String), text: "avril 2027" }],
      [{ kind: "click", ref: expect.any(String) }],
      [{ kind: "click", ref: expect.any(String) }],
    ]);
    expect(provider.calls).toHaveLength(6);
    // Each step sees what the last one did.
    expect((provider.calls[2]!.state as { recent: unknown[] }).recent).toEqual([
      { op: "click", element: 'button "Get started"', pageChanged: true },
      { op: "fill", element: 'textbox "Destination"', value: "destination", pageChanged: true },
    ]);
    expect(
      (outcome as { elements: BrowserSnapshotNode[] }).elements.map((element) => element.name),
    ).toContain("Pay 1 200 €");
  });

  it("stops before a consequential click, by name or by the provider, and clicks nothing", async () => {
    for (const pick of [
      step({ op: "click", target: "Pay 1 200 €" }),
      step({ op: "click", target: "Go to next step", consequential: 0.6 }),
    ]) {
      const browser = await open(new FlowBrowser({}, "summary"));
      const { result } = run(browser, [pick], { goal: "Finish the booking" });
      const outcome = await result;
      expect(outcome).toMatchObject({
        status: "needs_input",
        need: { kind: "confirm", element: { ref: expect.any(String), role: "button" } },
        steps: [],
      });
      expect(browser.acts).toHaveLength(0);
    }
    // The same neutral button is clicked when the provider does not class it as consequential.
    const browser = await open(new FlowBrowser({}, "summary"));
    const { result } = run(browser, [step({ op: "click", target: "Go to next step" })], {
      goal: "Go on",
    });
    expect(await result).toMatchObject({ steps: [{ name: "Go to next step", ok: true }] });
    expect(browser.acts).toHaveLength(1);
  });

  it("asks for a value it was not given instead of typing anything", async () => {
    const browser = await open(new FlowBrowser({}, "details"));
    const { provider, result } = run(browser, [step({ op: "fill", target: "Destination <- ?" })], {
      goal: "Fill the trip details",
    });
    expect(await result).toMatchObject({
      status: "needs_input",
      need: { kind: "value", field: { role: "textbox", name: "Destination" } },
    });
    expect(browser.acts).toHaveLength(0);
    const fill = provider.calls[0]!.questions.fill_target;
    expect(fill?.type === "choice" && Object.values(fill.options)).toContain(
      '[1] textbox "Destination" <- none of the provided values',
    );
  });

  it("hands ranked candidates back below 0.80 without acting", async () => {
    const browser = await open(new FlowBrowser(onboarding));
    const { result } = run(
      browser,
      [step({ op: "click", target: "Get started", probability: 0.6 })],
      {
        goal: "Start",
      },
    );
    const outcome = await result;
    expect(outcome).toMatchObject({
      status: "blocked",
      need: {
        kind: "blocked",
        reason: "low_confidence",
        candidates: [{ name: "Get started", probability: 0.6 }, {}],
      },
    });
    expect(browser.acts).toHaveLength(0);
  });

  it("stops a loop: no page change three times, or the same control a third time", async () => {
    const stalled = await open(new FlowBrowser({}, "travellers"));
    const noProgress = run(
      stalled,
      [
        step({ op: "click", target: "Just me" }),
        step({ op: "click", target: "With family" }),
        step({ op: "click", target: "Just me" }),
      ],
      { goal: "Pick travellers" },
    );
    expect(await noProgress.result).toMatchObject({
      status: "blocked",
      need: { reason: "no_progress" },
    });
    expect(stalled.acts).toHaveLength(3);

    const repeated = await open(new FlowBrowser({}, "details"));
    const repeat = run(
      repeated,
      [
        step({ op: "click", target: "Continue" }),
        step({ op: "fill", target: "Destination <- destination" }),
        step({ op: "click", target: "Continue" }),
        step({ op: "click", target: "Continue" }),
      ],
      { goal: "Continue", values: { destination: "Lisbon" } },
    );
    expect(await repeat.result).toMatchObject({
      status: "blocked",
      need: { reason: "repeated_control" },
    });
    expect(repeated.acts).toHaveLength(3);
  });

  it("stops at the step limit", async () => {
    const browser = await open(new FlowBrowser(onboarding));
    const { provider, result } = run(
      browser,
      [step({ op: "click", target: "Get started" }), step({ op: "click", target: "Continue" })],
      { goal: "Go through the form", maxSteps: 1 },
    );
    expect(await result).toMatchObject({
      status: "step_limit",
      need: { reason: "step_limit" },
      steps: [{ op: "click", name: "Get started" }],
    });
    expect(provider.calls).toHaveLength(1);
  });

  it("stops when the time budget runs out", async () => {
    const browser = await open(new FlowBrowser(onboarding));
    let clock = 0;
    const { result } = run(
      browser,
      [
        (request) => {
          clock += 121_000;
          return step({ op: "click", target: "Get started" })(request);
        },
      ],
      { goal: "Go through the form" },
      { now: () => clock },
    );
    expect(await result).toMatchObject({ status: "step_limit", need: { reason: "time" } });
    expect(browser.acts).toHaveLength(1);
  });

  it("vetoes a contradicted done once, then accepts the next one", async () => {
    const browser = await open(new FlowBrowser({}, "summary"));
    const { provider, result } = run(
      browser,
      [
        step({ op: "done", goalDone: 0.2 }),
        step({ op: "wait" }),
        step({ op: "done", goalDone: 0.2 }),
      ],
      { goal: "Reach the summary" },
    );
    expect(await result).toMatchObject({ status: "done", steps: [{ op: "wait", ok: true }] });
    const offered = provider.calls.map((call) => {
      const operation = call.questions.operation;
      return operation?.type === "choice" ? "done" in operation.options : undefined;
    });
    expect(offered).toEqual([true, false, true]);
  });

  it("propagates a run abort during a decision and acts on nothing", async () => {
    const browser = await open(new FlowBrowser(onboarding));
    const controller = new AbortController();
    const provider = new FakeDecisionProvider({
      script: [step({ op: "click", target: "Get started" })],
    });
    provider.latencyMs = 1_000;
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const pending = browserRunFromTool(
      browser,
      computer,
      { ...context, signal: controller.signal },
      { goal: "Start" },
      { provider, secrets: [] },
    );
    setTimeout(() => controller.abort(new Error("run cancelled")), 10);
    await expect(pending).rejects.toThrow("run cancelled");
    expect(browser.acts).toHaveLength(0);
    expect(sink.events.find((event) => event.message === "agent.browser.run")).toMatchObject({
      status: "aborted",
    });
  });

  it("never replays an action whose outcome is uncertain", async () => {
    const browser = await open(new FlowBrowser(onboarding));
    browser.actError = new Error("connection lost");
    const { provider, result } = run(
      browser,
      [step({ op: "click", target: "Get started" }), step({ op: "click", target: "Get started" })],
      { goal: "Start" },
    );
    expect(await result).toMatchObject({
      status: "blocked",
      uncertain: true,
      need: { reason: "uncertain" },
    });
    expect(browser.acts).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  });

  it("answers unavailable without a usable provider and never acts", async () => {
    const browser = await open(new FlowBrowser(onboarding));
    const none = await browserRunFromTool(
      browser,
      computer,
      context,
      { goal: "Start" },
      {
        secrets: [],
      },
    );
    expect(none).toMatchObject({ status: "unavailable", need: { reason: "no_provider" } });
    expect((none as { elements: unknown[] }).elements).toHaveLength(2);
    const failing = run(browser, [new Error("provider down")], { goal: "Start" });
    expect(await failing.result).toMatchObject({
      status: "unavailable",
      need: { reason: "error" },
    });
    expect(browser.acts).toHaveLength(0);
  });

  it("sends only the documented state, redacted, and logs no content", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const long = "lorem ipsum ".repeat(600);
    const browser = new FlowBrowser();
    browser.sessions.get(pageBrowserSessionKey(computer, context)).load(
      START,
      `<title>Account</title><p>Token ${SECRET} shown</p><input aria-label="Email" value="typed-value-marker" />
         <input aria-label="Password" type="password" value="fake-test-password" />
         <button>Save ${SECRET}</button>`,
    );
    // The in-process session has no page text; the helper puts it before the element table.
    const snapshot = browser.snapshot.bind(browser);
    browser.snapshot = async (...args) => {
      const snap = await snapshot(...args);
      return { ...snap, tree: `Token ${SECRET} shown ${long}\n${snap.tree}` };
    };
    const { provider, result } = run(browser, [step({ op: "blocked" })], {
      goal: `Update the account for ${SECRET}`,
      values: { email: `me+${SECRET}@example.test`, note: "x".repeat(300) },
    });
    expect(await result).toMatchObject({
      status: "blocked",
      need: { reason: "provider_blocked" },
    });
    const request = JSON.stringify(provider.calls[0]);
    expect(request).not.toContain(SECRET);
    expect(request).not.toContain("fake-test-password");
    const state = provider.calls[0]!.state as {
      page: { text: string };
      values: Record<string, string>;
      elements: string[];
    };
    expect(state.page.text.length).toBeLessThanOrEqual(4_001);
    expect(state.page.text).not.toContain("[e");
    expect(state.values.note!.length).toBeLessThanOrEqual(121);
    expect(state.elements).toContain('[2] textbox "Password" (password)');
    expect(state.elements).toContain('[1] textbox "Email" value="typed-value-marker"');
    const fill = provider.calls[0]!.questions.fill_target;
    expect(fill?.type === "choice" && Object.values(fill.options).join("\n")).not.toContain(
      "Password",
    );
    const logs = JSON.stringify(sink.events);
    for (const content of [SECRET, "typed-value-marker", "Update the account", "Save", "lorem"]) {
      expect(logs).not.toContain(content);
    }
    expect(sink.events.find((event) => event.message === "agent.browser.run")).toMatchObject({
      runId: "run-1",
      status: "blocked",
      reason: "provider_blocked",
      needKind: "blocked",
      steps: 0,
      decisions: 1,
      decisionAnswered: 1,
      inputTokens: 1_000,
      cost: 0.00004,
      durationMs: expect.any(Number),
    });
    expect(sink.events.find((event) => event.message === "agent.decision.call")).toMatchObject({
      purpose: "run_step",
    });
  });

  it("refuses malformed input before reading the page", async () => {
    const browser = await open(new FlowBrowser(onboarding));
    for (const args of [
      {},
      { goal: "x".repeat(501) },
      { goal: "Start", values: { destination: 3 } },
      { goal: "Start", values: ["Lisbon"] },
    ]) {
      const { provider, result } = run(browser, [], args);
      expect(await result).toMatchObject({ error: expect.stringContaining("browser_run") });
      expect(provider.calls).toHaveLength(0);
    }
  });

  it("records one generation per step under the browser_run tool span", async () => {
    const recorder = new RunTraceRecorder({
      runId: "run-1",
      threadId: "thread-1",
      botId: "b1",
      provider: "test",
      model: "agent-model",
      systemPrompt: "",
      history: [],
      prompt: "start the trip",
    });
    recorder.toolStart("call-1", "browser_run", { goal: "Start" });
    const browser = await open(new FlowBrowser(onboarding));
    const { provider, result } = run(
      browser,
      [
        step({ op: "click", target: "Get started" }),
        step({ op: "fill", target: "Destination <- ?" }),
      ],
      { goal: "Start the trip" },
      { trace: recorder.toolTrace("call-1") },
    );
    await result;
    recorder.finish("done");
    const payload = encodeTrace(recorder.trace) as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{
            name: string;
            spanId: string;
            parentSpanId?: string;
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
          }>;
        }>;
      }>;
    };
    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
    const attr = (span: (typeof spans)[number], key: string) => {
      const value = span.attributes.find((entry) => entry.key === key)?.value;
      return value?.stringValue ?? value?.doubleValue ?? value?.intValue;
    };
    const tool = spans.find((span) => span.name === "tool browser_run")!;
    const first = spans.find((span) => span.name === "decision step 1")!;
    const second = spans.find((span) => span.name === "decision step 2")!;
    expect(first.parentSpanId).toBe(tool.spanId);
    expect(second.parentSpanId).toBe(tool.spanId);
    expect(JSON.parse(String(attr(first, "langfuse.observation.input")))).toEqual(
      provider.calls[0],
    );
    expect(JSON.parse(String(attr(first, "langfuse.observation.output")))).toMatchObject({
      operation: { choice: "click" },
    });
    expect(attr(first, "langfuse.observation.metadata.gate")).toBe("act");
    expect(attr(first, "langfuse.observation.metadata.action")).toBe("click button");
    expect(attr(first, "langfuse.observation.metadata.purpose")).toBe("run_step");
    expect(attr(second, "langfuse.observation.metadata.gate")).toBe("needs_value");
  });
});
