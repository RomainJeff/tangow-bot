import { SessionEntrySchema } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import { activityNotificationsEnabled, activityPromptSnippet } from "./runs.js";

const envelope = {
  id: "entry-1",
  sessionId: "session-1",
  seq: 1,
  parentId: "entry-0",
  ts: "2026-10-01T09:00:00.000Z",
};

describe("run activity copy", () => {
  it("presents structured agent messages instead of their internal wake prompt", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] A message just arrived from another bot with internal routing data",
        source: SessionEntrySchema.parse({
          ...envelope,
          type: "bot.message.received",
          payload: {
            from: { kind: "bot", botId: "maya", name: "Maya" },
            fromSessionId: "session-maya",
            fromEntryId: "entry-maya",
            text: "Please check the release workflow.",
            intent: "request",
            hop: 1,
            exchangeId: "entry-maya",
          },
        }),
      }),
    ).toBe("Maya asked: Please check the release workflow.");
  });

  it("fails closed when an agent message has no valid structured source", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] private internal routing envelope",
        source: SessionEntrySchema.parse({
          ...envelope,
          type: "user.message",
          payload: { blocks: [{ kind: "text", text: "not a peer message" }], source: "app" },
        }),
      }),
    ).toBe("Message from another agent");
  });
});

describe("run activity notification preference", () => {
  it("silences only direct messages", () => {
    expect(activityNotificationsEnabled(null, false)).toBe(false);
    expect(activityNotificationsEnabled("group-1", false)).toBe(true);
  });
});
