import { describe, expect, it } from "vitest";
import type { Parsed } from "../worker-channel-tap.js";
import { directProxyOverheads } from "./measurements.js";

const frames: Parsed[] = [
  { at: 0, from: "guest", kind: "worker.event", type: "model.request", seq: 4 },
  { at: 1, from: "guest", kind: "worker.event", type: "model.request", seq: 9 },
  {
    at: 2,
    from: "guest",
    kind: "worker.event",
    type: "model.latency",
    modelLatency: { re: 9, firstEventMs: 75 },
  },
  {
    at: 3,
    from: "guest",
    kind: "worker.event",
    type: "model.latency",
    modelLatency: { re: 4, firstEventMs: 24 },
  },
];

describe("direct per-call proxy overhead", () => {
  it("subtracts each emulator TTFB from its matching guest duration despite out-of-order diagnostics", () => {
    expect(
      directProxyOverheads(frames, [
        { received: 1000, firstByte: 1012 },
        { received: 2000, firstByte: 2040 },
      ]),
    ).toEqual([12, 35]);
  });

  it("refuses an incomplete measurement instead of reporting a passing aggregate estimate", () => {
    expect(() =>
      directProxyOverheads(frames.slice(0, 2), [{ received: 1000, firstByte: 1012 }]),
    ).toThrow("Missing direct model-call timing");
  });
});
