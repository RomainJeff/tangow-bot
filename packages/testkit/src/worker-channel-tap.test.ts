import { expect, it } from "vitest";
import type { Parsed } from "./worker-channel-tap.js";
import { nativeCalls, parse, settled } from "./worker-channel-tap.js";

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

it("pairs each native call with its result, and leaves out a controller tool's call", () => {
  const guest = (at: number, seq: number, body: Record<string, unknown>) => ({
    at,
    from: "guest" as const,
    frame: Buffer.from(JSON.stringify({ kind: "worker.event", payload: { seq, body } })),
  });
  const recorded = (at: number, re: number) => ({
    at,
    from: "controller" as const,
    frame: Buffer.from(
      JSON.stringify({ kind: "worker.reply", payload: { re, body: { type: "recorded" } } }),
    ),
  });
  const transcript = (messages: unknown[]) => ({ type: "transcript", dialect: "pi-ai", messages });
  const frames = parse([
    guest(
      0,
      1,
      transcript([{ role: "assistant", content: [{ type: "toolCall", id: "b1", name: "bash" }] }]),
    ),
    recorded(2, 1),
    guest(10, 2, transcript([{ role: "toolResult", toolCallId: "b1" }])),
    recorded(13, 2),
    guest(
      20,
      3,
      transcript([
        { role: "assistant", content: [{ type: "toolCall", id: "say", name: "message_user" }] },
      ]),
    ),
    recorded(21, 3),
    guest(22, 4, {
      type: "tool.call",
      agent: "root",
      callId: "say",
      name: "message_user",
      args: {},
    }),
  ]);

  expect(nativeCalls(frames, new Set(["bash"]))).toEqual([
    { id: "b1", call: { from: 0, to: 2 }, result: { from: 10, to: 13 } },
  ]);
});
