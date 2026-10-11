import type {
  EntryId,
  MessageBlock,
  SessionEntry,
  SessionEntryOf,
  SessionEntryType,
  SessionId,
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
type FoldedEntry = SessionEntryOf<(typeof FOLDED_TYPES)[number]>;
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

export function foldRuns(
  entries: readonly SessionEntry[],
  outputs: ReadonlyMap<EntryId, string> = toolOutputs(entries),
): (RunMessage | Exclude<SessionEntry, FoldedEntry>)[] {
  const segments: (RunMessage | Exclude<SessionEntry, FoldedEntry>)[] = [];
  const open = new Map<string, RunMessage>();
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
      case "assistant.text":
        stretchOf(entry).blocks.push(...entry.payload.blocks);
        break;
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
        message.blocks = appendToolCallSegment(message.blocks, name, {
          name,
          input,
          output: outputs.get(entry.id) ?? "",
          id: callId,
        });
        break;
      }
      case "tool.result":
        open.get(entry.runId)?.entries.push(entry);
        break;
      default:
        segments.push(entry);
    }
  }
  return segments;
}

/**
 * Each tool call's output by the call's entry id. Providers reuse call ids such as `call_0`, from
 * run to run and within a run once it resumes, so a `tool.result` or `subagent` entry answers the
 * latest earlier call of its run and call id that has no answer yet. A call a crash cut stays
 * unanswered under the replay that follows it, and a result whose call a compaction cut answers
 * nothing.
 */
export function toolOutputs(entries: readonly SessionEntry[]): Map<EntryId, string> {
  const unanswered = new Map<string, EntryId[]>();
  const outputs = new Map<EntryId, string>();
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
    outputs.set(call, entry.type === "tool.result" ? entry.payload.output : entry.payload.result);
  }
  return outputs;
}

function toolCallKey(entry: SessionEntryOf<"tool.call" | "tool.result" | "subagent">) {
  return JSON.stringify([entry.runId, entry.payload.callId]);
}
