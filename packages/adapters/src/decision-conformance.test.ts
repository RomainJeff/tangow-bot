import { isDeepStrictEqual } from "node:util";
import type {
  AdapterContext,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
} from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import { decideWithin, topChoices } from "./decision.js";
import { FakeDecisionProvider } from "./fake-decision.js";
import { decisionConformanceRequests } from "./fixtures/decision-requests.js";
import {
  documentedDecisionRequest,
  documentedWireBody,
  loadOpenRouterDecisionFixture,
} from "./fixtures/openrouter-decision-example.js";
import { OpenRouterDecisionProvider } from "./openrouter-decision.js";

function contextWith(signal: AbortSignal = new AbortController().signal): AdapterContext {
  return { operationId: "op", traceId: "trace", spaceId: "space", userId: "user", signal };
}

const choiceRequest: DecisionRequest = decisionConformanceRequests.target;
const noulRequest: DecisionRequest = decisionConformanceRequests.signin;
const scoreRequest: DecisionRequest = decisionConformanceRequests.sure;

/**
 * Replays the documented OpenRouter example: only the exact documented request body
 * gets the documented response, anything else fails loudly.
 */
function documentedFetch(requests: unknown[]): typeof fetch {
  const fixture = loadOpenRouterDecisionFixture();
  const expected = documentedWireBody(fixture);
  return (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as unknown;
    requests.push(body);
    if (!isDeepStrictEqual(body, expected)) return new Response("unexpected", { status: 404 });
    return new Response(JSON.stringify(fixture.response), {
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

/** Every decision adapter, fake or recorded, must honour this contract through decideWithin. */
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
  const controller = new AbortController();
  controller.abort();
  expect(
    await decideWithin(provider, choiceRequest, contextWith(controller.signal), {
      timeoutMs: 1_000,
    }),
  ).toEqual({ ok: false, reason: "aborted" });
}

describe("decision conformance", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo", level: "off", sinks: [] }));
  });

  it("the rule-based fake honours the contract", async () => {
    await assertDecisionConformance(new FakeDecisionProvider());
  });

  it("the scripted fake honours the contract", async () => {
    await assertDecisionConformance(
      new FakeDecisionProvider({
        script: [
          choiceAnswer("e2", { e1: 0.1, e2: 0.85, none: 0.05 }),
          { answers: { signin: { type: "noul", probability: 0.9 } } },
          {
            answers: {
              sure: {
                type: "score",
                score: 2,
                confidence: 0.7,
                probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
              },
            },
          },
        ],
      }),
    );
  });

  it("the OpenRouter adapter honours the contract against the documented example", async () => {
    const requests: unknown[] = [];
    const provider = new OpenRouterDecisionProvider(
      {
        apiKey: "test-key-not-real",
        baseUrl: "https://decision.example.test",
        modelId: "typesafe/jev-1.13",
      },
      { fetch: documentedFetch(requests) },
    );
    const request = documentedDecisionRequest(loadOpenRouterDecisionFixture());
    const result = await decideWithin(provider, request, contextWith(), { timeoutMs: 1_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { is_bug, team, urgency } = result.answers;
    expect(is_bug?.type === "noul" && is_bug.probability).toBe(0.96);
    expect(team?.type === "choice" && team.choice).toBe("payments");
    if (team?.type === "choice") {
      expect(Object.keys(team.probabilities).sort()).toEqual(["account", "frontend", "payments"]);
      expect(topChoices(team, 1)).toEqual([{ key: "payments", probability: 0.84 }]);
    }
    expect(urgency?.type === "score" && urgency.score).toBe(1.99);
    const controller = new AbortController();
    controller.abort();
    expect(
      await decideWithin(provider, request, contextWith(controller.signal), { timeoutMs: 1_000 }),
    ).toEqual({ ok: false, reason: "aborted" });
    expect(requests).toHaveLength(1);
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

    const slow = new FakeDecisionProvider();
    slow.latencyMs = 500;
    expect(await decideWithin(slow, choiceRequest, contextWith(), { timeoutMs: 20 })).toEqual({
      ok: false,
      reason: "timeout",
    });
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

    const unavailable = new FakeDecisionProvider();
    unavailable.forceUnavailable = true;
    expect(
      await decideWithin(unavailable, choiceRequest, contextWith(), { timeoutMs: 50 }),
    ).toMatchObject({ ok: false, reason: "error" });

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

  it("refuses a choice above maxOptions before calling the provider", async () => {
    const provider = new FakeDecisionProvider({ maxOptions: 2 });
    const result = await decideWithin(provider, choiceRequest, contextWith(), { timeoutMs: 50 });
    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(provider.calls).toHaveLength(0);
  });

  it("the rule-based fake is deterministic", async () => {
    const first = await new FakeDecisionProvider().decide(choiceRequest, contextWith());
    const second = await new FakeDecisionProvider().decide(choiceRequest, contextWith());
    expect(first).toEqual(second);
    expect(first.answers.target).toMatchObject({ type: "choice", choice: "e2" });
  });

  it("ranks the top choices by probability", () => {
    expect(
      topChoices(
        {
          type: "choice",
          choice: "e2",
          confidence: 0.5,
          probabilities: { e1: 0.3, e2: 0.5, e3: 0.2 },
        },
        2,
      ),
    ).toEqual([
      { key: "e2", probability: 0.5 },
      { key: "e1", probability: 0.3 },
    ]);
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
