import { expect, it } from "vitest";
import type { Parsed } from "./worker-channel-tap.js";
import { settled } from "./worker-channel-tap.js";

it("pairs each request with its own reply when a later connection reuses its sequence number", () => {
  const frame = (at: number, from: Parsed["from"], type: string, sequence: number): Parsed =>
    from === "guest"
      ? { at, from, kind: "worker.event", seq: sequence, type }
      : { at, from, kind: "worker.reply", re: sequence, type };
  const frames = [
    frame(1, "guest", "transcript", 4),
    frame(3, "controller", "recorded", 4),
    frame(10, "guest", "transcript", 4),
    frame(14, "controller", "recorded", 4),
  ];

  expect(settled(frames, "transcript", "recorded")).toEqual([
    { from: 1, to: 3 },
    { from: 10, to: 14 },
  ]);
});
