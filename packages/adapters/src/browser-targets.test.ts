import type {
  AdapterContext,
  BrowserActRequest,
  ComputerRef,
  ConnectorTool,
  DecisionRequest,
  DecisionResponse,
} from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserTargetStats } from "./browser-tools.js";
import { browserActFromTool, browserNavigateFromTool } from "./browser-tools.js";
import { builtinAgentTools } from "./builtin-tools.js";
import { selectBuiltinToolsForRun } from "./executor.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import type { FakeDecisionStep } from "./fake-decision.js";
import { FakeDecisionProvider } from "./fake-decision.js";
import { RunTraceRecorder } from "./pi-run-trace.js";
import { encodeTrace } from "./trace-export.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  runId: "run-1",
  signal: new AbortController().signal,
};

const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
const PAGE = "https://example.test/reports";

class CountingBrowser extends FakeBrowserProvider {
  readonly acts: BrowserActRequest[] = [];
  override async act(...args: Parameters<FakeBrowserProvider["act"]>) {
    this.acts.push(args[1]);
    return super.act(...args);
  }
}

async function openPage(body: string, title = "Reports") {
  const browser = new CountingBrowser({
    pages: { [PAGE]: { title, html: `<html><body>${body}</body></html>` } },
  });
  await browserNavigateFromTool(browser, computer, context, { url: PAGE });
  return browser;
}

const downloads = `
  <a href="${PAGE}">Download</a>
  <a href="${PAGE}">Download CSV</a>
  <a href="${PAGE}">Download all</a>
  <button>Delete report</button>
  <input aria-label="Search" />
`;

/** Scripts a choice by element name, so tests never depend on ref numbering. */
function chooseByName(
  name: string,
  probability: number,
  spread: string[] = [],
  confidence = probability,
): (request: DecisionRequest) => DecisionResponse {
  return (request) => {
    const question = request.questions.target;
    if (question?.type !== "choice") throw new Error("expected a choice");
    const keyFor = (wanted: string) =>
      Object.entries(question.options).find(([, text]) => text.endsWith(`"${wanted}"`))?.[0] ?? "";
    const choice = keyFor(name);
    const probabilities: Record<string, number> = Object.fromEntries(
      Object.keys(question.options).map((key) => [key, 0]),
    );
    probabilities[choice] = probability;
    const rest = spread.map(keyFor);
    for (const key of rest) probabilities[key] = (1 - probability) / rest.length;
    if (rest.length === 0) probabilities.none = 1 - probability;
    return { answers: { target: { type: "choice", choice, confidence, probabilities } } };
  };
}

function targets(script: FakeDecisionStep[], stats?: BrowserTargetStats) {
  const provider = new FakeDecisionProvider({ script });
  return { provider, options: { provider, secrets: ["sk-secret-value"], stats } };
}

