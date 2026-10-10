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
    ["a rewind to its target", { ...envelope, type: "rewind", payload: {} }],
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
      "a clear with a payload",
      { ...envelope, parentId: null, type: "clear", payload: { reason: "Fresh start." } },
      ['payload: Unrecognized key: "reason"'],
    ],
  ])("rejects %s", (_, entry, expected) => {
    expect(issues(entry)).toEqual(expected);
  });
});
