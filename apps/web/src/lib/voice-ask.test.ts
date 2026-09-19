import { describe, expect, it } from "vitest";
import { type AskBlock, canAnswerAskByVoice } from "./voice-ask";

function ask(overrides: Partial<AskBlock> = {}): AskBlock {
  return { kind: "ask", text: "", ...overrides };
}

describe("canAnswerAskByVoice", () => {
  it("allows a plain free-form ask", () => {
    expect(canAnswerAskByVoice(ask({ text: "Proceed?" }))).toBe(true);
  });

  it("allows an approval ask with actions", () => {
    expect(
      canAnswerAskByVoice(
        ask({
          text: "Allow this tool?",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("treats an empty questions array as answerable", () => {
    expect(canAnswerAskByVoice(ask({ questions: [] }))).toBe(true);
  });

  it("rejects a multi-question ask_user v2 block", () => {
    expect(
      canAnswerAskByVoice(
        ask({
          questions: [{ id: "q1", question: "Which city?" }],
        }),
      ),
    ).toBe(false);
  });
});
