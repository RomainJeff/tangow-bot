import type {
  AdapterContext,
  AdapterDescriptor,
  DecisionAnswer,
  DecisionCapabilities,
  DecisionProvider,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
} from "@rakazo/adapter-kit";

export type FakeDecisionStep = DecisionResponse | Error | ((request: DecisionRequest) => unknown);

export interface FakeDecisionProviderOptions {
  /** Consumed in order, one per call. Without a script the fake answers by rule. */
  script?: FakeDecisionStep[];
  maxOptions?: number;
}

export const FAKE_DECISION_MAX_OPTIONS = 255;

/**
 * In-process decision provider for offline tests and keyless core. Scripted mode
 * replays test-chosen answers (including malformed ones); rule mode picks the
 * option sharing the most words with the instructions, deterministically.
 */
export class FakeDecisionProvider implements DecisionProvider {
  readonly calls: DecisionRequest[] = [];
  private readonly script?: FakeDecisionStep[];
  private readonly maxOptions: number;
  /** Every call fails as if the provider were unreachable. */
  forceUnavailable = false;
  /** Delay before answering; honors the context signal. */
  latencyMs = 0;
  decideError?: Error;

  constructor(options: FakeDecisionProviderOptions = {}) {
    this.script = options.script ? [...options.script] : undefined;
    this.maxOptions = options.maxOptions ?? FAKE_DECISION_MAX_OPTIONS;
  }

  describe(): AdapterDescriptor<DecisionCapabilities> {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        noul: true,
        choice: true,
        score: true,
        maxOptions: this.maxOptions,
        offline: true,
      },
    };
  }

  async decide(request: DecisionRequest, context: AdapterContext): Promise<DecisionResponse> {
    this.calls.push(request);
    if (this.latencyMs > 0) await delay(this.latencyMs, context.signal);
    context.signal.throwIfAborted();
    if (this.forceUnavailable) throw new Error("Decision provider unavailable");
    if (this.decideError) throw this.decideError;
    if (this.script) {
      const step = this.script.shift();
      if (step === undefined) throw new Error("Fake decision script exhausted");
      if (step instanceof Error) throw step;
      return (typeof step === "function" ? step(request) : step) as DecisionResponse;
    }
    return {
      answers: Object.fromEntries(
        Object.entries(request.questions).map(([name, question]) => [name, ruleAnswer(question)]),
      ),
      model: "fake-rule",
    };
  }
}

function ruleAnswer(question: DecisionQuestion): DecisionAnswer {
  if (question.type === "noul") return { type: "noul", probability: 0.5 };
  if (question.type === "score") {
    const share = 1 / question.levels.length;
    return {
      type: "score",
      score: Math.floor((question.levels.length - 1) / 2),
      confidence: share,
      probabilities: Object.fromEntries(question.levels.map((_, index) => [String(index), share])),
    };
  }
  const wanted = new Set(words(question.instructions));
  const scored = Object.entries(question.options).map(([key, description]) => ({
    key,
    weight: 1 + words(description).filter((word) => wanted.has(word)).length,
  }));
  const total = scored.reduce((sum, entry) => sum + entry.weight, 0);
  const probabilities = Object.fromEntries(
    scored.map((entry) => [entry.key, entry.weight / total]),
  );
  const best = scored.reduce((top, entry) => (entry.weight > top.weight ? entry : top));
  return {
    type: "choice",
    choice: best.key,
    confidence: best.weight / total,
    probabilities,
  };
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
