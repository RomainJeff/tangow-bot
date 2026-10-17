import { ASK_ANSWER_MAX_LENGTH } from "@rakazo/contracts";
import type {
  AskCardBlock,
  AskForm,
  AskResponse,
  FormQuestion,
  OptionId,
  QuestionId,
  StoredAnswer,
} from "./form.js";
import { answerOf, encodeAnswer, storedAnswerOf } from "./form.js";
import type { AnswerValue, AskSettledView } from "./settled.js";
import { answerValue, askSettledOf, labelOf } from "./settled.js";

/** How long a single choice stays selected before it is sent. */
export const ASK_SEND_HOLD_MS = 650;
/** How long a single choice stays selected before a stack moves to its next question. */
export const ASK_STEP_HOLD_MS = 550;

export type Clock = {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const timers: Clock = {
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Where the answer leaves from: the tile or field a shell fills before settling. */
export type CommitSource =
  | { kind: "option"; optionId: OptionId }
  | { kind: "field" }
  | { kind: "button" };

/** The card says which change happens; the presenter calls `apply` once, when its motion allows. */
export type ViewChange =
  | { kind: "settle"; from: CommitSource }
  | { kind: "advance" }
  | { kind: "reopen" };
/** `apply` returns false when the change went stale meanwhile, so what was measured for it is dropped. */
export type Presenter = (change: ViewChange, apply: () => boolean) => void;

export type SendResult = { ok: true } | { ok: false; message: string };

export type QuestionStep = {
  question: FormQuestion;
  /** In a stack, how many questions are still unseen besides this one; null on a one-question card. */
  left: number | null;
  /** Opened again from its line: already seen, so never the last one. */
  reopened: boolean;
  selected: readonly OptionId[];
  /** Null while closed; open from the start on a free-text question. */
  field: { text: string; canSend: boolean } | null;
  skip: boolean;
};

/** An answered or skipped question of a stack, folded into a line above the current one. */
export type StackLine = { questionId: QuestionId; label: string; value: AnswerValue };

export type OpenView = {
  kind: "open";
  lines: readonly StackLine[];
  /** Null on a stack's recap, once every question has been answered or skipped. */
  step: QuestionStep | null;
  /** The action at the bottom right: a multi-select's Next or Send, the recap's Send. */
  primary: "next" | "send" | null;
  busy: boolean;
  filled: CommitSource | null;
  error: string | null;
};

export type AskCardView = OpenView | { kind: "settled"; settled: AskSettledView };

export type AskCardIntents = {
  /** Single choice: select and (re)start the hold; the tile already holding does nothing. */
  tap(optionId: OptionId): void;
  openOther(): void;
  typeOther(text: string): void;
  /** The field's button, or the primary action. */
  confirm(): void;
  skip(): void;
  /** Opens an answered question of a stack again, to change its answer. */
  reopen(questionId: QuestionId): void;
  /** Background, unmount, thread change: cancels the hold and keeps the draft. */
  interrupt(): void;
};

export type AskCard = AskCardIntents & {
  view(): AskCardView;
  subscribe(listener: () => void): () => void;
  setWaiting(waiting: boolean): void;
};

export type AskCardOptions = {
  form: AskForm;
  /** The ask message id, which keys the draft for the session. */
  key: string;
  waiting: boolean;
  send: (wire: string) => Promise<SendResult>;
  present?: Presenter;
  clock?: Clock;
};

type Selection = { picked: readonly OptionId[]; other: string | null };

/** A stack's answers so far, the question reopened from its line, and the current selection. */
type Draft = {
  responses: ReadonlyMap<QuestionId, AskResponse>;
  reopened: QuestionId | null;
  selection: Selection;
};

type Cursor = Pick<Draft, "responses" | "reopened">;

type Phase =
  | { kind: "idle"; error: string | null }
  | { kind: "holding"; optionId: OptionId; handle: unknown }
  /** A stack moving to another question, shown once the presenter applies it. */
  | { kind: "moving"; generation: number }
  | {
      kind: "committing";
      generation: number;
      source: CommitSource;
      stored: StoredAnswer;
      shown: boolean;
    };

type Inflight = { source: CommitSource; stored: StoredAnswer; result: Promise<SendResult> };

const drafts = new Map<string, Draft>();
/** Outlives the card: mounted again mid-send, or before the thread shows the accepted answer, it shows that answer instead of taking another. */
const inflight = new Map<string, Inflight>();
const IDLE: Phase = { kind: "idle", error: null };

function selectionOf(question: FormQuestion | undefined, response?: AskResponse): Selection {
  if (response?.kind === "options") return { picked: response.ids, other: response.other };
  if (response?.kind === "text") return { picked: [], other: response.text };
  return { picked: [], other: question && !question.options.length ? "" : null };
}

function responseOf(question: FormQuestion, { picked, other }: Selection): AskResponse | null {
  const text = other?.trim() ?? "";
  const [first, ...rest] = picked;
  if (question.multiSelect && first) {
    return { kind: "options", ids: [first, ...rest], other: text || null };
  }
  return text ? { kind: "text", text } : null;
}

export function createAskCard({
  form,
  key,
  waiting,
  send,
  present = (_change, apply) => apply(),
  clock = timers,
}: AskCardOptions): AskCard {
  const stack = form.questions.length > 1;
  const currentOf = (of: Cursor) =>
    of.reopened
      ? form.questions.find((question) => question.id === of.reopened)
      : form.questions.find((question) => !of.responses.has(question.id));
  const unseenAfter = (of: Cursor, current: FormQuestion | undefined) =>
    form.questions.filter((question) => question !== current && !of.responses.has(question.id))
      .length;
  /** A multi-select's Send: the stack's last unseen question, or a one-question card. */
  const sendsFrom = (of: Cursor, question: FormQuestion) =>
    !stack || (question.multiSelect && !of.reopened && unseenAfter(of, question) === 0);

  let draft: Draft = drafts.get(key) ?? {
    responses: new Map(),
    reopened: null,
    selection: selectionOf(form.questions[0]),
  };
  let phase: Phase = IDLE;
  let generation = 0;
  const sending = inflight.get(key);
  if (sending) {
    phase = { kind: "committing", generation: ++generation, ...sending, shown: true };
    follow(phase.generation, sending.result);
  }
  let live = waiting;
  const listeners = new Set<() => void>();

  function viewOf(): AskCardView {
    if (phase.kind === "committing" && phase.shown) {
      return { kind: "settled", settled: askSettledOf(form, phase.stored) };
    }
    const question = currentOf(draft);
    const { picked, other } = draft.selection;
    const typed = Boolean(other?.trim());
    const lines = form.questions.flatMap((line) => {
      const response = draft.responses.get(line.id);
      if (line === question || !response) return [];
      return [
        { questionId: line.id, label: labelOf(line), value: answerValue(line, answerOf(response)) },
      ];
    });
    const step = question && {
      question,
      left: stack ? unseenAfter(draft, question) : null,
      selected: picked,
      field: other === null ? null : { text: other, canSend: typed },
      skip: !question.required,
      reopened: draft.reopened !== null,
    };
    return {
      kind: "open",
      lines,
      step: step ?? null,
      primary: !question
        ? "send"
        : question.multiSelect && (picked.length > 0 || typed)
          ? sendsFrom(draft, question)
            ? "send"
            : "next"
          : null,
      busy: phase.kind === "committing",
      filled: phase.kind === "committing" ? phase.source : null,
      error: phase.kind === "idle" ? phase.error : null,
    };
  }
  let view = viewOf();

  /** Every change goes through here, so leaving a hold always clears its timer. */
  function update(next: Phase, nextDraft = draft, publish = true) {
    if (phase.kind === "holding" && next !== phase) clock.clearTimeout(phase.handle);
    phase = next;
    if (nextDraft !== draft) drafts.set(key, nextDraft);
    draft = nextDraft;
    if (!publish) return;
    view = viewOf();
    for (const listener of listeners) listener();
  }

  const accepting = () => live && (phase.kind === "idle" || phase.kind === "holding");
  const current = (gen: number) => phase.kind === "committing" && phase.generation === gen;

  function commit(responses: ReadonlyMap<QuestionId, AskResponse>, source: CommitSource) {
    const { wire, stored } = encodeAnswer(form, responses);
    const gen = ++generation;
    update({ kind: "committing", generation: gen, source, stored, shown: false });
    present({ kind: "settle", from: source }, () => {
      if (phase.kind !== "committing" || !current(gen)) return false;
      update({ ...phase, shown: true });
      return true;
    });
    const entry = { source, stored, result: send(wire) };
    inflight.set(key, entry);
    void entry.result.then((result) => {
      if (!result.ok && inflight.get(key) === entry) inflight.delete(key);
    });
    follow(gen, entry.result);
  }

  function follow(gen: number, result: Promise<SendResult>) {
    void result.then((outcome) => {
      if (phase.kind !== "committing" || !current(gen)) return;
      if (outcome.ok) {
        drafts.delete(key);
        return;
      }
      const reopen = () => {
        if (!current(gen)) return false;
        update({ kind: "idle", error: outcome.message });
        return true;
      };
      if (phase.shown) present({ kind: "reopen" }, reopen);
      else reopen();
    });
  }

  /** The draft changes now; the view follows when the presenter applies the move. */
  function move(next: Cursor) {
    const question = currentOf(next);
    const selection = selectionOf(question, question && next.responses.get(question.id));
    const gen = ++generation;
    update({ kind: "moving", generation: gen }, { ...next, selection }, false);
    present({ kind: "advance" }, () => {
      if (phase.kind !== "moving" || phase.generation !== gen) return false;
      update(IDLE);
      return true;
    });
  }

  function answer(
    question: FormQuestion,
    response: AskResponse,
    source: CommitSource,
    sends: boolean,
  ) {
    const responses = new Map(draft.responses).set(question.id, response);
    if (sends) commit(stack ? responses : new Map([[question.id, response]]), source);
    else move({ responses, reopened: null });
  }

  function fire() {
    const [optionId] = draft.selection.picked;
    const question = currentOf(draft);
    if (phase.kind === "holding" && optionId && question) {
      const response: AskResponse = { kind: "options", ids: [optionId], other: null };
      answer(question, response, { kind: "option", optionId }, !stack);
    }
  }

  function interrupt() {
    if (phase.kind === "holding") update(IDLE);
  }

  const asking = () => (accepting() ? currentOf(draft) : undefined);

  return {
    tap(optionId) {
      const question = asking();
      if (!question) return;
      const { selection } = draft;
      if (question.multiSelect) {
        const picked = selection.picked.includes(optionId)
          ? selection.picked.filter((id) => id !== optionId)
          : [...selection.picked, optionId];
        return update(IDLE, { ...draft, selection: { ...selection, picked } });
      }
      if (phase.kind === "holding" && phase.optionId === optionId) return;
      const handle = clock.setTimeout(fire, stack ? ASK_STEP_HOLD_MS : ASK_SEND_HOLD_MS);
      update(
        { kind: "holding", optionId, handle },
        { ...draft, selection: { picked: [optionId], other: null } },
      );
    },
    openOther() {
      const question = asking();
      if (!question) return;
      const { picked, other } = draft.selection;
      update(IDLE, {
        ...draft,
        selection: { picked: question.multiSelect ? picked : [], other: other ?? "" },
      });
    },
    typeOther(text) {
      if (!asking()) return;
      const selection = { ...draft.selection, other: text.slice(0, ASK_ANSWER_MAX_LENGTH) };
      update(IDLE, { ...draft, selection });
    },
    confirm() {
      if (!accepting()) return;
      const question = currentOf(draft);
      if (!question) return commit(draft.responses, { kind: "button" });
      const response = responseOf(question, draft.selection);
      if (!response) return;
      const source: CommitSource =
        response.kind === "text" ? { kind: "field" } : { kind: "button" };
      answer(question, response, source, sendsFrom(draft, question));
    },
    skip() {
      const question = asking();
      if (question && !question.required) {
        answer(question, { kind: "skipped" }, { kind: "button" }, !stack);
      }
    },
    reopen(questionId) {
      if (accepting() && draft.responses.has(questionId)) {
        move({ responses: draft.responses, reopened: questionId });
      }
    },
    interrupt,
    setWaiting(next) {
      live = next;
      if (!next) interrupt();
    },
    view: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The block wins once answered, so a late real-time event or a reload shows what the commit showed. */
export function resolveAskCardView(
  block: AskCardBlock,
  form: AskForm,
  view: AskCardView,
  waiting: boolean,
): AskCardView {
  // While its own answer fills, the card waits for its presenter, so an early event cuts nothing short.
  if (block.status === "answered" && !(view.kind === "open" && view.busy)) {
    return { kind: "settled", settled: askSettledOf(form, storedAnswerOf(form, block)) };
  }
  if (waiting || view.kind === "settled" || view.busy) return view;
  return { kind: "settled", settled: askSettledOf(form, null) };
}
