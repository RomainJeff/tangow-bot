import { describe, expect, it } from "vitest";
import { SessionEntrySchema } from "./index.js";

const envelope = {
  id: "e-3",
  sessionId: "ses_1",
  seq: 3,
  parentId: "e-2",
  ts: "2026-10-10T09:00:03.000Z",
};
const note = { type: "system.note", payload: { text: "Bob joined." } };
const text = { type: "assistant.text", payload: { blocks: [{ kind: "text", text: "Hi." }] } };
const sent = {
  type: "bot.message.sent",
  payload: {
    to: { kind: "bot", botId: "bot_bob", name: "Bob" },
    text: "Hi Bob.",
    intent: "request",
    hop: 1,
    exchangeId: "e-3",
  },
};

function issues(entry: object): string[] {
  const parsed = SessionEntrySchema.safeParse(entry);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

describe("SessionEntrySchema", () => {
  it.each([
    [
      "the first entry of a session with no parent",
      { ...envelope, seq: 0, parentId: null, ...note },
    ],
    ["a clear with no parent", { ...envelope, parentId: null, type: "clear", payload: {} }],
    [
      "a compaction covering up to its parent",
      { ...envelope, type: "compaction", payload: { summary: "Earlier.", coveredUpToSeq: 2 } },
    ],
  ])("accepts %s", (_, entry) => {
    expect(issues(entry)).toEqual([]);
  });

  it.each([
    [
      "a rewind with no parent",
      { ...envelope, parentId: null, type: "rewind", payload: {} },
      ["parentId: Invalid input: expected string, received null"],
    ],
    [
      "a clear with a parent",
      { ...envelope, type: "clear", payload: {} },
      ["parentId: Invalid input: expected null, received string"],
    ],
    [
      "an entry with no parent after the first",
      { ...envelope, parentId: null, ...note },
      ["parentId: Only a clear entry or the first entry of a session has no parent"],
    ],
    [
      "a first entry with a parent",
      { ...envelope, seq: 0, ...note },
      ["parentId: The first entry of a session has no parent"],
    ],
    [
      "a run entry with no run",
      { ...envelope, botId: "bot_ada", ...text },
      ["runId: Invalid input: expected string, received undefined"],
    ],
    [
      "a run entry with no bot",
      { ...envelope, runId: "run_1", ...text },
      ["botId: Invalid input: expected string, received undefined"],
    ],
    [
      "a sent bot message with no bot",
      { ...envelope, ...sent },
      ["botId: Invalid input: expected string, received undefined"],
    ],
    [
      "a compaction that covers itself",
      { ...envelope, type: "compaction", payload: { summary: "Earlier.", coveredUpToSeq: 3 } },
      ["payload.coveredUpToSeq: A compaction covers only entries before it"],
    ],
    [
      "an entry risen from its own session",
      {
        ...envelope,
        type: "effect.resolved",
        payload: { effectId: "effect_1", decision: "approved", originSessionId: "ses_1" },
      },
      ["payload.originSessionId: An entry rises only from another session"],
    ],
    [
      "a clear with a payload",
      { ...envelope, parentId: null, type: "clear", payload: { reason: "Fresh start." } },
      ['payload: Unrecognized key: "reason"'],
    ],
  ])("rejects %s", (_, entry, expected) => {
    expect(issues(entry)).toEqual(expected);
  });
});

it.each(["user.message", "assistant.text"])(
  "reads %s with retired charts while preserving other blocks",
  (type) => {
    const blocks = [
      { kind: "text", text: "Kept" },
      { kind: "chart", name: "Retired", spec: {}, data: [] },
    ];
    const parsed = SessionEntrySchema.parse({
      ...envelope,
      botId: "bot-1",
      runId: "run-1",
      type,
      payload: { blocks, ...(type === "user.message" ? { source: "app" } : {}) },
    });
    expect(parsed.payload).toMatchObject({ blocks: [{ kind: "text", text: "Kept" }] });
    expect(
      SessionEntrySchema.safeParse({
        ...envelope,
        botId: "bot-1",
        runId: "run-1",
        type,
        payload: { blocks: [{ kind: "unknown" }], source: "app" },
      }).success,
    ).toBe(false);
  },
);
