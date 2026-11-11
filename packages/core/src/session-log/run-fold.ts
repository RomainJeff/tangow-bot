import type {
  EntryId,
  MessageBlock,
  SessionEntryType,
  SessionId,
  ThreadEntry,
  ThreadEntryOf,
} from "@tangow/contracts";
import { CARD_STATE_TYPES, isHelperPauseResult, pausedOutput } from "@tangow/contracts";
import { appendToolCallSegment } from "../events.js";
import { originSessionIdOf } from "./child-sessions.js";

const FOLDED_TYPES = [
  "assistant.text",
  "assistant.reasoning",
  "assistant.ask",
  "assistant.choice",
  "tool.call",
  "tool.result",
] as const;
type FoldedEntry = ThreadEntryOf<(typeof FOLDED_TYPES)[number]>;
export type ToolAnswer = ThreadEntryOf<"tool.result" | "subagent">;
export type ToolAnswers = {
  answerOf: ReadonlyMap<EntryId, ToolAnswer>;
  callOf: ReadonlyMap<EntryId, EntryId>;
  /** The answer a later result replaced, by the call's entry id: a pause, or a helper's stop. */
  replacedOf: ReadonlyMap<EntryId, ToolAnswer>;
};
const STRETCH_TYPES = new Set<SessionEntryType>([...FOLDED_TYPES, ...CARD_STATE_TYPES, "subagent"]);

type RunMessage = {
  type: "run.message";
  id: EntryId;
  ts: string;
  runId: string;
  botId: string;
  blocks: MessageBlock[];
  entries: FoldedEntry[];
  cards: Map<EntryId, number>;
  /** The child session the stretch rose from: a run writes to one session, so all of it did. */
  originSessionId?: SessionId;
};

/**
 * Fold a run's `assistant.*` and `tool.*` entries into one `RunMessage` per stretch, at the
 * position of the stretch's first entry. Each run has its own open stretch, so runs that
 * interleave keep one message each. Any other entry closes every open stretch, a `bot.text` too
 * since it is a message of its own; a `subagent` entry and the card-state entries pass through.
 * With `splitAtPersonMessages`, each published message keeps its own bubble in the thread.
 */
export function foldRuns(
  entries: readonly ThreadEntry[],
  {
    answers = toolAnswers(entries),
    splitAtPersonMessages = false,
  }: { answers?: ToolAnswers; splitAtPersonMessages?: boolean } = {},
): (RunMessage | Exclude<ThreadEntry, FoldedEntry>)[] {
  const segments: (RunMessage | Exclude<ThreadEntry, FoldedEntry>)[] = [];
  const open = new Map<string, RunMessage>();
  const holderOf = new Map<EntryId, RunMessage>();
  const stretchOf = (entry: FoldedEntry) => {
    const stretch = open.get(entry.runId);
    if (stretch) {
      stretch.entries.push(entry);
      return stretch;
    }
    const originSessionId = originSessionIdOf(entry);
    const message: RunMessage = {
      type: "run.message",
      id: entry.id,
      ts: entry.ts,
      runId: entry.runId,
      botId: entry.botId,
      blocks: [],
      entries: [entry],
      cards: new Map(),
      ...(originSessionId ? { originSessionId } : {}),
    };
    open.set(entry.runId, message);
    segments.push(message);
    return message;
  };
  for (const entry of entries) {
    if (!STRETCH_TYPES.has(entry.type)) open.clear();
    switch (entry.type) {
      case "assistant.text": {
        const separate = splitAtPersonMessages && entry.payload.toPerson;
        if (separate) open.delete(entry.runId);
        stretchOf(entry).blocks.push(...entry.payload.blocks);
        if (separate) open.delete(entry.runId);
        break;
      }
      case "assistant.reasoning":
        stretchOf(entry).blocks.push({ kind: "reasoning", text: entry.payload.text });
        break;
      case "assistant.ask":
      case "assistant.choice": {
        const message = stretchOf(entry);
        message.cards.set(entry.id, message.blocks.length);
        message.blocks.push(entry.payload.block);
        break;
      }
      case "tool.call": {
        const message = stretchOf(entry);
        const { callId, name, input } = entry.payload;
        const answer = answers.answerOf.get(entry.id);
        // A draft's outcome may have replaced a helper's answer: the step still opens its session.
        const helperSession = (answers.replacedOf.get(entry.id) ?? answer)?.payload.sessionId;
        message.blocks = appendToolCallSegment(message.blocks, name, {
          name,
          input,
          output: answer ? outputOf(answer) : "",
          id: callId,
          ...(answer?.type === "tool.result" && answer.payload.replaces ? { outcome: true } : {}),
          ...(helperSession ? { sessionId: helperSession } : {}),
        });
        holderOf.set(entry.id, message);
        break;
      }
      case "tool.result": {
        const call = answers.callOf.get(entry.id);
        const holder = call === undefined ? undefined : holderOf.get(call);
        (holder ?? open.get(entry.runId))?.entries.push(entry);
        break;
      }
      default:
        segments.push(entry);
    }
  }
  return segments;
}

