import type {
  EntryId,
  MessageBlock,
  SessionEntryType,
  SessionId,
  ThreadEntry,
  ThreadEntryOf,
} from "@rakazo/contracts";
import { CARD_STATE_TYPES } from "@rakazo/contracts";
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
        message.blocks = appendToolCallSegment(message.blocks, name, {
          name,
          input,
          output: answer ? outputOf(answer) : "",
          id: callId,
          ...(answer?.type === "subagent" && answer.payload.sessionId
            ? { sessionId: answer.payload.sessionId }
            : {}),
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
 * nothing.
 */
export function toolAnswers(entries: readonly ThreadEntry[]): ToolAnswers {
  const unanswered = new Map<string, EntryId[]>();
  const answerOf = new Map<EntryId, ToolAnswer>();
  const callOf = new Map<EntryId, EntryId>();
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
    const call = calls.pop();
    if (call === undefined) continue;
    answerOf.set(call, entry);
    callOf.set(entry.id, call);
  }
  return { answerOf, callOf };
}

function outputOf(answer: ToolAnswer): string {
  return answer.type === "tool.result" ? answer.payload.output : answer.payload.result;
}

function toolCallKey(entry: ThreadEntryOf<"tool.call" | "tool.result" | "subagent">) {
  return JSON.stringify([entry.runId, entry.payload.callId]);
}
