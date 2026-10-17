import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { AskCardOptions, Clock, SendResult } from "./card.js";
import { createAskCard, resolveAskCardView } from "./card.js";
import type { OptionId } from "./form.js";
import { askFormOf } from "./form.js";

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

function manualClock(): Clock & { advance(ms: number): void } {
  let now = 0;
  let nextId = 0;
  const pending = new Map<unknown, { at: number; run: () => void }>();
  return {
    setTimeout(run, ms) {
      pending.set(++nextId, { at: now + ms, run });
      return nextId;
    },
    clearTimeout: (handle) => void pending.delete(handle),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...pending]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const cities: AskBlock = {
  kind: "ask",
  text: "Which city?",
  actions: [
    { id: "choice-1", label: "Berlin" },
    { id: "choice-2", label: "Seoul" },
  ],
};
const berlin = "choice-1" as OptionId;
const seoul = "choice-2" as OptionId;
let keys = 0;

function card(block: AskBlock, options: Partial<AskCardOptions> & { result?: SendResult } = {}) {
  const form = askFormOf(block);
  if (!form) throw new Error("not a question card");
  const clock = manualClock();
  const sent: string[] = [];
  const subject = createAskCard({
    form,
    key: `message-${++keys}`,
    waiting: true,
    clock,
    send: async (wire) => {
      sent.push(wire);
      return options.result ?? { ok: true };
    },
    ...options,
  });
  return { card: subject, clock, sent };
}

describe("hold (CA1)", () => {
  it("sends the selected option at exactly 650 ms", () => {
    const { card: subject, clock, sent } = card(cities);
    subject.tap(seoul);
    expect(subject.view()).toMatchObject({ kind: "open", step: { selected: [seoul] } });
    clock.advance(649);
    expect(sent).toEqual([]);
    clock.advance(1);
    expect(sent).toEqual(["choice-2"]);
  });

  it("moves the choice and restarts the hold when another tile is tapped, sending once", () => {
    const { card: subject, clock, sent } = card(cities);
    subject.tap(berlin);
    clock.advance(300);
    subject.tap(seoul);
    clock.advance(649);
    expect(sent).toEqual([]);
    clock.advance(1);
    clock.advance(2000);
    expect(sent).toEqual(["choice-2"]);
  });

  it("does nothing when the tile already holding is tapped again", () => {
    const { card: subject, clock, sent } = card(cities);
    subject.tap(berlin);
    clock.advance(300);
    subject.tap(berlin);
    clock.advance(350);
    expect(sent).toEqual(["choice-1"]);
  });
});

describe("cancellation (CA2)", () => {
  type Subject = ReturnType<typeof card>["card"];
  it.each([
    [
      "opening Other…",
      (subject: Subject) => subject.openOther(),
      { selected: [], field: { text: "", canSend: false } },
    ],
    [
      "typing an answer",
      (subject: Subject) => subject.typeOther("Lisbon"),
      { selected: [seoul], field: { text: "Lisbon", canSend: true } },
    ],
    [
      "unmount or background",
      (subject: Subject) => subject.interrupt(),
      { selected: [seoul], field: null },
    ],
    [
      "the card no longer waiting",
      (subject: Subject) => subject.setWaiting(false),
      { selected: [seoul], field: null },
    ],
  ])("sends nothing after %s during the hold, and keeps the draft", (_trigger, cancel, draft) => {
    const { card: subject, clock, sent } = card(cities);
    subject.tap(seoul);
    clock.advance(300);
    expect(subject.view()).toMatchObject({ kind: "open", step: { selected: [seoul] } });
    cancel(subject);
    clock.advance(5000);
    expect({ sent, view: subject.view() }).toEqual({
      sent: [],
      view: {
        kind: "open",
        step: { question: expect.anything(), ...draft, skip: false },
        send: false,
        busy: false,
        filled: null,
        error: null,
      },
    });
  });

  it("sends nothing when a hold the event loop already queued fires after the card stopped waiting", () => {
    const form = askFormOf(cities);
    if (!form) throw new Error("not a question card");
    const due: (() => void)[] = [];
    const sent: string[] = [];
    const subject = createAskCard({
      form,
      key: `message-${++keys}`,
      waiting: true,
      clock: { setTimeout: (run) => due.push(run), clearTimeout: () => {} },
      send: async (wire) => {
        sent.push(wire);
        return { ok: true };
      },
    });
    subject.tap(seoul);
    subject.setWaiting(false);
    for (const run of due) run();
    expect({ sent, busy: subject.view() }).toEqual({
      sent: [],
      busy: expect.objectContaining({
        kind: "open",
        busy: false,
        step: expect.objectContaining({ selected: [seoul] }),
      }),
    });
  });
});

describe("a card mounted again while its answer is in flight (TM CA20)", () => {
  function inflight() {
    const form = askFormOf(cities);
    if (!form) throw new Error("not a question card");
    const clock = manualClock();
    const sent: string[] = [];
    let settle: (result: SendResult) => void = () => {};
    const options: AskCardOptions = {
      form,
      key: `message-${++keys}`,
      waiting: true,
      clock,
      send: (wire) => {
        sent.push(wire);
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
    };
    const first = createAskCard(options);
    first.tap(seoul);
    clock.advance(650);
    first.interrupt();
    const again = createAskCard(options);
    return { again, clock, sent, settle: (result: SendResult) => settle(result) };
  }
  const seoulSettled = {
    kind: "settled",
    settled: {
      kind: "answered",
      line: "Which city?",
      bubble: { kind: "single", value: { kind: "text", text: "Seoul" } },
    },
  };

  it("shows the answer on its way and sends nothing more", () => {
    const { again, clock, sent } = inflight();
    again.tap(berlin);
    clock.advance(650);
    again.openOther();
    again.typeOther("Lisbon");
    again.confirm();
    expect({ view: again.view(), sent }).toEqual({ view: seoulSettled, sent: ["choice-2"] });
  });

  it("keeps the answer after it lands, until the thread shows it", async () => {
    const { again, settle } = inflight();
    settle({ ok: true });
    await flush();
    expect(again.view()).toEqual(seoulSettled);
  });

  it("reopens on the selection with the error when it fails", async () => {
    const { again, settle } = inflight();
    settle({ ok: false, message: "Run is busy" });
    await flush();
    expect(again.view()).toMatchObject({
      kind: "open",
      step: { selected: [seoul] },
      busy: false,
      error: "Run is busy",
    });
  });
});

describe("commit", () => {
  it("settles on the answer the server will store", async () => {
    const { card: subject, clock } = card(cities);
    subject.tap(seoul);
    clock.advance(650);
    await flush();
    expect(subject.view()).toEqual({
      kind: "settled",
      settled: {
        kind: "answered",
        line: "Which city?",
        bubble: { kind: "single", value: { kind: "text", text: "Seoul" } },
      },
    });
  });

  it("reopens on the selection with the error after a failed answer, without sending again (CA4)", async () => {
    const {
      card: subject,
      clock,
      sent,
    } = card(cities, { result: { ok: false, message: "Run is busy" } });
    subject.tap(seoul);
    clock.advance(650);
    await flush();
    clock.advance(5000);
    expect(sent).toEqual(["choice-2"]);
    expect(subject.view()).toMatchObject({
      kind: "open",
      step: { selected: [seoul] },
      busy: false,
      filled: null,
      error: "Run is busy",
    });
  });

  it("drops a settle the presenter has not applied yet when the answer fails, and says so", async () => {
    const applies: (() => boolean)[] = [];
    const { card: subject, clock } = card(cities, {
      result: { ok: false, message: "Run is busy" },
      present: (_change, apply) => applies.push(apply),
    });
    subject.tap(seoul);
    clock.advance(650);
    expect(subject.view()).toMatchObject({
      kind: "open",
      busy: true,
      filled: { kind: "option", optionId: seoul },
    });
    await flush();
    expect(applies.map((apply) => apply())).toEqual([false]);
    expect(subject.view()).toMatchObject({ kind: "open", busy: false, error: "Run is busy" });
  });
});

describe("an answered event during the fill", () => {
  it("keeps the filled tile until the presenter settles, then shows the same answer", async () => {
    const applies: (() => void)[] = [];
    const { card: subject, clock } = card(cities, {
      present: (_change, apply) => applies.push(apply),
    });
    const form = askFormOf(cities)!;
    const answered: AskBlock = { ...cities, status: "answered", answer: "choice-2" };
    subject.tap(seoul);
    clock.advance(650);
    await flush();
    const filling = resolveAskCardView(answered, form, subject.view(), true);
    for (const apply of applies) apply();
    expect({
      filling: filling.kind === "open" && filling.filled,
      settled: resolveAskCardView(answered, form, subject.view(), true),
    }).toEqual({
      filling: { kind: "option", optionId: seoul },
      settled: {
        kind: "settled",
        settled: {
          kind: "answered",
          line: "Which city?",
          bubble: { kind: "single", value: { kind: "text", text: "Seoul" } },
        },
      },
    });
  });
});

describe("typed answers", () => {
  it("sends a legacy free-text card's typed text, never approved (CA9)", async () => {
    const { card: subject, sent } = card({ kind: "ask", text: "Which city?" });
    expect(subject.view()).toMatchObject({ step: { field: { text: "", canSend: false } } });
    subject.typeOther("  Paris ");
    subject.confirm();
    expect(sent).toEqual(["Paris"]);
  });

  it("sends Other on a single choice as the question's other (CA8)", () => {
    const { card: subject, sent } = card({
      kind: "ask",
      text: "",
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
    });
    subject.tap("q1o1" as OptionId);
    subject.openOther();
    subject.typeOther("Lisbon");
    subject.confirm();
    expect(sent.map((wire) => JSON.parse(wire))).toEqual([
      { answers: { q1: { other: "Lisbon" } } },
    ]);
  });

  it("keeps a typed answer to 2,000 characters", () => {
    const { card: subject } = card({ kind: "ask", text: "Why?" });
    subject.typeOther("x".repeat(2500));
    expect(subject.view()).toMatchObject({ step: { field: { text: "x".repeat(2000) } } });
  });
});

describe("multi-select and skip", () => {
  const block: AskBlock = {
    kind: "ask",
    text: "",
    questions: [
      {
        id: "q1",
        question: "Which cities?",
        multiSelect: true,
        required: false,
        options: [
          { id: "q1o1", label: "Berlin" },
          { id: "q1o2", label: "Seoul" },
        ],
      },
    ],
  };

  it("toggles without a hold and sends the checked options with Other (CA10)", () => {
    const { card: subject, clock, sent } = card(block);
    expect(subject.view()).toMatchObject({ send: false });
    subject.tap("q1o1" as OptionId);
    subject.tap("q1o2" as OptionId);
    subject.tap("q1o1" as OptionId);
    clock.advance(5000);
    expect(sent).toEqual([]);
    expect(subject.view()).toMatchObject({ send: true, step: { selected: ["q1o2"] } });
    subject.openOther();
    subject.typeOther("Lisbon");
    subject.confirm();
    expect(sent.map((wire) => JSON.parse(wire))).toEqual([
      { answers: { q1: { selected: ["q1o2"], other: "Lisbon" } } },
    ]);
  });

  it("skips an optional question, never a required one (CA7)", () => {
    const optional = card(block);
    optional.card.skip();
    expect(optional.sent.map((wire) => JSON.parse(wire))).toEqual([
      { answers: { q1: { skipped: true } } },
    ]);
    const required = card(cities);
    required.card.skip();
    expect(required.sent).toEqual([]);
  });
});