/**
 * Each tool call's answer by the call's entry id, and each answer's call by its own. Providers reuse call ids such as `call_0`, from
 * run to run and within a run once it resumes, so a `tool.result` or `subagent` entry answers the
 * latest earlier call of its run and call id that has no answer yet. A call a crash cut stays
 * unanswered under the replay that follows it, and a result whose call a compaction cut answers
 * nothing. A result that names the pause it replaces answers the call that pause answered, never
 * another call of the same id; with that pause cut, it answers nothing.
 */
export function toolAnswers(entries: readonly ThreadEntry[]): ToolAnswers {
  const unanswered = new Map<string, EntryId[]>();
  const answerOf = new Map<EntryId, ToolAnswer>();
  const callOf = new Map<EntryId, EntryId>();
  const replacedOf = new Map<EntryId, ToolAnswer>();
  for (const entry of entries) {
    if (entry.type !== "tool.call" && entry.type !== "tool.result" && entry.type !== "subagent") {
      continue;
    }
    const key = toolCallKey(entry);
    const calls = unanswered.get(key) ?? [];
    unanswered.set(key, calls);
    if (entry.type === "tool.call") {
      calls.push(entry.id);
      continue;
    }
    const replaced = entry.type === "tool.result" ? entry.payload.replaces : undefined;
    const call = replaced === undefined ? calls.pop() : callOf.get(replaced);
    if (call === undefined) continue;
    const replacedAnswer = replaced === undefined ? undefined : answerOf.get(call);
    if (replacedAnswer) replacedOf.set(call, replacedAnswer);
    answerOf.set(call, entry);
    callOf.set(entry.id, call);
  }
  return { answerOf, callOf, replacedOf };
}

/**
 * The pause that answered the call a draft card raised, while it still does, or undefined once a
 * result replaced it. The pause is the first one after the card: the call's own `paused` result,
 * written in the transaction that first shows the card, or, when a helper raised the card, the
 * helper's answer to the `run_subagent` call that started it, which reads that it waits on a card.
 * That answer is written once the helper closes, which can be after the user answered the card:
 * the close then logs the outcome itself.
 * Two helpers stopped by one pause cannot be told apart, so the first one has it.
 */
export function pendingPauseOfEffect(
  entries: readonly ThreadEntry[],
  effectId: string,
): { callId: string; pauseId: EntryId } | undefined {
  const found = pauseOfEffect(entries, effectId);
  return found && found.answer?.id === found.pause.id
    ? { callId: found.pause.payload.callId, pauseId: found.pause.id }
    : undefined;
}

/** Whether a result replaced the pause a draft card raised: the card's outcome is in `entries`. */
export function hasDraftOutcome(entries: readonly ThreadEntry[], effectId: string): boolean {
  const found = pauseOfEffect(entries, effectId);
  return found?.answer?.type === "tool.result" && found.answer.payload.replaces === found.pause.id;
}

function pauseOfEffect(entries: readonly ThreadEntry[], effectId: string) {
  const start = entries.findIndex(
    (entry) => entry.type === "effect.requested" && entry.payload.effectId === effectId,
  );
  if (start < 0) return undefined;
  const { answerOf, callOf } = toolAnswers(entries);
  for (const entry of entries.slice(start + 1)) {
    if (entry.type === "effect.requested") return undefined;
    const pause =
      (entry.type === "tool.result" && entry.payload.output === pausedOutput("approval")) ||
      (entry.type === "subagent" && isHelperPauseResult(entry.payload.result));
    if (!pause || (entry.type !== "tool.result" && entry.type !== "subagent")) continue;
    const call = callOf.get(entry.id);
    return { pause: entry, answer: call === undefined ? undefined : answerOf.get(call) };
  }
  return undefined;
}

function outputOf(answer: ToolAnswer): string {
  return answer.type === "tool.result" ? answer.payload.output : answer.payload.result;
}

function toolCallKey(entry: ThreadEntryOf<"tool.call" | "tool.result" | "subagent">) {
  return JSON.stringify([entry.runId, entry.payload.callId]);
}
