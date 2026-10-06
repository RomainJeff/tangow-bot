import { describe, expect, it } from "vitest";
import {
  type AskBlock,
  callAskActions,
  canAnswerAskByVoice,
  isScreenOnlyApproval,
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

const veille = {
  name: "Veille",
  title: "Watches competitors",
  instructions: "Track them.",
  prompt: "",
  computerMode: "",
} as const;

describe("voice call approvals", () => {
  const approval = (overrides: Partial<AskBlock> = {}) =>
    ask({
      text: "Create bot “Veille”?",
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Create bot", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
      ...overrides,
    });

  it("offers only deny on a Create bot card", () => {
    const block = approval({ detail: "Title: Watches competitors", spawnBot: veille });
    expect(callAskActions(block).map((action) => action.id)).toEqual(["deny"]);
    expect(isScreenOnlyApproval(block)).toBe(true);
  });

  it("keeps every action on other approvals, even with a detail", () => {
    const createSpace = approval({
      text: "Create space “Ops”?",
      detail: "A new space with its own bots.",
      actions: [
        { id: "allow", label: "Create space", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
    });
    expect(callAskActions(createSpace).map((action) => action.id)).toEqual(["allow", "deny"]);
    expect(isScreenOnlyApproval(createSpace)).toBe(false);
    expect(spokenAskAnswer(createSpace, "yes")).toBe("yes");
    expect(
      callAskActions(ask({ spawnBot: veille, actions: [{ id: "a", label: "A" }] })).map(
        (a) => a.id,
      ),
    ).toEqual(["a"]);
  });

  it("never turns a spoken sentence into an approval of a Create bot card", () => {
    const block = approval({ spawnBot: veille });
    expect(spokenAskAnswer(block, "yes")).toBeNull();
    expect(spokenAskAnswer(block, "go ahead, create it")).toBeNull();
    expect(spokenAskAnswer(block, "no")).toBe("deny");
  });

  it("passes spoken answers through as before elsewhere", () => {
    expect(spokenAskAnswer(approval(), "yes")).toBe("yes");
    expect(spokenAskAnswer(ask({ text: "Which city?" }), "Seoul please")).toBe("Seoul please");
  });
});
