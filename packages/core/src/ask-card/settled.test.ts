import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { askFormOf, storedAnswerOf } from "./form.js";
import { askSettledOf } from "./settled.js";

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

const cities = [
  { id: "choice-1", label: "Berlin" },
  { id: "choice-2", label: "Seoul" },
];
const city = {
  id: "q1",
  header: "City",
  question: "Which **city**?",
  options: [
    { id: "q1o1", label: "Berlin" },
    { id: "q1o2", label: "Seoul" },
  ],
};
const diet = { id: "q2", question: "Any diet?", required: false };

function settled(block: Omit<AskBlock, "kind">) {
  const ask: AskBlock = { kind: "ask", ...block };
  const form = askFormOf(ask);
  if (!form) throw new Error("not a question card");
  return askSettledOf(form, block.status === "answered" ? storedAnswerOf(form, ask) : null);
}

describe("askFormOf", () => {
  it("keeps approvals, secrets and routine proposals out of the question card", () => {
    const approval: AskBlock = {
      kind: "ask",
      text: "Send?",
      approvalEffectId: "e1",
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    };
    const secret: AskBlock = { kind: "ask", text: "Key?", input: "secret" };
    const proposal: AskBlock = { kind: "ask", text: "Routine?", proposal: "routine" };
    expect([approval, secret, proposal].map((block) => askFormOf(block))).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("reads a legacy choice card as one required single-choice question", () => {
    expect(askFormOf({ kind: "ask", text: "Which city?", actions: cities })).toEqual({
      encoding: "legacy-choice",
      questions: [
        {
          id: "answer",
          header: null,
          text: "Which city?",
          options: cities,
          multiSelect: false,
          required: true,
        },
      ],
    });
  });
});

describe("askSettledOf, one row per stored shape (spec §4.4)", () => {
  it("one question: its header, and the chosen label", () => {
    expect(
      settled({
        text: "",
        status: "answered",
        questions: [city],
        answers: { q1: { selected: ["q1o2"] } },
      }),
    ).toEqual({
      kind: "answered",
      line: "City",
      bubble: { kind: "single", value: { kind: "text", text: "Seoul" } },
    });
  });

  it("several questions: the headers, and one line per question", () => {
    expect(
      settled({
        text: "",
        status: "answered",
        questions: [city, diet],
        answers: { q1: { selected: ["q1o1"] }, q2: { skipped: true } },
      }),
    ).toEqual({
      kind: "answered",
      line: "City · Any diet?",
      bubble: {
        kind: "lines",
        lines: [
          { label: "City", value: { kind: "text", text: "Berlin" } },
          { label: "Any diet?", value: { kind: "skipped" } },
        ],
      },
    });
  });

  it("an Other text: as typed, with no prefix", () => {
    expect(
      settled({
        text: "",
        status: "answered",
        questions: [city],
        answers: { q1: { other: "Lisbon" } },
      }),
    ).toMatchObject({
      bubble: { kind: "single", value: { kind: "text", text: "Lisbon" } },
    });
  });

  it("everything skipped: one Skipped", () => {
    expect(
      settled({
        text: "",
        status: "answered",
        questions: [{ ...city, required: false }, diet],
        answers: { q1: { skipped: true }, q2: { skipped: true } },
      }),
    ).toMatchObject({
      bubble: { kind: "single", value: { kind: "skipped" } },
    });
  });

  it("a legacy choice id: the question as plain text, and the action's label", () => {
    expect(
      settled({ text: "Which **city**?", status: "answered", answer: "choice-2", actions: cities }),
    ).toEqual({
      kind: "answered",
      line: "Which city?",
      bubble: { kind: "single", value: { kind: "text", text: "Seoul" } },
    });
  });

  it("an unknown legacy choice id: never shown raw, no bubble", () => {
    expect(
      settled({ text: "Which city?", status: "answered", answer: "choice-9", actions: cities }),
    ).toMatchObject({ bubble: null });
  });

  it("a legacy free text, an old approved included: as is", () => {
    expect(settled({ text: "Send it?", status: "answered", answer: "approved" })).toMatchObject({
      bubble: { kind: "single", value: { kind: "text", text: "approved" } },
    });
    expect(
      settled({ text: "Which city?", status: "answered", answer: "Toronto", actions: cities }),
    ).toMatchObject({
      bubble: { kind: "single", value: { kind: "text", text: "Toronto" } },
    });
  });

  it("settled from the composer: the line alone, the user's own bubble is in the thread", () => {
    expect(
      settled({ text: "", status: "answered", answer: "Berlin, no diet", questions: [city, diet] }),
    ).toEqual({
      kind: "answered",
      line: "City · Any diet?",
      bubble: null,
    });
    expect(settled({ text: "Which city?", status: "answered" })).toMatchObject({ bubble: null });
  });

  it("no longer waiting: the line, inactive", () => {
    expect(settled({ text: "Which city?", status: "pending", actions: cities })).toEqual({
      kind: "inactive",
      line: "Which city?",
    });
  });
});
