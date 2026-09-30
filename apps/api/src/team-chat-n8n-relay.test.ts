import { describe, expect, it } from "vitest";
import {
  isConsistentSlackEvent,
  parseN8nRelayMessage,
  toN8nRelayInbound,
  verifyN8nRelayBearer,
} from "./team-chat-n8n-relay.js";

describe("n8n team chat relay", () => {
  it("keeps an ambient human message in its source thread and rejects unsafe routes", () => {
    const event = {
      type: "message",
      user: "U-human",
      channel: "C-allowed",
      ts: "1.2",
      text: "Human exchange",
    };
    const body = JSON.stringify({
      provider: "slack",
      relaySenderId: "U-relay",
      workspaceId: "T-work",
      conversationKey: "C-allowed:1.2",
      conversationId: "slack:C-allowed:1.2",
      eventId: "1.2",
      replyThreadId: "1.2",
      sender: { id: "U-human" },
      content: event.text,
      kind: "ambient",
      slackEvent: event,
    });
    expect(verifyN8nRelayBearer("secret", "Bearer secret")).toBe(true);
    expect(verifyN8nRelayBearer("secret", "Bearer wrong")).toBe(false);
    const parsed = parseN8nRelayMessage(body)!;
    expect(toN8nRelayInbound(parsed)).toMatchObject({
      conversationKey: "C-allowed:1.2",
      relayConversationKey: "C-allowed",
      replyThreadId: "1.2",
      senderId: "U-human",
      kind: "ambient",
    });
    expect(isConsistentSlackEvent(parsed, "U-ceo")).toBe(true);
    expect(
      isConsistentSlackEvent({ ...parsed, conversationId: "slack:C-other:1.2" }, "U-ceo"),
    ).toBe(false);
    expect(
      isConsistentSlackEvent(
        { ...parsed, slackEvent: { ...event, subtype: "bot_message" } },
        "U-ceo",
      ),
    ).toBe(false);
  });
});