describe("browser_act targets", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo", level: "off", sinks: [] }));
  });

  it("rejects malformed ref and target mixes before asking or acting", async () => {
    const browser = await openPage(downloads);
    const { provider, options } = targets([]);
    for (const [actions, error] of [
      [[{ kind: "click", ref: "e1", target: "x" }], /not both/],
      [[{ kind: "click" }], /requires ref/],
      [
        [
          { kind: "click", target: "x" },
          { kind: "click", ref: "e1" },
        ],
        /ref actions before target actions/,
      ],
      [Array.from({ length: 7 }, () => ({ kind: "click", target: "x" })), /at most 6 target/],
      [[{ kind: "fill", target: "x" }], /requires text/],
    ] as const) {
      expect(
        await browserActFromTool(browser, computer, context, { actions }, options),
      ).toMatchObject({ ok: false, error: expect.stringMatching(error) });
    }
    expect(provider.calls).toHaveLength(0);
    expect(browser.acts).toHaveLength(0);
  });

  it("clicks the confident choice with a single act", async () => {
    const browser = await openPage(downloads);
    const { provider, options } = targets([chooseByName("Download CSV", 0.93)]);
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", target: "the Download CSV link" }] },
      options,
    );
    expect(result).toMatchObject({ ok: true, completed: 1 });
    expect(browser.acts).toHaveLength(1);
    expect(provider.calls.map((call) => Object.keys(call.questions))).toEqual([
      ["target"],
      ["outcome"],
    ]);
    const clicked = browser.acts[0]!.actions[0]!;
    const question = provider.calls[0]!.questions.target;
    expect(question?.type === "choice" && question.options[clicked.ref]).toBe(
      'link "Download CSV"',
    );
  });

  it("hands three candidates back below the threshold without acting", async () => {
    const browser = await openPage(downloads);
    const { options } = targets([chooseByName("Download CSV", 0.55, ["Download", "Download all"])]);
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", target: "download" }] },
      options,
    );
    expect(browser.acts).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, completed: 0, needsRef: true });
    const candidates = (
      result as unknown as { candidates: Array<{ name: string; probability: number }> }
    ).candidates;
    expect(candidates.map((candidate) => candidate.name)).toEqual([
      "Download CSV",
      "Download",
      "Download all",
    ]);
    expect(candidates[0]?.probability).toBe(0.55);
    expect((result as { elements: unknown[] }).elements.length).toBeGreaterThan(0);
  });

  it("gates on the chosen option's probability, not the distribution confidence", async () => {
    const act = async (probability: number, confidence: number) => {
      const browser = await openPage(downloads);
      const { options } = targets([
        chooseByName("Download CSV", probability, ["Download"], confidence),
      ]);
      await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "click", target: "the Download CSV link" }] },
        options,
      );
      return browser.acts.length;
    };
    // Documented example: a 0.84 pick reported with confidence 0.75.
    expect(await act(0.84, 0.75)).toBe(1);
    expect(await act(0.6, 0.9)).toBe(0);
    expect(await act(0.8, 0.8)).toBe(1);
    expect(await act(0.79, 0.79)).toBe(0);
  });

  it("offers only the roles each action kind can use", async () => {
    const browser = await openPage(`${downloads}<button role="tab">Settings</button>`);
    const { provider, options } = targets([chooseByName("Download", 0.9)]);
    await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", target: "delete report" }] },
      options,
    );
    const click = provider.calls[0]!.questions.target;
    expect(click?.type === "choice" && Object.values(click.options)).toEqual([
      'link "Download"',
      'link "Download CSV"',
      'link "Download all"',
      'button "Delete report"',
      'tab "Settings"',
      "no listed element matches",
    ]);

    const fill = targets([chooseByName("Search", 0.9)]);
    const filled = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "fill", target: "search box", text: "Q3" }] },
      fill.options,
    );
    expect(filled).toMatchObject({ ok: true, completed: 1 });
    const fillQuestion = fill.provider.calls[0]!.questions.target;
    expect(fillQuestion?.type === "choice" && Object.values(fillQuestion.options)).toEqual([
      'textbox "Search"',
      "no listed element matches",
    ]);
    expect(browser.acts.at(-1)?.actions[0]).toMatchObject({ kind: "fill", text: "Q3" });
  });

  it("returns needsRef without asking when no control fits the action kind", async () => {
    const browser = await openPage('<input type="checkbox" aria-label="Agree" />');
    const { provider, options } = targets([]);
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", target: "agree" }] },
      options,
    );
    expect(result).toMatchObject({ ok: false, needsRef: true });
    expect(provider.calls).toHaveLength(0);
    expect(browser.acts).toHaveLength(0);
  });

  it("bounds a large page to 80 options plus none", async () => {
    const links = Array.from({ length: 100 }, (_, i) => `<a href="${PAGE}">Link ${i}</a>`).join("");
    const browser = await openPage(links);
    const { provider, options } = targets([chooseByName("Link 3", 0.9)]);
    await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", target: "link 3" }] },
      options,
    );
    const question = provider.calls[0]!.questions.target;
    expect(question?.type === "choice" && Object.keys(question.options)).toHaveLength(81);
  });

  it("acts on nothing for none, an out-of-table answer, or an unavailable provider", async () => {
    const outOfTable = (): DecisionResponse => ({
      answers: {
        target: { type: "choice", choice: "e999", confidence: 1, probabilities: { e999: 1 } },
      },
    });
    const none = (request: DecisionRequest): DecisionResponse => {
      const question = request.questions.target;
      if (question?.type !== "choice") throw new Error("expected a choice");
      const probabilities = Object.fromEntries(Object.keys(question.options).map((k) => [k, 0]));
      probabilities.none = 1;
      return {
        answers: { target: { type: "choice", choice: "none", confidence: 1, probabilities } },
      };
    };
    for (const [step, reason] of [
      [none, undefined],
      [outOfTable, "invalid_answer"],
      [new Error("down"), "error"],
    ] as const) {
      const browser = await openPage(downloads);
      const { options } = targets([step]);
      const result = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "click", target: "download" }] },
        options,
      );
      expect(browser.acts).toHaveLength(0);
      expect(result).toMatchObject({ ok: false, needsRef: true });
      expect((result as { reason?: string }).reason).toBe(reason);
      expect((result as { candidates?: unknown }).candidates).toBeUndefined();
    }
  });

  it("returns a timeout as the ordinary turn", async () => {
    const browser = await openPage(downloads);
    const provider = new FakeDecisionProvider();
    provider.latencyMs = 5_000;
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", target: "download" }] },
      { provider, secrets: [] },
    );
    expect(result).toMatchObject({ ok: false, needsRef: true, reason: "timeout" });
    expect(browser.acts).toHaveLength(0);
  });

  it("rethrows a run abort that lands during the target decision", async () => {
    const browser = await openPage(downloads);
    const provider = new FakeDecisionProvider({ script: [chooseByName("Download CSV", 0.95)] });
    provider.latencyMs = 5_000;
    const controller = new AbortController();
    const pending = browserActFromTool(
      browser,
      computer,
      { ...context, signal: controller.signal },
      { actions: [{ kind: "click", target: "download csv" }] },
      { provider, secrets: [] },
    );
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(browser.acts).toHaveLength(0);
  });

  it("returns a ref gone stale after the decision and never acts twice", async () => {
    const browser = await openPage(downloads);
    const choose = chooseByName("Download CSV", 0.95);
    const { options } = targets([
      async (request) => {
        // Another snapshot renumbers refs, as a page change would.
        await browser.snapshot(computer, {}, context);
        return choose(request);
      },
    ]);
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", target: "download csv" }] },
      options,
    );
    expect(browser.acts).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, completed: 0, error: expect.stringMatching(/ref/) });
  });

  it("runs refs first, then targets one by one, stopping at the first needsRef", async () => {
    const browser = await openPage(`${downloads}<input aria-label="Name" />`);
    const snapshot = await browser.snapshot(computer, {}, context);
    const nameRef = snapshot.elements.find((element) => element.name === "Name")!.ref;
    const stats = { calls: 0, executed: 0, returned: 0, verifyCalls: 0, verifyAnswered: 0 };
    const { provider, options } = targets(
      [chooseByName("Search", 0.9), chooseByName("Download", 0.4, ["Download CSV"])],
      stats,
    );
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      {
        actions: [
          { kind: "fill", ref: nameRef, text: "Ada" },
          { kind: "fill", target: "search", text: "Q3" },
          { kind: "click", target: "download" },
          { kind: "click", target: "never reached" },
        ],
      },
      options,
    );
    expect(result).toMatchObject({ ok: false, completed: 2, needsRef: true });
    expect(browser.acts).toHaveLength(2);
    expect(provider.calls).toHaveLength(2);
    // The sequence stopped at needsRef, so the executed fill is not verified.
    expect(stats).toEqual({
      calls: 2,
      executed: 1,
      returned: 1,
      verifyCalls: 0,
      verifyAnswered: 0,
    });
  });

  it("never leaves a secret fragment in a truncated option name", async () => {
    const browser = await openPage(
      `<a href="${PAGE}" aria-label="${"x".repeat(112)}sk-secret-value">link</a>`,
    );
    const { provider, options } = targets([chooseByName("x", 0.9)]);
    await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", target: "the long link" }] },
      options,
    );
    expect(JSON.stringify(provider.calls[0]!.questions)).not.toContain("sk-sec");
  });

  it("redacts secrets from the request and keeps content out of logs", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const marker = "zq-improbable-marker";
    const browser = await openPage(
      `<a href="${PAGE}">Open sk-secret-value ${marker}</a><input aria-label="Email" value="typed-value-marker" />`,
      "Reports sk-secret-value",
    );
    const { provider, options } = targets([chooseByName("x", 0.9), chooseByName("x", 0.9)]);
    await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", target: `open ${marker} sk-secret-value` }] },
      options,
    );
    await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "fill", target: "email", text: "new" }] },
      options,
    );
    expect(provider.calls).toHaveLength(2);
    const sent = JSON.stringify(provider.calls);
    expect(sent).not.toContain("sk-secret-value");
    expect(sent).not.toContain("typed-value-marker");
    expect(provider.calls[0]!.state).toMatchObject({ title: "Reports [redacted]" });
    const link = provider.calls[0]!.questions.target;
    expect(link?.type === "choice" && Object.values(link.options)[0]).toContain("[redacted]");
    const logged = JSON.stringify(sink.events);
    expect(logged).not.toContain(marker);
    expect(sink.events.map((event) => event.message)).toEqual(
      expect.arrayContaining(["agent.decision.call", "agent.browser.target"]),
    );
  });

  it("leaves the schema and ref results unchanged without a provider", async () => {
    const base = () =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: true,
        pageBrowserAllowed: true,
        groupId: null,
        trigger: "user",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
      });
    const items = (tool: ConnectorTool | undefined) =>
      (
        tool!.inputSchema as {
          properties: {
            actions: { items: { properties: Record<string, unknown>; required: string[] } };
          };
        }
      ).properties.actions.items;
    const act = base().find((tool) => tool.name === "browser_act");
    expect(act).toEqual(builtinAgentTools.find((tool) => tool.name === "browser_act"));
    expect(items(act).properties.target).toBeUndefined();
    expect(items(act).required).toEqual(["kind", "ref"]);
    const withTargets = selectBuiltinToolsForRun({
      graphicalToolsAllowed: true,
      pageBrowserAllowed: true,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
      browserTargets: true,
    }).find((tool) => tool.name === "browser_act");
    expect(items(withTargets).properties.target).toBeDefined();
    expect(items(withTargets).required).toEqual(["kind"]);

    const plain = await openPage(downloads);
    const withProvider = await openPage(downloads);
    const ref = (await plain.snapshot(computer, {}, context)).elements[0]!.ref;
    await withProvider.snapshot(computer, {}, context);
    const args = { actions: [{ kind: "click", ref }] };
    const { provider, options } = targets([]);
    expect(await browserActFromTool(withProvider, computer, context, args, options)).toEqual(
      await browserActFromTool(plain, computer, context, args),
    );
    expect(provider.calls).toHaveLength(0);
    expect(
      await browserActFromTool(plain, computer, context, {
        actions: [{ kind: "click", target: "download" }],
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/requires ref/) });
  });
});

