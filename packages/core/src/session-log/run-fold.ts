import type {
  EntryId,
  MessageBlock,
  SessionEntry,
  SessionEntryOf,
  SessionEntryType,
} from "@rakazo/contracts";
import { appendToolCallSegment } from "../events.js";

const FOLDED_TYPES = [
  "assistant.text",
  "assistant.reasoning",
  "assistant.ask",
  "assistant.choice",
  "tool.call",
  "tool.result",
] as const;
type FoldedEntry = SessionEntryOf<(typeof FOLDED_TYPES)[number]>;
const STRETCH_TYPES = new Set<SessionEntryType>([...FOLDED_TYPES, "subagent"]);

type RunMessage = {
  type: "run.message";
  id: EntryId;
  ts: string;
  runId: string;
  botId: string;
  blocks: MessageBlock[];
};

/**
 * Fold a run's `assistant.*` and `tool.*` entries into one `RunMessage` per stretch, at the
 * position of the stretch's first entry. Each run has its own open stretch, so runs that
 * interleave keep one message each. Any other entry closes every open stretch, a `bot.text` too
 * since it is a message of its own, and a `subagent` entry passes through without closing them.
 * A tool call takes its output from `toolOutputs`, or an empty output while it has none yet.
 */
export function foldRuns(
  entries: readonly SessionEntry[],
): (RunMessage | Exclude<SessionEntry, FoldedEntry>)[] {
  const outputs = toolOutputs(entries);
  const segments: (RunMessage | Exclude<SessionEntry, FoldedEntry>)[] = [];
  const open = new Map<string, RunMessage>();
  const stretchOf = (entry: FoldedEntry) => {
    const stretch = open.get(entry.runId);
    if (stretch) return stretch;
    const message: RunMessage = {
      type: "run.message",
      id: entry.id,
      ts: entry.ts,
      runId: entry.runId,
      botId: entry.botId,
      blocks: [],
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
      case "assistant.choice":
        stretchOf(entry).blocks.push(entry.payload.block);
        break;
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
