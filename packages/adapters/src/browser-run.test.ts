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
  duration: {
    title: "Duration",
    html: `<p>How long?</p><input aria-label="Destination" />
      <select aria-label="Durée approximative"><option value="">Choisir</option><option value="7">1 semaine</option><option value="14">2 semaines</option><option value="21" disabled>3 semaines</option></select>
      <button>Continuer</button>`,
  },
  longList: {
    title: "Countries",
    html: `<select aria-label="Country"><option value="" disabled selected>Choose</option>${Array.from(
      { length: 40 },
      (_, n) => `<option value="c${n + 1}">Country ${n + 1}</option>`,
    ).join("")}</select>`,
  },
  // As on a real onboarding page: both advance buttons stay disabled until the field has a value.
  destination: {
    title: "Destination",
    html: `<p>Where to?</p><input aria-label="Destination" /><button disabled>CONTINUER</button><button aria-disabled="true">Suivant</button>`,
  },
  // The render after the fill: one button enabled, the other still disabled.
  destinationFilled: {
    title: "Destination",
    html: `<p>Where to?</p><input aria-label="Destination" value="Lisbon" /><button>CONTINUER</button><button aria-disabled="true">Suivant</button>`,
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

  /** Replaces the current page, as a render after an action would. */
  render(name: keyof typeof pages) {
    this.sessions
      .get(pageBrowserSessionKey(computer, context))
      .load(
        `https://example.test/${name}`,
        `<title>${pages[name].title}</title>${pages[name].html}`,
      );
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
  /** Probability of the first other non-`none` target; the rest is spread evenly. */
  runnerUp?: number;
  goalDone?: number;
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
        pick.runnerUp,
      );
    }
    if (request.questions.goal_done) {
      answers.goal_done = { type: "noul", probability: pick.goalDone ?? 0.1 };
    }
    return { answers, usage: { inputTokens: 1_000, cost: 0.00004 } };
  };
}