const LANDING = "https://example.test/export";

/** The jsdom session cannot follow a link, so a successful click loads the seeded landing page. */
class LandingBrowser extends CountingBrowser {
  landing?: string;
  override async act(...args: Parameters<FakeBrowserProvider["act"]>) {
    const result = await super.act(...args);
    if (!result.ok || !this.landing || args[1].actions[0]?.kind !== "click") return result;
    const [target, , ctx] = args;
    await this.navigate(target, { url: this.landing }, ctx);
    return { ...result, ...(await this.snapshot(target, {}, ctx)) };
  }
}

async function openLanding(before: string, after: string, afterTitle = "Export") {
  const browser = new LandingBrowser({
    pages: {
      [PAGE]: { title: "Reports", html: `<html><body>${before}</body></html>` },
      [LANDING]: { title: afterTitle, html: `<html><body>${after}</body></html>` },
    },
  });
  browser.landing = LANDING;
  await browserNavigateFromTool(browser, computer, context, { url: PAGE });
  return browser;
}

function answerOutcome(kind: string, probability: number) {
  return (request: DecisionRequest): DecisionResponse => {
    const question = request.questions.outcome;
    if (question?.type !== "choice") throw new Error("expected the outcome choice");
    const others = Object.keys(question.options).filter((key) => key !== kind);
    const probabilities: Record<string, number> = { [kind]: probability };
    for (const key of others) probabilities[key] = (1 - probability) / others.length;
    return {
      answers: {
        outcome: { type: "choice", choice: kind, confidence: probability, probabilities },
      },
    };
  };
}

