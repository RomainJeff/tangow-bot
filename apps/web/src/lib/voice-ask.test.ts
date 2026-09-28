import { describe, expect, it } from "vitest";
import {
  type AskBlock,
  callAskActions,
  canAnswerAskByVoice,
  isDetailApproval,
  spokenAskAnswer,
} from "./voice-ask";

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

describe("voice call approvals with a detail", () => {
  const approval = (detail?: string) =>
    ask({
      text: "Create bot “Veille”?",
      approvalEffectId: "effect-1",
      ...(detail ? { detail } : {}),
      actions: [
        { id: "allow", label: "Create bot", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
    });

  it("offers only deny when the card carries a detail", () => {
    expect(callAskActions(approval("Title: Veille")).map((action) => action.id)).toEqual(["deny"]);
    expect(isDetailApproval(approval("Title: Veille"))).toBe(true);
  });

  it("leaves an approval without a detail, and a plain ask, unchanged", () => {
    expect(callAskActions(approval()).map((action) => action.id)).toEqual(["allow", "deny"]);
    expect(isDetailApproval(approval())).toBe(false);
    expect(
      callAskActions(ask({ detail: "x", actions: [{ id: "a", label: "A" }] })).map((a) => a.id),
    ).toEqual(["a"]);
  });

  it("never turns a spoken sentence into an approval of a detailed card", () => {
    const block = approval("Title: Veille");
    expect(spokenAskAnswer(block, "yes")).toBeNull();
    expect(spokenAskAnswer(block, "go ahead, create it")).toBeNull();
    expect(spokenAskAnswer(block, "no")).toBe("deny");
  });

  it("passes spoken answers through as before elsewhere", () => {
    expect(spokenAskAnswer(approval(), "yes")).toBe("yes");
    expect(spokenAskAnswer(ask({ text: "Which city?" }), "Seoul please")).toBe("Seoul please");
  });
});
