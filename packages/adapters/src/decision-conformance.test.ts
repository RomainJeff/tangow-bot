import type {
  AdapterContext,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
} from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import { decideWithin } from "./decision.js";
import { FakeDecisionProvider } from "./fake-decision.js";
import { decisionConformanceRequests } from "./fixtures/decision-requests.js";
import { loadOpenRouterDecisionFixture } from "./fixtures/openrouter-decision-example.js";
import { OpenRouterDecisionProvider } from "./openrouter-decision.js";

function contextWith(signal: AbortSignal = new AbortController().signal): AdapterContext {
  return { operationId: "op", traceId: "trace", spaceId: "space", userId: "user", signal };
}

const choiceRequest: DecisionRequest = decisionConformanceRequests.target;
const noulRequest: DecisionRequest = decisionConformanceRequests.signin;
const scoreRequest: DecisionRequest = decisionConformanceRequests.sure;

type WireAnswer = { type: string; probabilities?: Record<string, number> } & Record<
  string,
  unknown
>;

/**
 * Answers every question with the documented example answer of the same type, re-keyed
 * to the question's own options, so the adapter's wire translation meets the neutral
 * conformance requests.
 */
function documentedShapeFetch(): typeof fetch {
  const documented = loadOpenRouterDecisionFixture().response as {
    answers: Record<string, WireAnswer>;
  };
  const byType = new Map(Object.values(documented.answers).map((answer) => [answer.type, answer]));
  return (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<string, { type: string; criteria?: Record<string, string> | string[] }>;
    };
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([name, question]) => {
        const answer = byType.get(question.type)!;
        if (question.type === "noul") return [name, answer];
        const keys = Array.isArray(question.criteria)
          ? question.criteria.map((_, index) => String(index))
          : Object.keys(question.criteria ?? {});
        const probabilities = Object.values(answer.probabilities ?? {});
        if (keys.length !== probabilities.length) throw new Error("fixture shape mismatch");
        if (question.type === "score") return [name, answer];
        probabilities.sort((a, b) => b - a);
        return [
          name,
          {
            ...answer,
            choice: keys[0],
            probabilities: Object.fromEntries(
              keys.map((key, index) => [key, probabilities[index]]),
            ),
          },
        ];
      }),
    );
    return new Response(JSON.stringify({ ...documented, answers }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function choiceAnswer(
  choice: string,
  probabilities: Record<string, number>,
  confidence = probabilities[choice] ?? 0,
): DecisionResponse {
  return { answers: { target: { type: "choice", choice, confidence, probabilities } } };
}

/** Every decision adapter must honour this contract through decideWithin. */
async function assertDecisionConformance(provider: DecisionProvider): Promise<void> {
  const capabilities = provider.describe().capabilities;
  expect(capabilities.maxOptions).toBeGreaterThan(0);
  if (capabilities.choice) {
    const result = await decideWithin(provider, choiceRequest, contextWith(), { timeoutMs: 1_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const answer = result.answers.target;
    expect(answer?.type).toBe("choice");
    if (answer?.type !== "choice") return;
    expect(["e1", "e2", "none"]).toContain(answer.choice);
    const total = Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 3);
  }
  if (capabilities.noul) {
    const result = await decideWithin(provider, noulRequest, contextWith(), { timeoutMs: 1_000 });
    expect(result.ok).toBe(true);
    if (result.ok && result.answers.signin?.type === "noul") {
      expect(result.answers.signin.probability).toBeGreaterThanOrEqual(0);
      expect(result.answers.signin.probability).toBeLessThanOrEqual(1);
    }
  }
  if (capabilities.score) {
    const result = await decideWithin(provider, scoreRequest, contextWith(), { timeoutMs: 1_000 });
    expect(result.ok).toBe(true);
  }
}

describe("decision conformance", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo", level: "off", sinks: [] }));
  });

  it("the OpenRouter adapter honours the contract", async () => {
    await assertDecisionConformance(
      new OpenRouterDecisionProvider(
        {
          apiKey: "test-key-not-real",
          baseUrl: "https://decision.example.test",
          modelId: "typesafe/jev-1.13",
        },
        { fetch: documentedShapeFetch() },
      ),
    );
  });

  it("answers no_provider without a provider", async () => {
    expect(await decideWithin(undefined, choiceRequest, contextWith(), { timeoutMs: 50 })).toEqual({
      ok: false,
      reason: "no_provider",
    });
  });

  it("answers aborted without calling the provider when the signal is already aborted", async () => {
    const provider = new FakeDecisionProvider();
    const controller = new AbortController();
    controller.abort();
    const result = await decideWithin(provider, choiceRequest, contextWith(controller.signal), {
      timeoutMs: 50,
    });
    expect(result).toEqual({ ok: false, reason: "aborted" });
    expect(provider.calls).toHaveLength(0);
  });

  it("answers aborted when the run aborts mid-call", async () => {
    const provider = new FakeDecisionProvider();
    provider.latencyMs = 1_000;
    const controller = new AbortController();
    const pending = decideWithin(provider, choiceRequest, contextWith(controller.signal), {
      timeoutMs: 5_000,
    });
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: "aborted" });
  });

  it("answers timeout within its budget, even when the provider ignores its signal", async () => {
    const stubborn: DecisionProvider = {
      describe: () => new FakeDecisionProvider().describe(),
      decide: () => new Promise<DecisionResponse>(() => undefined),
    };
    const started = Date.now();
    const result = await decideWithin(stubborn, choiceRequest, contextWith(), { timeoutMs: 20 });
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("answers error with the class name only and never throws", async () => {
    class ProviderHttpError extends Error {}
    const provider = new FakeDecisionProvider();
    provider.decideError = new ProviderHttpError("https://private.example.test/leak");
    expect(await decideWithin(provider, choiceRequest, contextWith(), { timeoutMs: 50 })).toEqual({
      ok: false,
      reason: "error",
      error: "ProviderHttpError",
    });

    const throwingDescribe: DecisionProvider = {
      describe: () => {
        throw new TypeError("broken");
      },
      decide: async () => choiceAnswer("e1", { e1: 1 }),
    };
    expect(
      await decideWithin(throwingDescribe, choiceRequest, contextWith(), { timeoutMs: 50 }),
    ).toEqual({ ok: false, reason: "error", error: "TypeError" });
  });

  it("turns an answer outside the option map into invalid_answer", async () => {
    const cases: unknown[] = [
      choiceAnswer("e9", { e1: 0.5, e9: 0.5 }),
      choiceAnswer("e1", { e1: 0.5, e2: 0.2 }),
      choiceAnswer("e1", { e1: 1.2, e2: -0.2 }),
      choiceAnswer("e1", { e1: 0.9, e2: 0.1 }, 1.5),
      choiceAnswer("e1", { e2: 0.9, none: 0.1 }, 0.9),
      { answers: { target: { type: "noul", probability: 0.4 } } },
      { answers: {} },
      null,
    ];
    for (const response of cases) {
      const provider = new FakeDecisionProvider({ script: [() => response] });
      expect(await decideWithin(provider, choiceRequest, contextWith(), { timeoutMs: 50 })).toEqual(
        { ok: false, reason: "invalid_answer" },
      );
    }
  });

  it("accepts a many-option distribution whose rounded entries drift from 1", async () => {
    // 75 options at two decimals, as OpenRouter reports them: 0.30 + 74 × 0.01 = 1.04.
    const keys = Array.from({ length: 74 }, (_, index) => `e${index + 1}`);
    const options = Object.fromEntries([...keys, "none"].map((key) => [key, key]));
    const probabilities = Object.fromEntries([...keys, "none"].map((key) => [key, 0.01]));
    probabilities.e1 = 0.3;
    const request = {
      state: "page",
      questions: { target: { type: "choice" as const, instructions: "pick", options } },
    };
    const provider = new FakeDecisionProvider({ script: [choiceAnswer("e1", probabilities)] });
    expect(await decideWithin(provider, request, contextWith(), { timeoutMs: 50 })).toMatchObject({
      ok: true,
    });
  });

  it("drops an invalid optional answer instead of failing the call", async () => {
    const request: DecisionRequest = {
      state: "page",
      questions: {
        ...choiceRequest.questions,
        extra: { type: "choice", instructions: "pick", options: { a: "a", b: "b" } },
      },
    };
    const answers = {
      ...choiceAnswer("e1", { e1: 0.9, none: 0.1 }).answers,
      extra: { type: "choice", choice: "z", confidence: 1, probabilities: { z: 1 } },
    };
    const optional = await decideWithin(
      new FakeDecisionProvider({ script: [{ answers } as DecisionResponse] }),
      request,
      contextWith(),
      { timeoutMs: 50, optional: ["extra"] },
    );
    expect(optional).toMatchObject({ ok: true });
    expect(optional.ok && Object.keys(optional.answers)).toEqual(["target"]);
    // The required question is still validated when another one is optional.
    const required = await decideWithin(
      new FakeDecisionProvider({ script: [{ answers } as DecisionResponse] }),
      request,
      contextWith(),
      { timeoutMs: 50, optional: ["target"] },
    );
    expect(required).toEqual({ ok: false, reason: "invalid_answer" });
  });

  it("refuses a choice above maxOptions before calling the provider", async () => {
    const provider = new FakeDecisionProvider({ maxOptions: 2 });
    const result = await decideWithin(provider, choiceRequest, contextWith(), { timeoutMs: 50 });
    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(provider.calls).toHaveLength(0);
  });

  it("logs counters and ids, never state or option text", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const marker = "zq-improbable-marker";
    const provider = new FakeDecisionProvider({
      script: [choiceAnswer("e1", { e1: 0.9, none: 0.1 })],
    });
    await decideWithin(
      provider,
      {
        state: { goal: marker },
        questions: {
          target: {
            type: "choice",
            instructions: `Which element matches: ${marker}?`,
            options: { e1: `link "${marker}"`, none: "no listed element matches" },
          },
        },
      },
      { ...contextWith(), runId: "run-1" },
      { timeoutMs: 50 },
    );
    const calls = sink.events.filter((event) => event.message === "agent.decision.call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      runId: "run-1",
      provider: "fake",
      outcome: "answered",
      options: 2,
      confidence: 0.9,
    });
    expect(JSON.stringify(sink.events)).not.toContain(marker);
  });
});
