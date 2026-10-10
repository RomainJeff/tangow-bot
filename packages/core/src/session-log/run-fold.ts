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
 * interleave keep one message each. Any other entry closes every open stretch, and a `subagent`
 * entry passes through without closing them. A tool call takes its output from the `tool.result`
 * or `subagent` entry with the same run and `callId`, or an empty output while none exists yet.
 */
export function foldRuns(
  entries: readonly SessionEntry[],
): (RunMessage | Exclude<SessionEntry, FoldedEntry>)[] {
  const outputs = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === "tool.result") outputs.set(toolCallKey(entry), entry.payload.output);
    if (entry.type === "subagent") outputs.set(toolCallKey(entry), entry.payload.result);
  }
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
          output: outputs.get(toolCallKey(entry)) ?? "",
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

/** Providers reuse call ids such as `call_0` from run to run, so a call pairs within its run. */
export function toolCallKey(entry: SessionEntryOf<"tool.call" | "tool.result" | "subagent">) {
  return JSON.stringify([entry.runId, entry.payload.callId]);
}