const clickCsv = { actions: [{ kind: "click", target: "the Download CSV link" }] };

describe("browser_act outcome", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo", level: "off", sinks: [] }));
  });

  it("annotates the provider's class, or uncertain below 0.5, without acting again", async () => {
    for (const [answered, probability, kind] of [
      ["landed", 0.9, "landed"],
      ["dialog", 0.7, "dialog"],
      ["error", 0.6, "error"],
      ["auth", 0.5, "auth"],
      ["unchanged", 0.8, "unchanged"],
      ["dialog", 0.45, "uncertain"],
    ] as const) {
      const browser = await openLanding(downloads, `<button>Close</button>`);
      const { provider, options } = targets([
        chooseByName("Download CSV", 0.95),
        answerOutcome(answered, probability),
      ]);
      const result = await browserActFromTool(browser, computer, context, clickCsv, options);
      expect(result).toMatchObject({ ok: true, completed: 1, outcome: { kind, probability } });
      expect(browser.acts).toHaveLength(1);
      const question = provider.calls[1]!.questions.outcome;
      expect(question?.type === "choice" && Object.keys(question.options)).toEqual([
        "landed",
        "dialog",
        "error",
        "auth",
        "unchanged",
      ]);
    }
  });

  it("sends a bounded, redacted diff of controls and keeps content out of logs", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const marker = "zq-improbable-marker";
    const nameMarker = "zq-name-marker";
    const longName = `Accept ${"x".repeat(200)}`;
    const before = `${downloads}<input aria-label="Email" value="typed-${marker}" />`;
    const after = [
      `<a href="${LANDING}">Download</a>`,
      `<a href="${LANDING}">Download</a>`,
      `<button>Continue as sk-secret-value ${nameMarker}</button>`,
      `<button aria-label="${longName}">Accept</button>`,
      `<input aria-label="Password" type="password" />`,
      ...Array.from({ length: 25 }, (_, i) => `<button>Option ${i}</button>`),
    ].join("");
    const browser = await openLanding(before, after, "Sign in sk-secret-value");
    const stats = { calls: 0, executed: 0, returned: 0, verifyCalls: 0, verifyAnswered: 0 };
    const { provider, options } = targets(
      [chooseByName("Download CSV", 0.95), answerOutcome("auth", 0.9)],
      stats,
    );
    await browserActFromTool(browser, computer, context, clickCsv, options);

    const state = provider.calls[1]!.state as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["action", "added", "after", "before", "removed"]);
    expect(state.action).toEqual({ kind: "click", role: "link", name: "Download CSV" });
    expect(state.before).toEqual({ url: PAGE, title: "Reports", elements: 6 });
    expect(state.after).toEqual({ url: LANDING, title: "Sign in [redacted]", elements: 30 });
    const added = state.added as string[];
    expect(added).toHaveLength(20);
    // A multiset diff: one of the two "Download" links matches the one that was there before.
    expect(added.slice(0, 4)).toEqual([
      'link "Download"',
      `button "Continue as [redacted] ${nameMarker}"`,
      `button ${JSON.stringify(`${longName.slice(0, 119)}…`)}`,
      'textbox "Password"',
    ]);
    expect(state.removed).toEqual([
      'link "Download CSV"',
      'link "Download all"',
      'button "Delete report"',
      'textbox "Search"',
      'textbox "Email"',
    ]);
    const sent = JSON.stringify(provider.calls[1]);
    expect(sent).not.toContain("sk-secret-value");
    expect(sent).not.toContain(marker);
    expect(stats).toMatchObject({ verifyCalls: 1, verifyAnswered: 1 });

    const logged = JSON.stringify(sink.events);
    expect(logged).not.toContain(marker);
    expect(logged).not.toContain(nameMarker);
    const decisions = sink.events.filter((event) => event.message === "agent.decision.call");
    expect(decisions.map((event) => event.purpose)).toEqual(["target", "verify"]);
    const outcome = sink.events.find((event) => event.message === "agent.browser.outcome");
    expect(outcome).toMatchObject({ kind: "click", outcome: "auth", probability: 0.9 });
  });

  it("adds no outcome when the provider is unavailable, leaving the result as it was", async () => {
    const run = async (verify: FakeDecisionStep) => {
      const browser = await openLanding(downloads, `<button>Close</button>`);
      const { options } = targets([chooseByName("Download CSV", 0.95), verify]);
      return browserActFromTool(browser, computer, context, clickCsv, options);
    };
    const { outcome, ...plain } = (await run(answerOutcome("dialog", 0.9))) as {
      outcome?: unknown;
    };
    expect(outcome).toEqual({ kind: "dialog", probability: 0.9 });
    const outOfTable = (): DecisionResponse => ({
      answers: {
        outcome: { type: "choice", choice: "done", confidence: 1, probabilities: { done: 1 } },
      },
    });
    const slow = () => new Promise<DecisionResponse>((resolve) => setTimeout(resolve, 2_000));
    for (const step of [new Error("down"), outOfTable, slow]) {
      expect(await run(step)).toEqual(plain);
    }
  });

  it("never verifies an act that failed or may not have happened", async () => {
    class UncertainBrowser extends LandingBrowser {
      override async act(...args: Parameters<FakeBrowserProvider["act"]>) {
        const result = await super.act(...args);
        return { ...result, ok: false, uncertain: true, error: "response lost" };
      }
    }
    const browser = new UncertainBrowser({
      pages: { [PAGE]: { title: "Reports", html: `<html><body>${downloads}</body></html>` } },
    });
    await browserNavigateFromTool(browser, computer, context, { url: PAGE });
    const { provider, options } = targets([
      chooseByName("Download CSV", 0.95),
      answerOutcome("landed", 0.9),
    ]);
    const result = await browserActFromTool(browser, computer, context, clickCsv, options);
    expect(result).toMatchObject({ ok: false, uncertain: true });
    expect(result).not.toHaveProperty("outcome");
    expect(provider.calls).toHaveLength(1);
    expect(browser.acts).toHaveLength(1);
  });

  it("verifies once per call, on the last target action", async () => {
    const browser = await openLanding(downloads, `<button>Close</button>`);
    const { provider, options } = targets([
      chooseByName("Search", 0.9),
      chooseByName("Download CSV", 0.95),
      answerOutcome("dialog", 0.8),
    ]);
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      {
        actions: [
          { kind: "fill", target: "search", text: "Q3" },
          { kind: "click", target: "the Download CSV link" },
        ],
      },
      options,
    );
    expect(result).toMatchObject({ ok: true, completed: 2, outcome: { kind: "dialog" } });
    expect(provider.calls.map((call) => Object.keys(call.questions))).toEqual([
      ["target"],
      ["target"],
      ["outcome"],
    ]);
    expect((provider.calls[2]!.state as { action: unknown }).action).toMatchObject({
      kind: "click",
      name: "Download CSV",
    });
  });
});

