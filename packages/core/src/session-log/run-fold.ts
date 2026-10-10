import type { EntryId, MessageBlock, SessionEntry, SessionEntryOf } from "@rakazo/contracts";
import { appendToolCallSegment } from "../events.js";

type FoldedEntry = SessionEntryOf<
  | "assistant.text"
  | "assistant.reasoning"
  | "assistant.ask"
  | "assistant.choice"
  | "tool.call"
  | "tool.result"
>;

export type RunMessage = {
  type: "run.message";
  id: EntryId;
  ts: string;
  runId: string;
  botId: string;
  blocks: MessageBlock[];
};

/**
 * Fold each run's `assistant.*` and `tool.*` entries into one `RunMessage` keyed by `runId`, at
 * the position of the run's first such entry. A tool call takes its output from the `tool.result`
 * or `subagent` entry with the same `callId`, or an empty output while none exists yet. Every
 * other entry passes through in order.
 */
export function foldRuns(
  entries: readonly SessionEntry[],
): (RunMessage | Exclude<SessionEntry, FoldedEntry>)[] {
  const outputs = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === "tool.result") outputs.set(entry.payload.callId, entry.payload.output);
    if (entry.type === "subagent") outputs.set(entry.payload.callId, entry.payload.result);
  }
  const messages = new Map<string, RunMessage>();
  const segments: (RunMessage | Exclude<SessionEntry, FoldedEntry>)[] = [];
  const messageOf = (entry: FoldedEntry) => {
    const open = messages.get(entry.runId);
    if (open) return open;
    const message: RunMessage = {
      type: "run.message",
      id: entry.id,
      ts: entry.ts,
      runId: entry.runId,
      botId: entry.botId,
      blocks: [],
    };
    messages.set(entry.runId, message);
    segments.push(message);
    return message;
  };
  for (const entry of entries) {
    switch (entry.type) {
      case "assistant.text":
        messageOf(entry).blocks.push(...entry.payload.blocks);
        break;
      case "assistant.reasoning":
        messageOf(entry).blocks.push({ kind: "reasoning", text: entry.payload.text });
        break;
      case "assistant.ask":
      case "assistant.choice":
        messageOf(entry).blocks.push(entry.payload.block);
        break;
      case "tool.call": {
        const message = messageOf(entry);
        const { callId, name, input } = entry.payload;
        message.blocks = appendToolCallSegment(message.blocks, name, {
          name,
          input,
          output: outputs.get(callId) ?? "",
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
