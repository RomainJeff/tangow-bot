import { describe, expect, it } from "vitest";
import { mergeMessageUpdate, takeLiveMessage } from "./thread-message-updates.js";

describe("shared message updates", () => {
  it("takes only the matching run and drops obsolete unscoped progress in order", () => {
    const messages = [
      { id: "first" },
      { id: "progress:legacy" },
      { id: "progress:current", runId: "current" },
      { id: "progress:other", runId: "other" },
      { id: "last" },
    ];
    const result = takeLiveMessage(messages, "progress:current");
    expect(result.previous).toBe(messages[2]);
    expect(result.remaining).toEqual([messages[0], messages[3], messages[4]]);
    expect(messages).toHaveLength(5);
  });

  it("merges an update into the stored message and keeps its identity", () => {
    type Stored = {
      id: string;
      seq: number;
      createdAt: string;
      botId: string;
      runId?: string;
      role: string;
      replyToMessageId?: string;
      replyQuote?: string;
      blocks: unknown[];
    };
    const existing: Stored = {
      id: "m",
      seq: 3,
      createdAt: "2026-10-05T10:00:00.000Z",
      botId: "bot-b",
      runId: "run-1",
      role: "bot",
      replyToMessageId: "m0",
      replyQuote: "quoted",
      blocks: [{ kind: "text", text: "a" }],
    };
    const update: Stored = {
      id: "m",
      seq: 9,
      createdAt: "2026-10-05T10:05:00.000Z",
      botId: "bot-a",
      runId: undefined,
      role: "bot",
      blocks: [{ kind: "text", text: "a" }, { kind: "link_preview" }],
    };

    expect(mergeMessageUpdate(existing, update)).toEqual({
      ...existing,
      blocks: update.blocks,
    });
    expect(mergeMessageUpdate(undefined, update)).toBeUndefined();
    expect(mergeMessageUpdate(existing, { ...update, replyQuote: "new" }).replyQuote).toBe("new");
  });
});