interface ExportedSpan {
  name: string;
  spanId: string;
  parentSpanId?: string;
  status: { code: number };
  attributes: Record<string, string | number | boolean | undefined>;
}

/** A run trace whose browser_act call is open, as the runtime leaves it while the tool runs. */
function tracedToolCall() {
  const recorder = new RunTraceRecorder({
    runId: "run-1",
    threadId: "thread-1",
    botId: "b1",
    provider: "test",
    model: "agent-model",
    systemPrompt: "",
    history: [],
    prompt: "download the report",
  });
  recorder.toolStart("call-1", "browser_act", clickCsv);
  return { recorder, trace: recorder.toolTrace("call-1") };
}

/** Settles the run and reads the spans back from the OTLP body the exporter would send. */
function exportedSpans(recorder: RunTraceRecorder): { spans: ExportedSpan[]; body: string } {
  recorder.finish("done");
  const payload = encodeTrace(recorder.trace) as {
    resourceSpans: Array<{
      scopeSpans: Array<{
        spans: Array<
          Omit<ExportedSpan, "attributes"> & {
            attributes: Array<{
              key: string;
              value: {
                stringValue?: string;
                intValue?: string;
                doubleValue?: number;
                boolValue?: boolean;
              };
            }>;
          }
        >;
      }>;
    }>;
  };
  const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans.map((span) => ({
    ...span,
    attributes: Object.fromEntries(
      span.attributes.map(({ key, value }) => [
        key,
        value.stringValue ??
          (value.intValue === undefined ? undefined : Number(value.intValue)) ??
          value.doubleValue ??
          value.boolValue,
      ]),
    ),
  }));
  return { spans, body: JSON.stringify(payload) };
}

