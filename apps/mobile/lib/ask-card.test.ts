import type { MessageBlock } from "@rakazo/contracts";
import type { Clock, OptionId } from "@rakazo/core";
import { askSettledOf, createAskCard, storedAnswerOf } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { answerLines, interruptWhenAway, questionCardOf } from "./ask-card";

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

const t = (message: string) => `«${message}»`;
const cities: AskBlock = {
  kind: "ask",
  text: "Which city?",
  actions: [
    { id: "choice-1", label: "Berlin" },
    { id: "choice-2", label: "Seoul" },
  ],
};
const stack: AskBlock = {
  kind: "ask",
  text: "A few questions",
  questions: [
    {
      id: "q1",
      header: "City",
      question: "Which city?",
      options: [
        { id: "q1o1", label: "Berlin" },
        { id: "q1o2", label: "Seoul" },
      ],
    },
    { id: "q2", question: "Any diet?", required: false },
  ],
};
const approval: AskBlock = {
  kind: "ask",
  text: "Send the mail?",
  approvalEffectId: "effect-1",
  actions: [
    { id: "allow", label: "Allow" },
    { id: "deny", label: "Deny" },
  ],
};

function bubble(block: AskBlock, answered: Partial<AskBlock> | null) {
  const card = questionCardOf([{ ...block, ...answered }]);
  if (!card) throw new Error("not a question card");
  const view = askSettledOf(card.form, answered ? storedAnswerOf(card.form, card.block) : null);
  return answerLines(view, t);
}

describe("questionCardOf", () => {
  it("finds the question card and leaves an approval to its own card", () => {
    expect(questionCardOf([{ kind: "text", text: "Hi" }, cities])?.block.text).toBe("Which city?");
    expect(questionCardOf([approval])).toBe(null);
  });
});

describe("answerLines, one row per stored shape (spec §4.4)", () => {
  const shapes: [string, AskBlock, Partial<AskBlock>, string[]][] = [
    [
      "one question",
      { ...stack, questions: stack.questions?.slice(0, 1) },
      { answers: { q1: { selected: ["q1o2"] } } },
      ["Seoul"],
    ],
    [
      "several questions",
      stack,
      { answers: { q1: { selected: ["q1o2"] }, q2: { skipped: true } } },
      ["City — Seoul", "Any diet? — «Skipped»"],
    ],
    [
      "a typed Other",
      stack,
      { answers: { q1: { other: "Lisbon" }, q2: { other: "Vegan" } } },
      ["City — Lisbon", "Any diet? — Vegan"],
    ],
    [
      "everything skipped",
      stack,
      { answers: { q1: { skipped: true }, q2: { skipped: true } } },
      ["«Skipped»"],
    ],
    ["a legacy choice", cities, { answer: "choice-2" }, ["Seoul"]],
    ["an unknown legacy choice", cities, { answer: "choice-9" }, []],
    [
      "legacy free text",
      { kind: "ask", text: "When?" } as AskBlock,
      { answer: "Tomorrow at 9" },
      ["Tomorrow at 9"],
    ],
    ["answered from the composer", cities, {}, []],
  ];
  it.each(shapes)("%s", (_shape, block, stored, lines) => {
    expect(bubble(block, { status: "answered", ...stored })).toEqual(lines);
  });

  it("gives a card no longer waiting no bubble", () => {
    expect(bubble(cities, null)).toEqual([]);
  });
});

function manualClock(): Clock & { advance(ms: number): void } {
  let now = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  let next = 0;
  return {
    setTimeout(run, ms) {
      pending.set(++next, { at: now + ms, run });
      return next;
    },
    clearTimeout: (handle) => void pending.delete(handle as number),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at > now) continue;
        pending.delete(id);
        timer.run();
      }
    },
  };
}

describe("interruptWhenAway", () => {
  function heldCard() {
    const form = questionCardOf([cities])?.form;
    if (!form) throw new Error("not a question card");
    const clock = manualClock();
    const sent: string[] = [];
    const card = createAskCard({
      form,
      key: `away-${Math.random()}`,
      waiting: true,
      clock,
      send: async (wire) => {
        sent.push(wire);
        return { ok: true };
      },
    });
    let emit: (state: string) => void = () => {};
    const appState = {
      addEventListener: (_type: "change", listener: (state: string) => void) => {
        emit = listener;
        return {
          remove: () => {
            emit = () => {};
          },
        };
      },
    };
    const stop = interruptWhenAway(appState, card.interrupt);
    card.tap("choice-2" as OptionId);
    return { clock, sent, stop, emit: (state: string) => emit(state) };
  }

  it("sends the held choice when the app stays active", () => {
    const { clock, sent, emit } = heldCard();
    emit("active");
    clock.advance(650);
    expect(sent).toEqual(["choice-2"]);
  });

  it.each(["background", "inactive"])("cancels the hold when the app goes %s", (state) => {
    const { clock, sent, emit } = heldCard();
    emit(state);
    clock.advance(650);
    expect(sent).toEqual([]);
  });

  it("stops listening once removed", () => {
    const { clock, sent, stop, emit } = heldCard();
    stop();
    emit("background");
    clock.advance(650);
    expect(sent).toEqual(["choice-2"]);
  });
});
