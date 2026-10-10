import type {
  EntryId,
  MessageBlock,
  SessionEntry,
  SessionEntryOf,
  SessionEntryType,
} from "@rakazo/contracts";
import { appendToolCallSegment } from "../events.js";

type FoldedEntry = SessionEntryOf<
  | "assistant.text"
  | "assistant.reasoning"
  | "assistant.ask"
  | "assistant.choice"
  | "tool.call"
  | "tool.result"
>;

const STRETCH_TYPES = new Set<SessionEntryType>([
  "assistant.text",
  "assistant.reasoning",
  "assistant.ask",
  "assistant.choice",
  "tool.call",
  "tool.result",
  "subagent",
]);

type RunMessage = {
  type: "run.message";
  id: EntryId;
  ts: string;
  runId: string;
  botId: string;
  blocks: MessageBlock[];
};

/**
 * Fold a run's `assistant.*` and `tool.*` entries into one `RunMessage` per contiguous stretch, at
 * the position of the stretch's first entry. Any other entry, or an entry of another run, closes
 * the open stretch, and the run's next such entry opens a new one; a `subagent` entry of the same
 * run passes through without closing it. A tool call takes its output from the `tool.result` or
 * `subagent` entry with the same run and `callId`, or an empty output while none exists yet.
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
  let open: RunMessage | undefined;
  const stretchOf = (entry: FoldedEntry) => {
    if (open) return open;
    open = {
      type: "run.message",
      id: entry.id,
      ts: entry.ts,
      runId: entry.runId,
      botId: entry.botId,
      blocks: [],
    };
    segments.push(open);
    return open;
  };
  for (const entry of entries) {
    if (entry.runId !== open?.runId || !STRETCH_TYPES.has(entry.type)) open = undefined;
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

/** Providers reuse call ids such as `call_0` from one run to the next, so a call is its run's. */
export function toolCallKey(entry: SessionEntryOf<"tool.call" | "tool.result" | "subagent">) {
  return JSON.stringify([entry.runId, entry.payload.callId]);
}
