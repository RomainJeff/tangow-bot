import { expect, it, vi } from "vitest";
import { FakeDecisionProvider } from "./fake-decision.js";
import { classifyModelRoute } from "./model-route-classification.js";

it("caps classification even when the provider ignores cancellation", async () => {
  vi.useFakeTimers();
  try {
    const provider = new FakeDecisionProvider({ script: [() => new Promise(() => {})] });
    let settled = false;
    const pending = classifyModelRoute({
      provider,
      request: "Diagnose an intermittent failure",
      recentTurns: [],
      hasImages: false,
      secrets: [],
      context: {
        operationId: "route-test",
        traceId: "route-test",
        spaceId: "space-1",
        userId: "user-1",
        signal: new AbortController().signal,
      },
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ fallback: "decision_failed" });
    expect(provider.calls).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
