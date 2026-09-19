import type { MessageBlock } from "@rakazo/contracts";
import { isToolActivityBlock } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  botMessageOutcomeFromMidTurn,
  clampUserProgressMessage,
  extractNarrationText,
  finalBlocksAfterMidTurnProgress,
  isProgressMessageTruncated,
  isUserProgressClientNonce,
  repeatsSentUserText,
  USER_PROGRESS_MESSAGE_MAX_LENGTH,
  userMessageClientNonce,
  userProgressClientNonce,
} from "./user-progress.js";

describe("clampUserProgressMessage", () => {
  it("trims and rejects empty text", () => {
    expect(clampUserProgressMessage("  hello  ")).toBe("hello");
    expect(clampUserProgressMessage("   ")).toBe("");
  });

  it("clamps long progress beats", () => {
    const clamped = clampUserProgressMessage("x".repeat(USER_PROGRESS_MESSAGE_MAX_LENGTH + 40));
    expect(clamped).toHaveLength(USER_PROGRESS_MESSAGE_MAX_LENGTH);
    expect(clamped.endsWith("…")).toBe(true);
  });
});

describe("isProgressMessageTruncated", () => {
  it("is false for text that fits", () => {
    expect(isProgressMessageTruncated("short update")).toBe(false);
    expect(isProgressMessageTruncated("x".repeat(USER_PROGRESS_MESSAGE_MAX_LENGTH))).toBe(false);
  });

  it("is true for text that would be cut off by clampUserProgressMessage", () => {
    const long = "x".repeat(USER_PROGRESS_MESSAGE_MAX_LENGTH + 1);
    expect(isProgressMessageTruncated(long)).toBe(true);
    expect(clampUserProgressMessage(long).endsWith("…")).toBe(true);
  });
});

describe("extractNarrationText", () => {
  it("pulls text blocks and current text while keeping tool activity", () => {
    const { text, remaining } = extractNarrationText(
      [
        { kind: "text", text: "Checking calendars. " },
        { kind: "steps", steps: [{ label: "Web search", count: 1 }] },
        { kind: "text", text: "Found three options." },
      ],
      " Still looking.",
    );
    expect(text).toBe("Checking calendars. Found three options. Still looking.");
    expect(remaining).toEqual([{ kind: "steps", steps: [{ label: "Web search", count: 1 }] }]);
  });
});

describe("finalBlocksAfterMidTurnProgress", () => {
  it("drops a hollow final message that is only hidden tool activity", () => {
    const steps: MessageBlock = { kind: "steps", steps: [{ label: "Shell", count: 2 }] };
    expect(finalBlocksAfterMidTurnProgress([steps], true)).toEqual([]);
    expect(finalBlocksAfterMidTurnProgress([steps], false)).toEqual([steps]);
  });

  it("keeps a final answer alongside tool activity", () => {
    const blocks: MessageBlock[] = [
      { kind: "steps", steps: [{ label: "Web search", count: 1 }] },
      { kind: "text", text: "You are free Tuesday afternoon." },
    ];
    expect(finalBlocksAfterMidTurnProgress(blocks, true)).toEqual(blocks);
    expect(isToolActivityBlock(blocks[0]!)).toBe(true);
  });

  it("drops a final reply that repeats what message_user already said", () => {
    const blocks: MessageBlock[] = [
      { kind: "steps", steps: [{ label: "Message user", count: 1 }] },
      { kind: "text", text: "Oui, je suis là." },
    ];
    expect(finalBlocksAfterMidTurnProgress(blocks, true, ["Oui, je suis là."])).toEqual([]);
  });

  it("ignores surrounding whitespace when comparing the repeat", () => {
    const blocks: MessageBlock[] = [{ kind: "text", text: "  Done.  " }];
    expect(finalBlocksAfterMidTurnProgress(blocks, true, ["Done."])).toEqual([]);
  });

  it("keeps the part of a final reply that adds something new", () => {
    const repeated: MessageBlock = { kind: "text", text: "On it." };
    const added: MessageBlock = { kind: "text", text: "Here is the summary." };
    expect(finalBlocksAfterMidTurnProgress([repeated, added], true, ["On it."])).toEqual([added]);
  });

  it("keeps a final reply that only resembles the mid-turn text", () => {
    const blocks: MessageBlock[] = [{ kind: "text", text: "Done, and here is why." }];
    expect(finalBlocksAfterMidTurnProgress(blocks, true, ["Done."])).toEqual(blocks);
  });

  it("leaves the final reply alone when nothing was posted mid-turn", () => {
    const blocks: MessageBlock[] = [{ kind: "text", text: "Oui, je suis là." }];
    expect(finalBlocksAfterMidTurnProgress(blocks, false, ["Oui, je suis là."])).toEqual(blocks);
  });
});

