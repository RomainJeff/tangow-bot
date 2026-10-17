import type { MessageBlock, Run } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { linkEntries } from "../session-log/fixtures/read-fixture.js";
import { projectThreadView } from "../session-log/project-thread-view.js";
import { answersPendingQuestion } from "./answering.js";

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;
const model = { provider: "emulator", id: "emulator-1" };

function waitingOn(botId: string, block: AskBlock) {
  const run = { botId, runId: `run_${botId}` };
  return projectThreadView(
    linkEntries("ans", [
      {
        ...run,
        type: "run.started",
        payload: { trigger: { kind: "direct" }, model, effort: null },
      },
      { ...run, type: "assistant.ask", payload: { block } },
    ]),
  );
}

const waitingRun = (botId: string): Pick<Run, "botId" | "status"> => ({
  botId,
  status: "waiting_input",
});

const question: AskBlock = {
  kind: "ask",
  text: "Which city?",
  questions: [
    {
      id: "q1",
      question: "Which city?",
      options: [
        { id: "q1o1", label: "Berlin" },
        { id: "q1o2", label: "Seoul" },
      ],
    },
  ],
};

describe("answersPendingQuestion", () => {
  it("is true while the thread's bot waits on a question, and false once answered", () => {
    expect(answersPendingQuestion(waitingOn("ada", question), "ada", [waitingRun("ada")])).toBe(
      true,
    );
    const answered = waitingOn("ada", { ...question, status: "answered", answer: "Berlin" });
    expect(answersPendingQuestion(answered, "ada", [])).toBe(false);
  });

  it("counts a legacy choice or free-text question", () => {
    const choice: AskBlock = {
      kind: "ask",
      text: "Which city?",
      actions: [{ id: "choice-1", label: "Berlin" }],
    };
    const freeText: AskBlock = { kind: "ask", text: "Which city?" };
    expect(
      [choice, freeText].map((block) =>
        answersPendingQuestion(waitingOn("ada", block), "ada", [waitingRun("ada")]),
      ),
    ).toEqual([true, true]);
  });

  it("is false for an approval, a secret or a proposal", () => {
    const approval: AskBlock = {
      kind: "ask",
      text: "Send the email?",
      approvalEffectId: "eff_1",
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    };
    const secret: AskBlock = { kind: "ask", text: "Paste the API key", input: "secret" };
    const proposal: AskBlock = { kind: "ask", text: "Every Monday?", proposal: "routine" };
    expect(
      [approval, secret, proposal].map((block) =>
        answersPendingQuestion(waitingOn("ada", block), "ada", [waitingRun("ada")]),
      ),
    ).toEqual([false, false, false]);
  });

  it("in a group, is true only when the one waiting bot is the one a send goes to", () => {
    const boWaits = waitingOn("bo", question);
    expect(answersPendingQuestion(boWaits, "ada", [waitingRun("bo")])).toBe(false);
    expect(answersPendingQuestion(boWaits, "bo", [waitingRun("bo")])).toBe(true);
    expect(
      answersPendingQuestion(boWaits, "bo", [
        waitingRun("bo"),
        waitingRun("ada"),
        { botId: "cy", status: "running" },
      ]),
    ).toBe(false);
  });
});
