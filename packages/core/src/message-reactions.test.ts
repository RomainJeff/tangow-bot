import type { MessageBlock } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import { messageReaction } from "./message-reactions.js";

const message = (id: string, text: string, replyToMessageId?: string) => ({
  id,
  role: "user",
  blocks: [{ kind: "text", text }] as MessageBlock[],
  replyToMessageId,
});

describe("reaction conversation presentation", () => {
  it("does not collapse ordinary replies, standalone emoji, or bot messages", () => {
    expect(messageReaction(message("one", "❤️"))).toBeNull();
    expect(messageReaction(message("two", "❤️ thank you", "parent"))).toBeNull();
    expect(messageReaction({ ...message("three", "❤️", "parent"), role: "bot" })).toBeNull();
  });
});
