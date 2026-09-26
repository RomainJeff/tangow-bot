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

function contextWith(signal: AbortSignal = new AbortController().signal): AdapterContext {
  return { operationId: "op", traceId: "trace", spaceId: "space", userId: "user", signal };
}

const choiceRequest: DecisionRequest = {
  state: { page: { url: "https://example.test/", title: "Reports" } },
  questions: {
    target: {
      type: "choice",
      instructions: "Which element matches: download CSV?",
      options: {
        e1: 'link "Download"',
        e2: 'link "Download CSV"',
        none: "no listed element matches",
      },
    },
  },
};

const noulRequest: DecisionRequest = {
  state: "The page shows a sign-in form.",
  questions: { signin: { type: "noul", instructions: "Is this a sign-in page?" } },
};

const scoreRequest: DecisionRequest = {
  state: "Order placed.",
  questions: {
    sure: {
      type: "score",
      instructions: "How settled is the page?",
      levels: ["no", "some", "yes"],
    },
  },
};

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
