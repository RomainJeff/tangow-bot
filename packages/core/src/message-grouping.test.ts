import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  computeMessageGroups,
  isNarrationMessage,
  isUserNarrationMessage,
} from "./message-grouping.js";

/** Local wall-clock instant as ISO, so the day-boundary cases hold in any timezone. */
function localIso(year: number, month: number, day: number, hour: number, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

let nextId = 0;

function makeMessage(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  nextId += 1;
  return {
    id: `msg-${nextId}`,
    threadId: "thread-1",
    seq: nextId,
    role: "bot",
    blocks: [{ kind: "text", text: "hi" }],
    botId: "bot-1",
    createdAt: localIso(2026, 9, 2, 12, 0),
    ...overrides,
  };
}

describe("isNarrationMessage", () => {
  it("is true for a bot message made only of text/progress/steps blocks", () => {
    expect(
      isNarrationMessage({
        role: "bot",
        blocks: [
          { kind: "text", text: "hi" },
          { kind: "progress", text: "working" },
          { kind: "steps", steps: [{ label: "step", count: 1 }] },
        ],
      }),
    ).toBe(true);
  });

  it("is false for a non-bot message", () => {
    expect(isNarrationMessage({ role: "user", blocks: [{ kind: "text", text: "hi" }] })).toBe(
      false,
    );
  });

  it("is false for a message with no blocks", () => {
    expect(isNarrationMessage({ role: "bot", blocks: [] })).toBe(false);
  });

  it("is false when any block is a rich card", () => {
    expect(
      isNarrationMessage({
        role: "bot",
        blocks: [
          { kind: "text", text: "hi" },
          { kind: "ask", text: "pick one" },
        ],
      }),
    ).toBe(false);
  });
});

describe("isUserNarrationMessage", () => {
  it("is true for a user message made only of text blocks", () => {
    expect(
      isUserNarrationMessage({ role: "user", blocks: [{ kind: "text", text: "hi @bot" }] }),
    ).toBe(true);
  });

  it("is false for a non-user message", () => {
    expect(isUserNarrationMessage({ role: "bot", blocks: [{ kind: "text", text: "hi" }] })).toBe(
      false,
    );
  });

  it("is false for a message with no blocks", () => {
    expect(isUserNarrationMessage({ role: "user", blocks: [] })).toBe(false);
  });

  it("is false when any block is not text (e.g. an attachment)", () => {
    expect(
      isUserNarrationMessage({
        role: "user",
        blocks: [
          { kind: "text", text: "here" },
          { kind: "image", artifactId: "art-1", mimeType: "image/png", name: "shot.png" },
        ],
      }),
    ).toBe(false);
  });
});

describe("computeMessageGroups", () => {
  it("3-message bot burst: first opens, middle is neither, last closes", () => {
    const messages = [
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) }),
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 1) }),
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 3) }),
    ];
    expect(computeMessageGroups(messages)).toEqual([
      { isFirstOfGroup: true, isLastOfGroup: false },
      { isFirstOfGroup: false, isLastOfGroup: false },
      { isFirstOfGroup: false, isLastOfGroup: true },
    ]);
  });

  it("a skill line added to a bot message keeps the burst grouped as before", () => {
    const skillLine = {
      kind: "skill_source",
      skillUid: "0123456789abcdef0123456789abcdef",
      skillId: "user:invoices",
      name: "Invoices",
      change: "learned",
    } as const;
    const messages = [
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) }),
      makeMessage({
        createdAt: localIso(2026, 9, 2, 12, 1),
        blocks: [{ kind: "text", text: "Filed." }, { kind: "text", text: "Done." }, skillLine],
      }),
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 3) }),
    ];
    expect(computeMessageGroups(messages)).toEqual([
      { isFirstOfGroup: true, isLastOfGroup: false },
      { isFirstOfGroup: false, isLastOfGroup: false },
      { isFirstOfGroup: false, isLastOfGroup: true },
    ]);
  });

  it("two consecutive text-only user messages within the window group together", () => {
    const messages = [
      makeMessage({
        role: "user",
        botId: undefined,
        blocks: [{ kind: "text", text: "hi" }],
        createdAt: localIso(2026, 9, 2, 12, 0),
      }),
      makeMessage({
        role: "user",
        botId: undefined,
        blocks: [{ kind: "text", text: "there" }],
        createdAt: localIso(2026, 9, 2, 12, 2),
      }),
    ];
    expect(computeMessageGroups(messages)).toEqual([
      { isFirstOfGroup: true, isLastOfGroup: false },
      { isFirstOfGroup: false, isLastOfGroup: true },
    ]);
  });

  it("a non-text user block (attachment) breaks the group on both sides", () => {
    const messages = [
      makeMessage({
        role: "user",
        botId: undefined,
        blocks: [{ kind: "text", text: "hi" }],
        createdAt: localIso(2026, 9, 2, 12, 0),
      }),
      makeMessage({
        role: "user",
        botId: undefined,
        blocks: [{ kind: "image", artifactId: "art-1", mimeType: "image/png", name: "shot.png" }],
        createdAt: localIso(2026, 9, 2, 12, 1),
      }),
      makeMessage({
        role: "user",
        botId: undefined,
        blocks: [{ kind: "text", text: "after" }],
        createdAt: localIso(2026, 9, 2, 12, 2),
      }),
    ];
    expect(computeMessageGroups(messages)).toEqual([
      { isFirstOfGroup: true, isLastOfGroup: true },
      { isFirstOfGroup: true, isLastOfGroup: true },
      { isFirstOfGroup: true, isLastOfGroup: true },
    ]);
  });

  it("two user messages more than 5 min apart start a new group", () => {
    const messages = [
      makeMessage({
        role: "user",
        botId: undefined,
        blocks: [{ kind: "text", text: "hi" }],
        createdAt: localIso(2026, 9, 2, 12, 0),
      }),
      makeMessage({
        role: "user",
        botId: undefined,
        blocks: [{ kind: "text", text: "there" }],
        createdAt: localIso(2026, 9, 2, 12, 10),
      }),
    ];
    expect(computeMessageGroups(messages)).toEqual([
      { isFirstOfGroup: true, isLastOfGroup: true },
      { isFirstOfGroup: true, isLastOfGroup: true },
    ]);
  });

  it("a time marker between two user messages breaks the group", () => {
    const messages = [
      makeMessage({
        role: "user",
        botId: undefined,
        blocks: [{ kind: "text", text: "hi" }],
        createdAt: localIso(2026, 9, 2, 23, 50),
      }),
      makeMessage({
        role: "user",
        botId: undefined,
        blocks: [{ kind: "text", text: "there" }],
        createdAt: localIso(2026, 9, 3, 0, 10),
      }),
    ];
    expect(computeMessageGroups(messages)).toEqual([
      { isFirstOfGroup: true, isLastOfGroup: true },
      { isFirstOfGroup: true, isLastOfGroup: true },
    ]);
  });

  it("a user message replying to a parent starts a new group", () => {
    const messages = [
      makeMessage({
        role: "user",
        botId: undefined,
        blocks: [{ kind: "text", text: "hi" }],
        createdAt: localIso(2026, 9, 2, 12, 0),
      }),
      makeMessage({
        role: "user",
        botId: undefined,
        blocks: [{ kind: "text", text: "there" }],
        createdAt: localIso(2026, 9, 2, 12, 1),
        replyToMessageId: "msg-parent",
      }),
    ];
    expect(computeMessageGroups(messages)).toEqual([
      { isFirstOfGroup: true, isLastOfGroup: true },
      { isFirstOfGroup: true, isLastOfGroup: true },
    ]);
  });

  it("an aside between two same-bot messages breaks the group (asides are not transparent)", () => {
    const messages = [
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) }),
      makeMessage({
        role: "bot",
        botId: "bot-1",
        blocks: [{ kind: "handoff", fromBotId: "bot-1", toBotId: "bot-2", text: "handing off" }],
        createdAt: localIso(2026, 9, 2, 12, 1),
      }),
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 2) }),
    ];
    expect(computeMessageGroups(messages)).toEqual([
      { isFirstOfGroup: true, isLastOfGroup: true },
      { isFirstOfGroup: true, isLastOfGroup: true },
      { isFirstOfGroup: true, isLastOfGroup: true },
    ]);
  });

  it("a message without createdAt never continues and is never continued into", () => {
    const messages: ThreadMessage[] = [
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) }),
      { ...makeMessage(), createdAt: undefined as unknown as string },
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 2) }),
    ];
    expect(computeMessageGroups(messages)).toEqual([
      { isFirstOfGroup: true, isLastOfGroup: true },
      { isFirstOfGroup: true, isLastOfGroup: true },
      { isFirstOfGroup: true, isLastOfGroup: true },
    ]);
  });
});
