import { createHash } from "node:crypto";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RunSnapshot } from "@tangow/adapter-kit";
import { z } from "zod";

export function callOccurrenceId(messageId: string, providerId: string) {
  return createHash("sha256")
    .update(JSON.stringify([messageId, providerId]))
    .digest("hex");
}

export const PI_SNAPSHOT_FORMAT = "pi-1.3.0/session-3";
const Entry = z.looseObject({
  type: z.enum([
    "message",
    "thinking_level_change",
    "model_change",
    "usage",
    "compaction",
    "branch_summary",
    "custom",
    "label",
    "session_info",
    "custom_message",
    "context_edit",
  ]),
  id: z.string().min(1),
  parentId: z.string().nullable(),
  timestamp: z.string(),
});
const State = z.strictObject({
  records: z
    .tuple([
      z.looseObject({
        type: z.literal("session"),
        version: z.literal(3),
        id: z.string(),
        timestamp: z.string(),
        cwd: z.string(),
      }),
    ])
    .rest(Entry),
  leaf: z.string().nullable(),
  activeTools: z.array(z.string()),
  steeringIds: z.array(z.string()),
  input: z.string(),
});

export function restorePiSnapshot(snapshot: RunSnapshot, cwd: string) {
  if (snapshot.harness.name !== "pi-native" || snapshot.harness.format !== PI_SNAPSHOT_FORMAT)
    throw new Error("Incompatible native resume format");
  const state = State.parse(JSON.parse(snapshot.state));
  const ids = new Set<string>();
  for (const entry of state.records.slice(1)) {
    if (
      ids.has(entry.id) ||
      ("parentId" in entry && entry.parentId !== null && !ids.has(String(entry.parentId)))
    )
      throw new Error("Corrupt native session tree");
    ids.add(entry.id);
    if (entry.type === "message") {
      z.looseObject({
        message: z.looseObject({
          role: z.enum([
            "system",
            "user",
            "assistant",
            "toolResult",
            "custom",
            "bashExecution",
            "compactionSummary",
            "branchSummary",
          ]),
          content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]).optional(),
        }),
      }).parse(entry);
    }
    if (
      entry.type === "message" &&
      "message" in entry &&
      typeof entry.message === "object" &&
      entry.message !== null &&
      "role" in entry.message
    ) {
      const message = entry.message;
      if (message.role === "toolResult")
        z.looseObject({
          toolCallId: z.string().min(1),
          toolName: z.string().min(1),
          content: z.array(z.looseObject({ type: z.enum(["text", "image"]) })),
          isError: z.boolean(),
          timestamp: z.number(),
        }).parse(message);
      if (message.role === "assistant")
        z.looseObject({
          content: z.array(
            z.union([
              z.looseObject({ type: z.literal("text"), text: z.string() }),
              z.looseObject({ type: z.literal("thinking"), thinking: z.string() }),
              z.looseObject({
                type: z.literal("toolCall"),
                id: z.string().min(1),
                name: z.string().min(1),
                arguments: z.record(z.string(), z.unknown()),
              }),
            ]),
          ),
          api: z.string(),
          provider: z.string(),
          model: z.string(),
          usage: z.object({
            input: z.number(),
            output: z.number(),
            cacheRead: z.number(),
            cacheWrite: z.number(),
            totalTokens: z.number(),
            cost: z.object({
              input: z.number(),
              output: z.number(),
              cacheRead: z.number(),
              cacheWrite: z.number(),
              total: z.number(),
            }),
          }),
          stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted", "deferred"]),
          timestamp: z.number(),
        }).parse(message);
    }
    if (entry.type === "thinking_level_change")
      z.looseObject({ thinkingLevel: z.string() }).parse(entry);
    if (entry.type === "model_change")
      z.looseObject({ provider: z.string(), modelId: z.string() }).parse(entry);
    if (entry.type === "branch_summary")
      z.looseObject({ fromId: z.string(), summary: z.string() }).parse(entry);
    if (entry.type === "custom") z.looseObject({ customType: z.string() }).parse(entry);
    if (entry.type === "custom_message")
      z.looseObject({
        customType: z.string(),
        content: z.union([z.string(), z.array(z.looseObject({ type: z.enum(["text", "image"]) }))]),
        display: z.boolean(),
      }).parse(entry);
    if (entry.type === "label")
      z.looseObject({ targetId: z.string(), label: z.string().optional() }).parse(entry);
    if (entry.type === "session_info") z.looseObject({ name: z.string().optional() }).parse(entry);
    if (entry.type === "context_edit")
      z.looseObject({
        targetId: z.string(),
        replacement: z
          .object({ content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]) })
          .nullable(),
      }).parse(entry);
    if (entry.type === "compaction")
      z.looseObject({
        summary: z.string(),
        firstKeptEntryId: z.string().nullable(),
        tokensBefore: z.number(),
      }).parse(entry);
  }
  if (state.leaf !== null && !ids.has(state.leaf)) throw new Error("Missing native resume branch");
  // The adapter validates native records before crossing the SDK's unvalidated FileEntry boundary.
  const manager = SessionManager.inMemory(cwd, undefined, state.records as FileEntry[]);
  if (state.leaf !== null) manager.branch(state.leaf);
  else manager.resetLeaf();
  manager.buildSessionContext();
  return {
    manager,
    activeTools: state.activeTools,
    steeringIds: state.steeringIds,
    input: state.input,
  };
}

export function capturePiSnapshot(
  manager: SessionManager,
  activeTools: string[],
  revision: number,
  steeringIds: string[],
  input: string,
  deliveredEvents: string[] = [],
  leaf = manager.getLeafId(),
  nativeTools: ReadonlySet<string> = new Set(),
): RunSnapshot {
  const entries = manager.getEntries();
  const records =
    leaf === null ? [] : entries.slice(0, entries.findIndex((entry) => entry.id === leaf) + 1);
  const pending = new Map<string, string>();
  for (const entry of leaf === null ? [] : manager.getBranch(leaf)) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      for (const block of entry.message.content) {
        if (block.type === "toolCall") pending.set(block.id, callOccurrenceId(entry.id, block.id));
      }
    } else if (entry.message.role === "toolResult") pending.delete(entry.message.toolCallId);
  }
  for (const entry of entries.slice(records.length)) {
    if (
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      !nativeTools.has(entry.message.toolName)
    )
      continue;
    records.push({ ...entry, parentId: leaf });
    leaf = entry.id;
    pending.delete(entry.message.toolCallId);
  }
  return {
    version: 1,
    harness: { name: "pi-native", format: PI_SNAPSHOT_FORMAT },
    revision,
    deliveredEvents,
    pendingCallIds: [...pending.values()],
    state: JSON.stringify({
      records: [manager.getHeader(), ...records],
      leaf,
      activeTools,
      steeringIds,
      input,
    }),
  };
}
