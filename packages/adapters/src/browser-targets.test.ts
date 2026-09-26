import type {
  AdapterContext,
  BrowserActRequest,
  ComputerRef,
  DecisionRequest,
  DecisionResponse,
} from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserTargetStats } from "./browser-tools.js";
import {
  browserActFromTool,
  browserNavigateFromTool,
  parseBrowserActToolSteps,
} from "./browser-tools.js";
import { builtinAgentTools, withBrowserTargets } from "./builtin-tools.js";
import { selectBuiltinToolsForRun } from "./executor.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import type { FakeDecisionStep } from "./fake-decision.js";
import { FakeDecisionProvider } from "./fake-decision.js";

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

async function openPage(body: string) {
  const browser = new CountingBrowser({
    pages: { [PAGE]: { title: "Reports", html: `<html><body>${body}</body></html>` } },
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
  confidence: number,
  spread: string[] = [],
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
    probabilities[choice] = confidence;
    const rest = spread.map(keyFor);
    for (const key of rest) probabilities[key] = (1 - confidence) / rest.length;
    if (rest.length === 0) probabilities.none = 1 - confidence;
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

  it("parses exactly one of ref or target, refs first, and bounds targets", () => {
    expect(
      parseBrowserActToolSteps([
        { kind: "click", ref: "e1" },
        { kind: "fill", target: "search field", text: "q" },
      ]),
    ).toEqual([
      { kind: "click", ref: "e1" },
      { kind: "fill", target: "search field", text: "q" },
    ]);
    expect(() => parseBrowserActToolSteps([{ kind: "click", ref: "e1", target: "x" }])).toThrow(
      /not both/,
    );
    expect(() => parseBrowserActToolSteps([{ kind: "click" }])).toThrow(/ref/);
    expect(() =>
      parseBrowserActToolSteps([
        { kind: "click", target: "x" },
        { kind: "click", ref: "e1" },
      ]),
    ).toThrow(/ref actions before target actions/);
    expect(() =>
      parseBrowserActToolSteps(Array.from({ length: 7 }, () => ({ kind: "click", target: "x" }))),
    ).toThrow(/at most 6 target/);
    expect(() => parseBrowserActToolSteps([{ kind: "fill", target: "x" }])).toThrow(/text/);
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
    expect(provider.calls).toHaveLength(1);
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

  it("offers only reversible roles for the action kind, never buttons", async () => {
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

  it("returns needsRef without asking when no reversible control exists", async () => {
    const browser = await openPage("<button>Pay now</button>");
    const { provider, options } = targets([]);
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", target: "pay now" }] },
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

  it("returns a ref gone stale after the decision and never acts twice", async () => {
    const browser = await openPage(downloads);
    const choose = chooseByName("Download CSV", 0.95);
    const { options } = targets([
      (request) => {
        // Another snapshot renumbers refs, as a page change would.
        void browser.snapshot(computer, {}, context);
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
    const stats = { calls: 0, executed: 0, returned: 0 };
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
    expect(stats).toEqual({ calls: 2, executed: 1, returned: 1 });
  });

  it("redacts secrets from the request and keeps content out of logs", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const marker = "zq-improbable-marker";
    const browser = await openPage(
      `<a href="${PAGE}">Open sk-secret-value ${marker}</a><input type="password" aria-label="Password" value="hunter2-value" />`,
    );
    const { provider, options } = targets([chooseByName("x", 0.9)]);
    await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", target: `open ${marker} sk-secret-value` }] },
      options,
    );
    const sent = JSON.stringify(provider.calls);
    expect(sent).not.toContain("sk-secret-value");
    expect(sent).not.toContain("hunter2-value");
    expect(sent).toContain("[redacted]");
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
    const act = base().find((tool) => tool.name === "browser_act");
    expect(act).toEqual(builtinAgentTools.find((tool) => tool.name === "browser_act"));
    expect(JSON.stringify(act)).not.toContain("target");
    const withTargets = selectBuiltinToolsForRun({
      graphicalToolsAllowed: true,
      pageBrowserAllowed: true,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
      browserTargets: true,
    }).find((tool) => tool.name === "browser_act");
    expect(JSON.stringify(withTargets)).toContain("refs are stale");
    expect(withBrowserTargets([{ name: "x", description: "y", inputSchema: {} }])).toEqual([
      { name: "x", description: "y", inputSchema: {} },
    ]);

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
