import type { AdapterContext, AgentThinkingLevel } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEffort } from "./effort.js";
import { FakeDecisionProvider, type FakeDecisionStep } from "./fake-decision.js";

const context: AdapterContext = {
  operationId: "run-1",
  traceId: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
  signal: new AbortController().signal,
};

/** What Claude Opus 4.8 accepts on OpenRouter: Auto must stay inside low..xhigh. */
const OPUS_LEVELS: AgentThinkingLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];

function scored(probabilities: Record<string, number>): FakeDecisionStep {
  const [index, confidence] = Object.entries(probabilities).sort(([, a], [, b]) => b - a)[0]!;
  return {
    answers: { effort: { type: "score", score: Number(index), confidence, probabilities } },
  };
}

function effort(
  provider: FakeDecisionProvider | null,
  overrides: Partial<Parameters<typeof resolveEffort>[1]> = {},
) {
  return resolveEffort(
    provider,
    {
      manual: null,
      fallback: "low",
      supported: OPUS_LEVELS,
      message: "Thanks!",
      history: [
        { role: "user", content: "Can you summarize the report?" },
        { role: "assistant", content: "Here is the summary." },
      ],
      ...overrides,
    },
    context,
  );
}

describe("resolveEffort", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo", level: "off", sinks: [] }));
  });

  it("keeps a hand-picked level without asking the decision model", async () => {
    const provider = new FakeDecisionProvider({ script: [scored({ "0": 1 })] });
    expect(await effort(provider, { manual: "high" })).toEqual({ source: "manual", level: "high" });
    expect(provider.calls).toHaveLength(0);
    expect(await effort(provider)).toMatchObject({ source: "auto", level: "low" });
  });

  it("asks over low..xhigh only, never off or max", async () => {
    const provider = new FakeDecisionProvider({
      script: [scored({ "0": 0.1, "3": 0.9 }), scored({ "0": 0.8, "1": 0.2 })],
    });
    expect(await effort(provider)).toEqual({ source: "auto", level: "xhigh", probability: 0.9 });
    expect(await effort(provider)).toEqual({ source: "auto", level: "low", probability: 0.8 });
    const question = provider.calls[0]!.questions.effort;
    expect(question?.type === "score" ? question.levels.length : 0).toBe(4);
  });

  it("asks over minimal..high for a model without xhigh", async () => {
    const provider = new FakeDecisionProvider({ script: [scored({ "0": 0.9, "3": 0.1 })] });
    expect(
      await effort(provider, { supported: ["off", "minimal", "low", "medium", "high"] }),
    ).toEqual({ source: "auto", level: "minimal", probability: 0.9 });
  });

  it("breaks a tie toward more thinking", async () => {
    const provider = new FakeDecisionProvider({ script: [scored({ "1": 0.5, "2": 0.5 })] });
    expect(await effort(provider)).toEqual({ source: "auto", level: "high", probability: 0.5 });
  });

  it("sends the latest message and the last turns, clipped", async () => {
    const provider = new FakeDecisionProvider({ script: [scored({ "1": 1 })] });
    const history = Array.from({ length: 6 }, (_, index) => ({
      role: "user" as const,
      content: `turn ${index} ${"x".repeat(400)}`,
    }));
    await effort(provider, { message: "y".repeat(2_000), history });
    const state = provider.calls[0]!.state as {
      message: string;
      earlier: Array<{ role: string; text: string }>;
    };
    expect(state.message.length).toBe(1_201);
    expect(state.earlier.map((turn) => turn.text.slice(0, 6))).toEqual([
      "turn 2",
      "turn 3",
      "turn 4",
      "turn 5",
    ]);
    expect(state.earlier[0]!.text.length).toBe(301);
  });

  it("falls back to the connection level when the decision is unavailable", async () => {
    const slow = new FakeDecisionProvider({ script: [scored({ "0": 1 })] });
    slow.latencyMs = 2_000;
    const outOfRange = new FakeDecisionProvider({ script: [scored({ "7": 1 })] });
    const failing = new FakeDecisionProvider({ script: [new Error("boom")] });

    expect(await effort(null)).toEqual({ source: "fallback", level: "low", reason: "no_provider" });
    expect(await effort(slow)).toEqual({ source: "fallback", level: "low", reason: "timeout" });
    expect(await effort(outOfRange, { fallback: null })).toEqual({
      source: "fallback",
      level: null,
      reason: "invalid_answer",
    });
    expect(await effort(failing)).toEqual({ source: "fallback", level: "low", reason: "error" });
  });

  it("does not ask when the model has nothing to choose between", async () => {
    const provider = new FakeDecisionProvider({ script: [scored({ "0": 1 })] });
    expect(await effort(provider, { supported: ["off"], fallback: null })).toEqual({
      source: "fallback",
      level: null,
      reason: "no_choice",
    });
    expect(await effort(provider, { supported: ["off", "medium", "max"] })).toEqual({
      source: "fallback",
      level: "low",
      reason: "no_choice",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("logs where the level came from", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    await effort(new FakeDecisionProvider({ script: [scored({ "2": 0.75, "1": 0.25 })] }));
    expect(sink.events.find((event) => event.message === "agent.run.effort")).toMatchObject({
      runId: "run-1",
      source: "auto",
      thinkingLevel: "high",
      probability: 0.75,
      decisionMs: expect.any(Number),
    });
    expect(sink.events.find((event) => event.message === "agent.decision.call")).toMatchObject({
      purpose: "effort",
      outcome: "answered",
    });
  });
});
