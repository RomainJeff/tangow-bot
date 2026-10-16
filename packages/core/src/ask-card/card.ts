import { ASK_ANSWER_MAX_LENGTH } from "@rakazo/contracts";
import {
  type AskCardBlock,
  type AskForm,
  type AskResponse,
  encodeAnswer,
  type FormQuestion,
  type OptionId,
  type StoredAnswer,
  storedAnswerOf,
} from "./form.js";
import { type AskSettledView, askSettledOf } from "./settled.js";

/** How long a single choice stays selected before it is sent. */
export const ASK_SEND_HOLD_MS = 650;

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
export type ViewChange = { kind: "settle"; from: CommitSource } | { kind: "reopen" };
export type Presenter = (change: ViewChange, apply: () => void) => void;

export type SendResult = { ok: true } | { ok: false; message: string };

export type QuestionStep = {
  question: FormQuestion;
  selected: readonly OptionId[];
  /** Null while closed; open from the start on a free-text question. */
  field: { text: string; canSend: boolean } | null;
  skip: boolean;
};

export type OpenView = {
  kind: "open";
  step: QuestionStep;
  /** A multi-select's Send, once something is picked or typed. */
  send: boolean;
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
  /** The field's send, or a multi-select's Send. */
  confirm(): void;
  skip(): void;
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

type Draft = { picked: readonly OptionId[]; other: string | null };

type Phase =
  | { kind: "idle"; error: string | null }
  | { kind: "holding"; optionId: OptionId; handle: unknown }
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

export function createAskCard({
  form,
  key,
  waiting,
  send,
  present = (_change, apply) => apply(),
  clock = timers,
}: AskCardOptions): AskCard {
  const question = form.questions[0];
  let draft: Draft = drafts.get(key) ?? {
    picked: [],
    other: question.options.length ? null : "",
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
    const typed = Boolean(draft.other?.trim());
    return {
      kind: "open",
      step: {
        question,
        selected: draft.picked,
        field: draft.other === null ? null : { text: draft.other, canSend: typed },
        skip: !question.required,
      },
      send: question.multiSelect && (draft.picked.length > 0 || typed),
      busy: phase.kind === "committing",
      filled: phase.kind === "committing" ? phase.source : null,
      error: phase.kind === "idle" ? phase.error : null,
    };
  }
  let view = viewOf();

  /** Every change goes through here, so leaving a hold always clears its timer. */
  function update(next: Phase, nextDraft = draft) {
    if (phase.kind === "holding" && next !== phase) clock.clearTimeout(phase.handle);
    phase = next;
    if (nextDraft !== draft) drafts.set(key, nextDraft);
    draft = nextDraft;
    view = viewOf();
    for (const listener of listeners) listener();
  }

  const accepting = () => live && phase.kind !== "committing";
  const current = (gen: number) => phase.kind === "committing" && phase.generation === gen;

  function commit(response: AskResponse, source: CommitSource) {
    const { wire, stored } = encodeAnswer(form, new Map([[question.id, response]]));
    const gen = ++generation;
    update({ kind: "committing", generation: gen, source, stored, shown: false });
    present({ kind: "settle", from: source }, () => {
      if (phase.kind === "committing" && current(gen)) update({ ...phase, shown: true });
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
        if (current(gen)) update({ kind: "idle", error: outcome.message });
      };
      if (phase.shown) present({ kind: "reopen" }, reopen);
      else reopen();
    });
  }

  function fire() {
    const [optionId] = draft.picked;
    if (phase.kind === "holding" && optionId) {
      commit({ kind: "options", ids: [optionId], other: null }, { kind: "option", optionId });
    }
  }

  function interrupt() {
    if (phase.kind === "holding") update(IDLE);
  }

  return {
    tap(optionId) {
      if (!accepting()) return;
      if (question.multiSelect) {
        const picked = draft.picked.includes(optionId)
          ? draft.picked.filter((id) => id !== optionId)
          : [...draft.picked, optionId];
        return update(IDLE, { ...draft, picked });
      }
      if (phase.kind === "holding" && phase.optionId === optionId) return;
      const handle = clock.setTimeout(fire, ASK_SEND_HOLD_MS);
      update({ kind: "holding", optionId, handle }, { picked: [optionId], other: null });
    },
    openOther() {
      if (!accepting()) return;
      update(IDLE, {
        picked: question.multiSelect ? draft.picked : [],
        other: draft.other ?? "",
      });
    },
    typeOther(text) {
      if (!accepting()) return;
      update(IDLE, { ...draft, other: text.slice(0, ASK_ANSWER_MAX_LENGTH) });
    },
    confirm() {
      if (!accepting()) return;
      const text = draft.other?.trim() ?? "";
      const [first, ...rest] = draft.picked;
      if (question.multiSelect && first) {
        commit({ kind: "options", ids: [first, ...rest], other: text || null }, { kind: "button" });
      } else if (text) {
        commit({ kind: "text", text }, { kind: "field" });
      }
    },
    skip() {
      if (accepting() && !question.required) commit({ kind: "skipped" }, { kind: "button" });
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
  if (block.status === "answered") {
    return { kind: "settled", settled: askSettledOf(form, storedAnswerOf(form, block)) };
  }
  if (waiting || view.kind === "settled" || view.busy) return view;
  return { kind: "settled", settled: askSettledOf(form, null) };
}
