import type {
  AdapterContext,
  AdapterDescriptor,
  DecisionCapabilities,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
} from "@tangow/adapter-kit";

export type FakeDecisionStep = DecisionResponse | Error | ((request: DecisionRequest) => unknown);

export interface FakeDecisionProviderOptions {
  /** Consumed in order, one per call; a call past the end throws. */
  script?: FakeDecisionStep[];
  maxOptions?: number;
}

/**
 * In-process decision provider for offline tests. Replays test-chosen answers,
 * including malformed ones, so callers exercise `decideWithin` validation.
 */
export class FakeDecisionProvider implements DecisionProvider {
  readonly calls: DecisionRequest[] = [];
  private readonly script: FakeDecisionStep[];
  private readonly maxOptions: number;
  /** Delay before answering; honors the context signal. */
  latencyMs = 0;
  decideError?: Error;

  constructor(options: FakeDecisionProviderOptions = {}) {
    this.script = [...(options.script ?? [])];
    this.maxOptions = options.maxOptions ?? 255;
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
    if (this.decideError) throw this.decideError;
    const step = this.script.shift();
    if (step === undefined) throw new Error("Fake decision script exhausted");
    if (step instanceof Error) throw step;
    return (typeof step === "function" ? step(request) : step) as DecisionResponse;
  }
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
