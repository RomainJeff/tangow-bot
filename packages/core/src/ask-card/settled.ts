import type { AskAnswers } from "@rakazo/contracts";
import { plainText } from "../plain-text.js";
import type { AskForm, FormQuestion, NonEmpty, StoredAnswer } from "./form.js";

/** Typed text or option labels; `skipped` is translated by the shell. */
export type AnswerValue = { kind: "text"; text: string } | { kind: "skipped" };

export type AnswerBubble =
  | { kind: "single"; value: AnswerValue }
  | { kind: "lines"; lines: NonEmpty<{ label: string; value: AnswerValue }> };

/** `line`: the headers joined by " · ", or the question as one plain line. */
export type AskSettledView =
  | { kind: "answered"; line: string; bubble: AnswerBubble | null }
  | { kind: "inactive"; line: string };

const UNKNOWN_CHOICE_ID = /^choice-\d+$/;

/** A question's name on one line: its header, or the question as plain text. */
export function labelOf(question: FormQuestion): string {
  return question.header ?? plainText(question.text);
}

export function answerValue(
  question: FormQuestion,
  answer: AskAnswers[string] | undefined,
): AnswerValue {
  const labels = (answer?.selected ?? []).flatMap(
    (id) => question.options.find((option) => option.id === id)?.label ?? [],
  );
  if (answer?.other) labels.push(answer.other);
  return labels.length ? { kind: "text", text: labels.join(", ") } : { kind: "skipped" };
}

function bubbleOf(form: AskForm, stored: StoredAnswer): AnswerBubble | null {
  if (stored.kind === "none") return null;
  if (stored.kind === "answers") {
    const lineOf = (question: FormQuestion) => ({
      label: labelOf(question),
      value: answerValue(question, stored.answers[question.id]),
    });
    const [first, ...rest] = form.questions;
    const lines: NonEmpty<ReturnType<typeof lineOf>> = [lineOf(first), ...rest.map(lineOf)];
    if (rest.length === 0 || lines.every((line) => line.value.kind === "skipped")) {
      return { kind: "single", value: lines[0].value };
    }
    return { kind: "lines", lines };
  }
  const action = form.questions[0].options.find((option) => option.id === stored.answer);
  if (action) return { kind: "single", value: { kind: "text", text: action.label } };
  if (form.encoding === "legacy-choice" && UNKNOWN_CHOICE_ID.test(stored.answer)) return null;
  return { kind: "single", value: { kind: "text", text: stored.answer } };
}

/** The settled card, from the block or the optimistic commit; `null` is a card no longer waiting. */
export function askSettledOf(form: AskForm, stored: StoredAnswer | null): AskSettledView {
  const line = form.questions.map(labelOf).join(" · ");
  if (!stored) return { kind: "inactive", line };
  return { kind: "answered", line, bubble: bubbleOf(form, stored) };
}
