import { describe, expect, it } from "vitest";
import { isAsideOnlyMessage } from "./message-visibility.js";

describe("isAsideOnlyMessage", () => {
  it("treats a handoff, a channel note and a meta line as asides", () => {
    expect(
      isAsideOnlyMessage([
        { kind: "handoff", fromBotId: "chief", toBotId: "coder", text: "over to you" },
      ]),
    ).toBe(true);
    expect(
      isAsideOnlyMessage([
        {
          kind: "channel_message",
          provider: "matrix",
          channelId: "room-1",
          fromAddress: "someone@example.test",
          fromLabel: "Someone",
          text: "hello",
        },
      ]),
    ).toBe(true);
    expect(isAsideOnlyMessage([{ kind: "meta", text: "Run stopped" }])).toBe(true);
  });

  it("is not an aside as soon as the message says something itself", () => {
    expect(isAsideOnlyMessage([])).toBe(false);
    expect(isAsideOnlyMessage([{ kind: "text", text: "Done." }])).toBe(false);
    expect(
      isAsideOnlyMessage([
        { kind: "handoff", fromBotId: "chief", toBotId: "coder", text: "over to you" },
        { kind: "text", text: "Done." },
      ]),
    ).toBe(false);
  });
});