function choice(keys: string[], chosen: string, probability: number, runnerUp?: number) {
  const second =
    runnerUp === undefined ? undefined : keys.find((k) => k !== chosen && k !== "none");
  const others = keys.filter((key) => key !== chosen && key !== second);
  const rest = 1 - probability - (runnerUp ?? 0);
  const probabilities = Object.fromEntries(others.map((key) => [key, rest / others.length]));
  probabilities[chosen] = probability;
  if (second !== undefined) probabilities[second] = runnerUp!;
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
    const settles: number[] = [];
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
      { sleep: async (ms) => void settles.push(ms) },
    );
    const outcome = await result;
    // The page settles after the fill and after the select, never after a click.
    expect(settles).toEqual([300, 300]);
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

  it("picks a drop-down option the values do not hold and fills it by its label", async () => {
    const browser = await open(new FlowBrowser({}, "duration"));
    const { provider, result } = run(
      browser,
      [
        step({ op: "select", target: 'Durée approximative <- option "2 semaines"' }),
        step({ op: "blocked" }),
      ],
      { goal: "Plan a two-week trip to Lisbon", values: { destination: "Lisbon" } },
    );
    const outcome = await result;
    expect(outcome).toMatchObject({
      steps: [{ op: "select", name: "Durée approximative", option: "2 semaines", ok: true }],
    });
    // Only a select carries options.
    expect(
      (outcome as { elements: BrowserSnapshotNode[] }).elements.map((element) => element.options),
    ).toEqual([undefined, ["Choisir", "1 semaine", "2 semaines"], undefined]);
    expect(browser.acts.map((act) => act.actions)).toEqual([
      [{ kind: "fill", ref: expect.any(String), text: "2 semaines" }],
    ]);
    const offered = (call: number) => {
      const question = provider.calls[call]!.questions.select_target;
      return question?.type === "choice" ? Object.values(question.options) : [];
    };
    // Its own enabled options besides the one shown, and the provided value; no ask for a value.
    expect(offered(0)).toEqual([
      '[2] combobox "Durée approximative" value="Choisir" <- destination',
      '[2] combobox "Durée approximative" value="Choisir" <- option "1 semaine"',
      '[2] combobox "Durée approximative" value="Choisir" <- option "2 semaines"',
      "no listed element fits",
    ]);
    const state = provider.calls[1]!.state as { elements: string[]; recent: unknown[] };
    expect(state.elements).toContain('[2] combobox "Durée approximative" value="2 semaines"');
    expect(state.recent).toEqual([
      {
        op: "select",
        element: 'combobox "Durée approximative"',
        option: "2 semaines",
        pageChanged: true,
      },
    ]);
  });

  it("offers at most 30 options of a select, provided values first within the option limit", async () => {
    const browser = await open(new FlowBrowser({}, "longList"));
    const snap = await browser.snapshot(computer, {}, context);
    expect(snap.elements[0]).toMatchObject({ value: "Choose", optionsTruncated: true });
    expect(snap.elements[0]!.options).toHaveLength(30);
    expect(snap.elements[0]!.options!.at(-1)).toBe("Country 30");

    const offered = async (maxOptions: number) => {
      const provider = new FakeDecisionProvider({ script: [step({ op: "blocked" })], maxOptions });
      await browserRunFromTool(
        browser,
        computer,
        context,
        { goal: "Pick a country", values: { country: "Portugal" } },
        { provider, secrets: [], sleep: async () => undefined },
      );
      const question = provider.calls[0]!.questions.select_target;
      return question?.type === "choice" ? Object.values(question.options) : [];
    };
    const all = await offered(255);
    expect(all).toHaveLength(32);
    expect(all.join("\n")).toContain('<- option "Country 30"');
    expect(all.join("\n")).not.toContain("Country 31");
    // Past the provider's limit, option labels go first; the provided value stays.
    expect(await offered(4)).toEqual([
      '[1] combobox "Country" value="Choose" <- country',
      '[1] combobox "Country" value="Choose" <- option "Country 1"',
      '[1] combobox "Country" value="Choose" <- option "Country 2"',
      "no listed element fits",
    ]);
  });

  it("sees a button the page enables after a fill, and never offers a disabled one", async () => {
    const browser = await open(new FlowBrowser({ CONTINUER: "travellers" }, "destination"));
    // The in-process page marks disabled elements as the live helper does, in the tree too.
    const page = await browser.snapshot(computer, {}, context);
    expect(page.elements.map(({ name, disabled }) => [name, disabled])).toEqual([
      ["Destination", undefined],
      ["CONTINUER", true],
      ["Suivant", true],
    ]);
    expect(page.tree).toMatch(/^- button "CONTINUER" \[e\d+\] disabled$/m);
    const settles: number[] = [];
    const { provider, result } = run(
      browser,
      [
        step({ op: "fill", target: "Destination <- destination" }),
        step({ op: "click", target: "CONTINUER" }),
        step({ op: "done", goalDone: 0.9 }),
      ],
      { goal: "Enter the destination and continue", values: { destination: "Lisbon" } },
      {
        // The page re-renders only after the fill has returned.
        sleep: async (ms) => {
          settles.push(ms);
          browser.render("destinationFilled");
        },
      },
    );
    expect(await result).toMatchObject({ status: "done", title: "Travellers" });
    expect(settles).toEqual([300]);
    const [before, after] = provider.calls;
    const state = before!.state as { elements: string[]; page: { text: string } };
    expect(state.elements).toEqual([
      '[1] textbox "Destination"',
      '[2] button "CONTINUER" disabled',
      '[3] button "Suivant" disabled',
    ]);
    expect(state.page.text).toBe("");
    expect(before!.questions).not.toHaveProperty("click_target");
    const clicks = after!.questions.click_target;
    if (clicks?.type !== "choice") throw new Error("expected click targets after the fill");
    expect(Object.values(clicks.options)).toEqual([
      '[2] button "CONTINUER"',
      "no listed element fits",
    ]);
  });

  it("stops before a click named like a consequential action, and clicks nothing", async () => {
    {
      const browser = await open(new FlowBrowser({}, "summary"));
      const { result } = run(browser, [step({ op: "click", target: "Pay 1 200 €" })], {
        goal: "Finish the booking",
      });
      expect(await result).toMatchObject({
        status: "needs_input",
        need: { kind: "confirm", element: { ref: expect.any(String), role: "button" } },
        steps: [],
      });
      expect(browser.acts).toHaveLength(0);
    }
    // A neutral button on the same page is clicked.
    const browser = await open(new FlowBrowser({}, "summary"));
    const { result } = run(browser, [step({ op: "click", target: "Go to next step" })], {
      goal: "Go on",
    });
    expect(await result).toMatchObject({ steps: [{ name: "Go to next step", ok: true }] });
    expect(browser.acts).toHaveLength(1);
  });

  it("asks for a value it was not given instead of typing anything", async () => {
    const browser = await open(new FlowBrowser({}, "details"));
    // Below the 0.80 action gate, as in production: asking acts on nothing, so it still asks.
    const { provider, result } = run(
      browser,
      [step({ op: "fill", target: "Destination <- ?", probability: 0.78 })],
      { goal: "Fill the trip details" },
    );
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

  it("acts on a clear leader or a sure target, and hands ranked candidates back otherwise", async () => {
    // Production: two equivalent advance buttons split the mass, "CONTINUER" 0.65, "Suivant" 0.30.
    for (const [probability, runnerUp, acts] of [
      [0.65, 0.3, true],
      // The rest (0.33) goes to "none": no competing element, so no doubt about the target.
      [0.65, 0.02, true],
      [0.8, 0.15, true],
      [0.65, 0.35, false],
      [0.59, 0.1, false],
    ] as const) {
      const browser = await open(new FlowBrowser(onboarding));
      const { result } = run(
        browser,
        [
          step({ op: "click", target: "Get started", probability, runnerUp }),
          step({ op: "blocked" }),
        ],
        { goal: "Start" },
      );
      const outcome = await result;
      if (acts) {
        expect(outcome, `${probability} vs ${runnerUp}`).toMatchObject({
          steps: [{ op: "click", name: "Get started", ok: true }],
        });
        expect(browser.acts).toHaveLength(1);
        continue;
      }
      expect(outcome, `${probability} vs ${runnerUp}`).toMatchObject({
        status: "blocked",
        need: {
          kind: "blocked",
          reason: "low_confidence",
          candidates: [
            { name: "Get started", probability },
            { name: "Help", probability: runnerUp },
          ],
        },
      });
      expect(browser.acts).toHaveLength(0);
    }
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

  it("waits and looks again when nothing fits yet, then gives up", async () => {
    const nothingYet: FakeDecisionStep = (request) => {
      const operation = request.questions.operation;
      const target = request.questions.click_target;
      if (operation?.type !== "choice" || target?.type !== "choice") throw new Error("click");
      return {
        answers: {
          operation: choice(Object.keys(operation.options), "click", 0.9),
          click_target: choice(Object.keys(target.options), "none", 0.9),
        },
      };
    };
    const waited: number[] = [];
    const recovered = run(
      await open(new FlowBrowser({}, "summary")),
      [nothingYet, step({ op: "done", goalDone: 0.9 })],
      { goal: "Wait for the answer" },
      { sleep: async (ms) => void waited.push(ms) },
    );
    expect(await recovered.result).toMatchObject({ status: "done", steps: [{ op: "wait" }] });
    expect(waited).toEqual([500]);

    const stuck = run(
      await open(new FlowBrowser({}, "summary")),
      [nothingYet, nothingYet, nothingYet],
      { goal: "Wait for the answer" },
    );
    expect(await stuck.result).toMatchObject({
      status: "blocked",
      need: { kind: "blocked", reason: "no_target" },
    });
    expect(stuck.provider.calls).toHaveLength(3);
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
      thinkingLevel: "medium",
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
