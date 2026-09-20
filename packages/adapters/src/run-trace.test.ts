import { createTelemetryAdapterConformance } from "@earendil-works/pi-telemetry/testing";
import { describe, expect, it } from "vitest";

import { RunTrace } from "./run-trace.js";

const conformance = createTelemetryAdapterConformance(async () => {
  const trace = new RunTrace();
  return {
    context: trace,
    getSpans: async () => trace.getSpans(),
    [Symbol.asyncDispose]: async () => {},
  };
});

for (const group of new Set(conformance.map((testCase) => testCase.group))) {
  describe(`telemetry adapter conformance: ${group}`, () => {
    for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
      it(testCase.name, async () => {
        await testCase.run();
      });
    }
  });
}

describe("RunTrace", () => {
  it("records wall-clock timestamps from the injected clock", async () => {
    let clock = 1_000;
    const trace = new RunTrace({ now: () => clock });
    await trace.startSpan({ name: "run" }, () => {
      clock = 1_250;
    });
    const [span] = trace.getSpans();
    expect(span?.startedAt).toBe(1_000);
    expect(span?.endedAt).toBe(1_250);
  });

  it("closes hand-opened spans with their parent relationship", () => {
    const trace = new RunTrace({ now: () => 0 });
    const root = trace.openSpan({ name: "run" });
    const child = trace.openSpan({ name: "tool", attributes: { tool: "search" } }, root);
    child?.end({ ok: false, error: new Error("boom") });
    root?.end();
    const spans = trace.getSpans();
    expect(spans.map((span) => span.name)).toEqual(["run", "tool"]);
    expect(spans[1]?.parentId).toBe(spans[0]?.id);
    expect(spans[1]?.status).toEqual({
      status: "error",
      error: { name: "Error", message: "boom" },
    });
    expect(spans[0]?.status).toEqual({ status: "ok" });
  });

  it("refuses to open a child of a settled span", () => {
    const trace = new RunTrace({ now: () => 0 });
    const root = trace.openSpan({ name: "run" });
    root?.end();
    expect(trace.openSpan({ name: "late" }, root)).toBeUndefined();
    expect(trace.getSpans()).toHaveLength(1);
  });

  it("uses a stable hexadecimal trace id for the whole run", () => {
    const trace = new RunTrace();
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
    const span = trace.openSpan({ name: "run" });
    expect(span?.id).toBe(1);
  });
});
