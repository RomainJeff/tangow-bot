import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  computeGroupContinuations,
  computeMessageGroups,
  continuesMessageGroup,
  isNarrationMessage,
  isUserNarrationMessage,
  MESSAGE_GROUP_WINDOW_MS,
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

describe("continuesMessageGroup", () => {
  it("is false when there is no previous message", () => {
    expect(continuesMessageGroup(undefined, makeMessage())).toBe(false);
  });

  it("is true for two same-bot narration messages within the window", () => {
    const previous = makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) });
    const message = makeMessage({ createdAt: localIso(2026, 9, 2, 12, 2) });
    expect(continuesMessageGroup(previous, message)).toBe(true);
  });

  it("is false when the message is not from a bot", () => {
    const previous = makeMessage();
    const message = makeMessage({ role: "user", botId: undefined });
    expect(continuesMessageGroup(previous, message)).toBe(false);
  });

  it("is false when the previous message is not from a bot", () => {
    const previous = makeMessage({ role: "user", botId: undefined });
    const message = makeMessage();
    expect(continuesMessageGroup(previous, message)).toBe(false);
  });

  it("is false for a different bot", () => {
    const previous = makeMessage({ botId: "bot-1" });
    const message = makeMessage({ botId: "bot-2" });
    expect(continuesMessageGroup(previous, message)).toBe(false);
  });

  it("is false when the message has no botId", () => {
    const previous = makeMessage({ botId: "bot-1" });
    const message = makeMessage({ botId: undefined });
    expect(continuesMessageGroup(previous, message)).toBe(false);
  });

  it("is false when the message replies to a parent", () => {
    const previous = makeMessage();
    const message = makeMessage({ replyToMessageId: "msg-parent" });
    expect(continuesMessageGroup(previous, message)).toBe(false);
  });

  it("is false when either side is a rich card", () => {
    const previous = makeMessage({ blocks: [{ kind: "ask", text: "pick one" }] });
    const message = makeMessage();
    expect(continuesMessageGroup(previous, message)).toBe(false);

    const previous2 = makeMessage();
    const message2 = makeMessage({ blocks: [{ kind: "ask", text: "pick one" }] });
    expect(continuesMessageGroup(previous2, message2)).toBe(false);
  });

  it("is false across a time marker (day change or >= 4h gap) even for the same bot", () => {
    const previousSameDay = makeMessage({ createdAt: localIso(2026, 9, 2, 23, 50) });
    const nextDay = makeMessage({ createdAt: localIso(2026, 9, 3, 0, 10) });
    expect(continuesMessageGroup(previousSameDay, nextDay)).toBe(false);

    const previousGap = makeMessage({ createdAt: localIso(2026, 9, 2, 9, 0) });
    const afterGap = makeMessage({ createdAt: localIso(2026, 9, 2, 13, 0) });
    expect(continuesMessageGroup(previousGap, afterGap)).toBe(false);
  });

  it("is false beyond the grouping window even inside the same stretch of conversation", () => {
    const previous = makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) });
    const message = makeMessage({
      createdAt: new Date(
        new Date(localIso(2026, 9, 2, 12, 0)).getTime() + MESSAGE_GROUP_WINDOW_MS + 1000,
      ).toISOString(),
    });
    expect(continuesMessageGroup(previous, message)).toBe(false);
  });

  it("honours a caller-supplied window", () => {
    const previous = makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) });
    const message = makeMessage({ createdAt: localIso(2026, 9, 2, 12, 2) });
    expect(continuesMessageGroup(previous, message, 60 * 1000)).toBe(false);
  });

  it("is false for a non-finite or negative delta", () => {
    const previous = makeMessage({ createdAt: "not-a-date" });
    const message = makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) });
    expect(continuesMessageGroup(previous, message)).toBe(false);

    const previousLater = makeMessage({ createdAt: localIso(2026, 9, 2, 12, 5) });
    const earlierMessage = makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) });
    expect(continuesMessageGroup(previousLater, earlierMessage)).toBe(false);
  });
});

