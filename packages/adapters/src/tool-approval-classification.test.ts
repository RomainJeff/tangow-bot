import type { AdapterContext, DecisionResponse } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeDecisionProvider } from "./fake-decision.js";
import { classifyToolEffect } from "./tool-approval-classification.js";

const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

function answer(choice: string): DecisionResponse {
  return {
    model: "decision-model-1",
    answers: {
      effect: {
        type: "choice",
        choice,
        confidence: 0.9,
        probabilities: {
          [choice]: 0.9,
          [choice === "read_only" ? "consequential" : "read_only"]: 0.1,
        },
      },
    },
  };
}

const call = {
  publicName: "acme_execute_tool",
  tool: {
    name: "ACME_SYNC_LEDGER sk-live-1234",
    description: "Sync the ledger. Example key: sk-live-1234.",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", examples: ["sk-live-1234"] } },
    },
  },
  args: { mode: "apply", nested: { api_key: "plain-value", note: "uses sk-live-1234" } },
};

describe("classifyToolEffect", () => {
  afterEach(() => vi.useRealTimers());

  it("sends the resolved definition and arguments with every secret masked", async () => {
    const provider = new FakeDecisionProvider({ script: [answer("consequential")] });
    const traced: unknown[] = [];
    const result = await classifyToolEffect({
      provider,
      call,
      secrets: ["sk-live-1234"],
      context,
      trace: {
        generation: (_name, input) => {
          traced.push(input);
          return { end: () => undefined };
        },
      },
    });

    expect(result).toEqual({ ok: true, effect: "consequential", model: "decision-model-1" });
    const state = provider.calls[0]!.state;
    expect(state).toMatchObject({
      calledTool: "acme_execute_tool",
      tool: { inputSchema: { properties: { mode: { type: "string" } } } },
      arguments: { mode: "apply", nested: { api_key: "[redacted]" } },
    });
    expect(JSON.stringify(provider.calls[0])).not.toContain("sk-live-1234");
    expect(JSON.stringify(provider.calls[0])).not.toContain("plain-value");
    expect(traced).toEqual([provider.calls[0]]);
  });

  it("reports an unavailable answer as such, never as a label", async () => {
    const provider = new FakeDecisionProvider({ script: [new Error("boom")] });
    expect(await classifyToolEffect({ provider, call, secrets: [], context })).toEqual({
      ok: false,
      reason: "error",
      error: "Error",
    });
    expect(await classifyToolEffect({ provider: undefined, call, secrets: [], context })).toEqual({
      ok: false,
      reason: "no_provider",
    });
  });

  it("gives up after five seconds", async () => {
    vi.useFakeTimers();
    const provider = new FakeDecisionProvider({ script: [answer("read_only")] });
    provider.latencyMs = 60_000;
    const pending = classifyToolEffect({ provider, call, secrets: [], context });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, reason: "timeout" });
  });
});