function span(spans: ExportedSpan[], name: string): ExportedSpan {
  const found = spans.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no ${name} span`);
  return found;
}

function json(value: string | number | boolean | undefined): unknown {
  return JSON.parse(String(value));
}

describe("browser_act decision trace", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo", level: "off", sinks: [] }));
  });

  it("records each decision as a generation under the browser_act span", async () => {
    const browser = await openLanding(
      `${downloads}<a href="${PAGE}">Open sk-secret-value</a><input aria-label="Email" value="typed-value-marker" />`,
      `<button>Close</button>`,
    );
    const { provider, options } = targets([
      (request) => ({
        ...chooseByName("Download CSV", 0.93)(request),
        model: "decider-v1",
        usage: { inputTokens: 321, cost: 0.0004 },
      }),
      answerOutcome("landed", 0.9),
    ]);
    const { recorder, trace } = tracedToolCall();
    await browserActFromTool(browser, computer, context, clickCsv, { ...options, trace });

    const { spans, body } = exportedSpans(recorder);
    const tool = span(spans, "tool browser_act");
    const target = span(spans, "decision target");
    const verify = span(spans, "decision verify");
    expect(target.parentSpanId).toBe(tool.spanId);
    expect(verify.parentSpanId).toBe(tool.spanId);
    expect(json(target.attributes["langfuse.observation.input"])).toEqual(provider.calls[0]);
    expect(json(verify.attributes["langfuse.observation.input"])).toEqual(provider.calls[1]);
    const clicked = browser.acts[0]!.actions[0]!.ref;
    expect(json(target.attributes["langfuse.observation.output"])).toMatchObject({
      target: { type: "choice", choice: clicked },
    });
    const question = provider.calls[0]!.questions.target;
    expect(target.attributes).toMatchObject({
      "langfuse.observation.type": "generation",
      "langfuse.observation.model.name": "decider-v1",
      "langfuse.observation.metadata.purpose": "target",
      "langfuse.observation.metadata.provider": "fake",
      "langfuse.observation.metadata.outcome": "answered",
      "langfuse.observation.metadata.options":
        question?.type === "choice" ? Object.keys(question.options).length : -1,
      "langfuse.observation.metadata.gate": "executed",
      "langfuse.observation.metadata.chosenProbability": 0.93,
      "langfuse.observation.metadata.durationMs": expect.any(Number),
    });
    expect(json(target.attributes["langfuse.observation.usage_details"])).toEqual({ input: 321 });
    expect(json(target.attributes["langfuse.observation.cost_details"])).toEqual({
      total: 0.0004,
    });
    expect(target.status.code).toBe(1);
    expect(verify.attributes).toMatchObject({
      "langfuse.observation.type": "generation",
      "langfuse.observation.metadata.purpose": "verify",
      "langfuse.observation.metadata.outcome": "answered",
    });
    expect(json(verify.attributes["langfuse.observation.output"])).toMatchObject({
      outcome: { choice: "landed" },
    });
    expect(body).not.toContain("sk-secret-value");
    expect(body).not.toContain("typed-value-marker");
  });

  it("records which check rejected an answer, with the raw answers, as a failed call", async () => {
    const links = Array.from({ length: 75 }, (_, i) => `<a href="${PAGE}">Link ${i}</a>`).join("");
    const reshape =
      (change: (answer: Record<string, unknown>) => void) =>
      (request: DecisionRequest): DecisionResponse => {
        const response = chooseByName("Link 3", 0.9)(request);
        change(response.answers.target as unknown as Record<string, unknown>);
        return response;
      };
    const halve = (answer: Record<string, unknown>) => {
      const probabilities = answer.probabilities as Record<string, number>;
      for (const key of Object.keys(probabilities)) probabilities[key]! /= 2;
    };
    for (const [step, detail] of [
      [reshape(halve), { check: "bad_distribution", question: "target", sum: 0.5, entries: 76 }],
      [reshape((answer) => (answer.choice = "e999")), { check: "not_in_options" }],
      [reshape((answer) => (answer.confidence = 2)), { check: "bad_confidence" }],
      [
        reshape((answer) => {
          delete (answer.probabilities as Record<string, number>)[answer.choice as string];
          (answer.probabilities as Record<string, number>).none = 1;
        }),
        { check: "missing_chosen_probability" },
      ],
    ] as const) {
      const sink = createTestSink();
      installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
      const browser = await openPage(links);
      const { provider, options } = targets([step]);
      const { recorder, trace } = tracedToolCall();
      const result = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "click", target: "link 3" }] },
        { ...options, trace },
      );
      expect(result).toMatchObject({ needsRef: true, reason: "invalid_answer" });

      const target = span(exportedSpans(recorder).spans, "decision target");
      expect(json(target.attributes["langfuse.observation.output"])).toEqual({
        unavailable: "invalid_answer",
        invalid: expect.objectContaining(detail),
        answers: expect.objectContaining({ target: expect.objectContaining({ type: "choice" }) }),
      });
      expect(target.attributes["langfuse.observation.metadata.gate"]).toBe("returned_unavailable");
      expect(target.status.code).toBe(2);
      expect(provider.calls).toHaveLength(1);
      const logged = sink.events.find((event) => event.message === "agent.decision.call");
      expect(logged).toMatchObject({ outcome: "invalid_answer", invalidDetail: detail.check });
    }
  });
});