describe("computeGroupContinuations", () => {
  const noneTransparent = () => false;

  it("CA-1: three same-bot narration messages within 5 min continue after the first", () => {
    const messages = [
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) }),
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 1) }),
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 3) }),
    ];
    expect(computeGroupContinuations(messages, { isTransparent: noneTransparent })).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("CA-2: a 4th message more than 5 min after the 3rd starts a new group", () => {
    const messages = [
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) }),
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 1) }),
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 3) }),
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 10) }),
    ];
    expect(computeGroupContinuations(messages, { isTransparent: noneTransparent })).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  it("CA-3: a different author between two same-bot messages breaks the group", () => {
    const messagesOtherBot = [
      makeMessage({ botId: "bot-1", createdAt: localIso(2026, 9, 2, 12, 0) }),
      makeMessage({ botId: "bot-2", createdAt: localIso(2026, 9, 2, 12, 1) }),
      makeMessage({ botId: "bot-1", createdAt: localIso(2026, 9, 2, 12, 2) }),
    ];
    expect(computeGroupContinuations(messagesOtherBot, { isTransparent: noneTransparent })).toEqual(
      [false, false, false],
    );

    const messagesUser = [
      makeMessage({ botId: "bot-1", createdAt: localIso(2026, 9, 2, 12, 0) }),
      makeMessage({ role: "user", botId: undefined, createdAt: localIso(2026, 9, 2, 12, 1) }),
      makeMessage({ botId: "bot-1", createdAt: localIso(2026, 9, 2, 12, 2) }),
    ];
    expect(computeGroupContinuations(messagesUser, { isTransparent: noneTransparent })).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("CA-4: a rich card is never a continuation, and breaks the group after it", () => {
    const messages = [
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) }),
      makeMessage({
        createdAt: localIso(2026, 9, 2, 12, 1),
        blocks: [{ kind: "ask", text: "pick one" }],
      }),
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 2) }),
    ];
    expect(computeGroupContinuations(messages, { isTransparent: noneTransparent })).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("CA-5: a time marker forces a new group even for the same bot", () => {
    const messagesDayChange = [
      makeMessage({ createdAt: localIso(2026, 9, 2, 23, 50) }),
      makeMessage({ createdAt: localIso(2026, 9, 3, 0, 10) }),
    ];
    expect(
      computeGroupContinuations(messagesDayChange, { isTransparent: noneTransparent }),
    ).toEqual([false, false]);

    const messagesBigGap = [
      makeMessage({ createdAt: localIso(2026, 9, 2, 9, 0) }),
      makeMessage({ createdAt: localIso(2026, 9, 2, 13, 0) }),
    ];
    expect(computeGroupContinuations(messagesBigGap, { isTransparent: noneTransparent })).toEqual([
      false,
      false,
    ]);
  });

  it("CA-8: a transparent message (aside or non-rendering) between two narrations is skipped", () => {
    const aside = makeMessage({ createdAt: localIso(2026, 9, 2, 12, 1), id: "aside-1" });
    const messages = [
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) }),
      aside,
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 2) }),
    ];
    expect(
      computeGroupContinuations(messages, { isTransparent: (message) => message.id === "aside-1" }),
    ).toEqual([false, false, true]);
  });

  it("CA-11: a same-bot narration message replying to a parent starts a new group", () => {
    const messages = [
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) }),
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 1), replyToMessageId: "msg-parent" }),
    ];
    expect(computeGroupContinuations(messages, { isTransparent: noneTransparent })).toEqual([
      false,
      false,
    ]);
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
  const noneTransparent = () => false;

  it("3-message bot burst: first opens, middle is neither, last closes", () => {
    const messages = [
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) }),
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 1) }),
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 3) }),
    ];
    expect(computeMessageGroups(messages, { isTransparent: noneTransparent })).toEqual([
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
    expect(computeMessageGroups(messages, { isTransparent: noneTransparent })).toEqual([
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
    expect(computeMessageGroups(messages, { isTransparent: noneTransparent })).toEqual([
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
    expect(computeMessageGroups(messages, { isTransparent: noneTransparent })).toEqual([
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
    expect(computeMessageGroups(messages, { isTransparent: noneTransparent })).toEqual([
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
    expect(computeMessageGroups(messages, { isTransparent: noneTransparent })).toEqual([
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
    expect(computeMessageGroups(messages, { isTransparent: noneTransparent })).toEqual([
      { isFirstOfGroup: true, isLastOfGroup: true },
      { isFirstOfGroup: true, isLastOfGroup: true },
      { isFirstOfGroup: true, isLastOfGroup: true },
    ]);
  });

  it("a transparent message (renders nothing) does not break the group", () => {
    const transparent = makeMessage({ createdAt: localIso(2026, 9, 2, 12, 1), id: "hidden-1" });
    const messages = [
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) }),
      transparent,
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 2) }),
    ];
    expect(
      computeMessageGroups(messages, { isTransparent: (message) => message.id === "hidden-1" }),
    ).toEqual([
      { isFirstOfGroup: true, isLastOfGroup: false },
      { isFirstOfGroup: false, isLastOfGroup: false },
      { isFirstOfGroup: false, isLastOfGroup: true },
    ]);
  });

  it("a message without createdAt never continues and is never continued into", () => {
    const messages: ThreadMessage[] = [
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 0) }),
      { ...makeMessage(), createdAt: undefined as unknown as string },
      makeMessage({ createdAt: localIso(2026, 9, 2, 12, 2) }),
    ];
    expect(computeMessageGroups(messages, { isTransparent: noneTransparent })).toEqual([
      { isFirstOfGroup: true, isLastOfGroup: true },
      { isFirstOfGroup: true, isLastOfGroup: true },
      { isFirstOfGroup: true, isLastOfGroup: true },
    ]);
  });
});