describe("botMessageOutcomeFromMidTurn", () => {
  it("prefers the final reply as a result", () => {
    expect(botMessageOutcomeFromMidTurn("All set.", ["Checking calendars…"])).toEqual({
      text: "All set.",
      intent: "result",
    });
  });

  it("returns mid-turn progress as status when there is no final reply", () => {
    expect(
      botMessageOutcomeFromMidTurn("", ["Checking calendars…", "Found three free slots."]),
    ).toEqual({
      text: "Checking calendars…\n\nFound three free slots.",
      intent: "status",
    });
  });

  it("returns null when nothing was posted", () => {
    expect(botMessageOutcomeFromMidTurn("  ", [])).toBeNull();
  });
});

describe("userProgressClientNonce", () => {
  it("tags mid-turn progress messages for reconciler detection", () => {
    const nonce = userProgressClientNonce("run-1", 0);
    expect(nonce.startsWith("user-progress:run-1:0:")).toBe(true);
    expect(isUserProgressClientNonce(nonce)).toBe(true);
    expect(userProgressClientNonce("run-1", 0)).not.toBe(nonce);
    expect(isUserProgressClientNonce(null)).toBe(false);
    expect(isUserProgressClientNonce("other")).toBe(false);
  });

  it("gives message_user its own prefix while both count as mid-turn", () => {
    const progress = userProgressClientNonce("run-1", 0);
    const userMessage = userMessageClientNonce("run-1", 1);

    expect(userMessage.startsWith("user-message:")).toBe(true);
    expect(userMessage.startsWith("user-progress:")).toBe(false);
    expect(progress.startsWith("user-message:")).toBe(false);
    // Transcript rebuilders (executor resume, job reconciler) want both kinds.
    expect(isUserProgressClientNonce(userMessage)).toBe(true);
    expect(isUserProgressClientNonce(progress)).toBe(true);
  });
});

describe("repeatsSentUserText", () => {
  it("recognises a message the user already read, ignoring surrounding whitespace", () => {
    expect(repeatsSentUserText("Charge moyen", ["Checking…", " Charge moyen \n"])).toBe(true);
  });

  it("does not flag a message that merely resembles or extends an earlier one", () => {
    expect(repeatsSentUserText("Charge moyen, top risques jeudi.", ["Charge moyen"])).toBe(false);
    expect(repeatsSentUserText("Charge moyen", ["Charge moyen, top risques jeudi."])).toBe(false);
  });

  it("catches a re-send that differs only by case, edge punctuation, or wrapping quotes", () => {
    // The near-exact repeat a strict trim-equality check let through: the same bubble reworded
    // with only cosmetic changes, including across a pause/resume (its history is seeded from the
    // run's prior bubbles).
    expect(repeatsSentUserText("C'est calé.", ["c'est calé"])).toBe(true);
    expect(repeatsSentUserText("  Go, on lance.  ", ["Go, on lance"])).toBe(true);
    expect(repeatsSentUserText("« C'est calé »", ["C'est calé"])).toBe(true);
  });

  it("still lets a genuinely reworded point through (paraphrase is the model's job, not this)", () => {
    // Different wording is NOT a repeat here — the instructions handle re-explanation, so this
    // stays conservative to avoid swallowing a legitimately new message.
    expect(
      repeatsSentUserText("Oui, interdiction formelle : rien dans le Notion foyer.", [
        "C'était ça : une interdiction formelle dans mes instructions.",
      ]),
    ).toBe(false);
  });

  it("never flags an empty message or an empty history", () => {
    expect(repeatsSentUserText("   ", ["   "])).toBe(false);
    expect(repeatsSentUserText("Done.", [])).toBe(false);
  });
});
