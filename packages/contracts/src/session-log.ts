import * as z from "zod";
import { ThinkingLevelSchema } from "./domain.js";
import { AskBlock, BotMessageIntent, ChoiceBlock, MessageBlock } from "./events.js";
import { Id, IsoDate } from "./ids.js";

export const EntryId = Id.brand<"EntryId">();
export type EntryId = z.infer<typeof EntryId>;
export const SessionId = Id.brand<"SessionId">();
export type SessionId = z.infer<typeof SessionId>;
export const EntrySeq = z.number().int().nonnegative().brand<"EntrySeq">();
export type EntrySeq = z.infer<typeof EntrySeq>;

export const Peer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), botId: Id, name: z.string() }),
  /** A connected agent from another owner, reached by its messaging address. */
  z.object({ kind: z.literal("agent"), address: z.string().min(1), name: z.string() }),
]);
export type Peer = z.infer<typeof Peer>;

export const RunModel = z.object({ provider: z.string(), id: z.string() });
export const TokenUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

/** Why a run started. The entry kinds point at the entry that woke the run. */
export const SessionRunTrigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), entryId: EntryId }),
  z.object({ kind: z.literal("routine"), routineId: Id, name: z.string(), scheduledAt: IsoDate }),
  z.object({ kind: z.literal("webhook"), routineId: Id }),
  z.object({ kind: z.literal("steering"), entryId: EntryId }),
  z.object({
    kind: z.literal("retry"),
    attempt: z.number().int().positive(),
    previousRunId: Id,
    reason: z.string(),
  }),
  z.object({ kind: z.literal("handoff"), entryId: EntryId }),
  z.object({ kind: z.literal("bot_message"), entryId: EntryId }),
]);
export type SessionRunTrigger = z.infer<typeof SessionRunTrigger>;

export const RunOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), usage: TokenUsage }),
  z.object({ status: z.literal("failed"), usage: TokenUsage, error: z.string() }),
  z.object({ status: z.literal("cancelled"), usage: TokenUsage, by: Id.optional() }),
]);
export type RunOutcome = z.infer<typeof RunOutcome>;

const JsonObject = z.record(z.string(), z.unknown());
const BotMessageHop = z.number().int().positive();

const envelope = {
  id: EntryId,
  sessionId: SessionId,
  seq: EntrySeq,
  parentId: EntryId.nullable(),
  ts: IsoDate,
  botId: Id.optional(),
  runId: Id.optional(),
};

function entry<const T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ ...envelope, type: z.literal(type), payload });
}

function runEntry<const T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ ...envelope, botId: Id, runId: Id, type: z.literal(type), payload });
}

const UserMessagePayload = z.object({
  blocks: z.array(MessageBlock),
  replyTo: z.object({ entryId: EntryId, quote: z.string().optional() }).optional(),
  clientNonce: z.string().optional(),
  source: z.enum(["app", "steering", "channel", "routine"]),
});

const SubagentPayload = z.object({
  callId: z.string().min(1),
  sessionId: SessionId,
  name: z.string(),
  model: RunModel,
  task: z.string(),
  status: z.enum(["completed", "failed"]),
  /** What the helper handed back to its parent, verbatim, as the tool result of `callId`. */
  result: z.string(),
  usage: TokenUsage,
});

const ComputerControlEntry = entry(
  "computer.control",
  z.object({ holder: z.enum(["user", "bot"]) }),
);
const MemoryRevisedEntry = entry("memory.revised", z.object({ facts: z.array(z.string()) }));
const SkillSavedEntry = entry("skill.saved", z.object({ skillId: Id, name: z.string() }));
const AttachmentAddedEntry = entry("attachment.added", z.object({ artifactId: Id }));
const SessionTitleEntry = entry("session.title", z.object({ title: z.string() }));
const SystemNoteEntry = entry("system.note", z.object({ text: z.string() }));

const EntryShapes = z.discriminatedUnion("type", [
  entry("user.message", UserMessagePayload),
  runEntry("assistant.text", z.object({ blocks: z.array(MessageBlock) })),
  runEntry("assistant.reasoning", z.object({ text: z.string() })),
  runEntry("assistant.ask", z.object({ block: AskBlock })),
  runEntry("assistant.choice", z.object({ block: ChoiceBlock })),
  runEntry(
    "tool.call",
    z.object({ callId: z.string().min(1), name: z.string(), input: z.string() }),
  ),
  runEntry(
    "tool.result",
    z.object({
      callId: z.string().min(1),
      output: z.string(),
      isError: z.boolean(),
      artifactIds: z.array(Id),
    }),
  ),
  runEntry(
    "run.started",
    z.object({
      trigger: SessionRunTrigger,
      model: RunModel,
      effort: ThinkingLevelSchema.nullable(),
    }),
  ),
  runEntry("run.finished", RunOutcome),
  runEntry("subagent", SubagentPayload),
  entry("handoff", z.object({ fromBotId: Id, toBotId: Id, text: z.string(), hop: BotMessageHop })),
  z.object({
    ...envelope,
    botId: Id,
    type: z.literal("bot.message.sent"),
    payload: z.object({
      to: Peer,
      text: z.string(),
      intent: BotMessageIntent,
      hop: BotMessageHop,
      /** The id of the first `bot.message.sent` of the exchange, copied through every hop. */
      exchangeId: EntryId,
    }),
  }),
  entry(
    "bot.message.received",
    z.object({
      from: Peer,
      fromSessionId: SessionId,
      fromEntryId: EntryId,
      text: z.string(),
      intent: BotMessageIntent,
      hop: BotMessageHop,
      exchangeId: EntryId,
      clientNonce: z.string().optional(),
    }),
  ),
  entry(
    "effect.requested",
    z.object({ effectId: Id, effectKind: z.string(), proposal: JsonObject }),
  ),
  entry("effect.edited", z.object({ effectId: Id, proposal: JsonObject })),
  entry("effect.resolved", z.object({ effectId: Id, decision: z.enum(["approved", "denied"]) })),
  ComputerControlEntry,
  MemoryRevisedEntry,
  SkillSavedEntry,
  AttachmentAddedEntry,
  SessionTitleEntry,
  SystemNoteEntry,
  entry(
    "compaction",
    z.object({
      summary: z.string(),
      /**
       * The seq of the compaction's parent, the last entry it summarizes, so nothing on the chain
       * sits between them.
       */
      coveredUpToSeq: EntrySeq,
    }),
  ),
  z.object({
    ...envelope,
    parentId: EntryId,
    type: z.literal("rewind"),
    payload: z.object({ reason: z.string().optional() }),
  }),
  z.object({
    ...envelope,
    parentId: z.null(),
    type: z.literal("clear"),
    payload: z.strictObject({}),
  }),
  entry("harness.session", z.object({ harness: z.string(), sessionId: z.string() })),
]);

export const SessionEntrySchema = EntryShapes.superRefine((entry, ctx) => {
  if (entry.parentId === null && entry.type !== "clear" && entry.seq !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["parentId"],
      message: "Only a clear entry or the first entry of a session has no parent",
    });
  }
  if (entry.seq === 0 && entry.parentId !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["parentId"],
      message: "The first entry of a session has no parent",
    });
  }
  if (entry.type === "compaction" && entry.payload.coveredUpToSeq >= entry.seq) {
    ctx.addIssue({
      code: "custom",
      path: ["payload", "coveredUpToSeq"],
      message: "A compaction covers only entries before it",
    });
  }
});
export type SessionEntry = z.infer<typeof SessionEntrySchema>;
export type SessionEntryType = SessionEntry["type"];
export type SessionEntryOf<T extends SessionEntryType> = Extract<SessionEntry, { type: T }>;

export type EntryAudience = { inference: "yes" | "no" | "context"; ui: boolean };

/** Who reads each entry type. `context` is one short line in the model's history. */
export const ENTRY_AUDIENCE = {
  "user.message": { inference: "yes", ui: true },
  "assistant.text": { inference: "yes", ui: true },
  "assistant.reasoning": { inference: "no", ui: true },
  "assistant.ask": { inference: "yes", ui: true },
  "assistant.choice": { inference: "yes", ui: true },
  "tool.call": { inference: "yes", ui: true },
  "tool.result": { inference: "yes", ui: true },
  subagent: { inference: "yes", ui: true },
  handoff: { inference: "yes", ui: true },
  "bot.message.sent": { inference: "yes", ui: true },
  "bot.message.received": { inference: "yes", ui: true },
  "run.started": { inference: "context", ui: true },
  "run.finished": { inference: "no", ui: true },
  "effect.requested": { inference: "no", ui: true },
  "effect.edited": { inference: "no", ui: true },
  "effect.resolved": { inference: "no", ui: true },
  "computer.control": { inference: "context", ui: true },
  "memory.revised": { inference: "no", ui: true },
  "skill.saved": { inference: "no", ui: true },
  "attachment.added": { inference: "no", ui: true },
  "session.title": { inference: "no", ui: true },
  "system.note": { inference: "no", ui: true },
  compaction: { inference: "yes", ui: true },
  rewind: { inference: "no", ui: true },
  clear: { inference: "no", ui: true },
  "harness.session": { inference: "no", ui: false },
} as const satisfies Record<SessionEntryType, EntryAudience>;

type Audience = typeof ENTRY_AUDIENCE;
export type InferenceEntry = SessionEntryOf<
  {
    [T in SessionEntryType]: Audience[T]["inference"] extends "no" ? never : T;
  }[SessionEntryType]
>;
export type UiEntry = SessionEntryOf<
  { [T in SessionEntryType]: Audience[T]["ui"] extends true ? T : never }[SessionEntryType]
>;

export function isInferenceEntry(entry: SessionEntry): entry is InferenceEntry {
  return ENTRY_AUDIENCE[entry.type].inference !== "no";
}

export function isUiEntry(entry: SessionEntry): entry is UiEntry {
  return ENTRY_AUDIENCE[entry.type].ui;
}

/** A turn of the history the runtime replays, in the shape `AgentRunRequest.history` takes. */
export type AgentHistoryTurn = {
  role: "user" | "assistant";
  content: string;
  /** The bot's own turns that ran tools, as ordered text and tool-call parts. */
  parts?: AgentHistoryTurnPart[];
};
export type AgentHistoryTurnPart =
  | { type: "text"; text: string }
  | {
      type: "toolCalls";
      calls: { id: string; name: string; args: Record<string, unknown>; output: string }[];
    };

const itemBase = { id: EntryId, ts: IsoDate };
const noteFields = { id: true, ts: true, type: true, payload: true } as const;
const noteKind = { kind: z.literal("note") };

/** What a thread renders, one item per kind. A run becomes a run item and a message per stretch. */
export const ThreadItemSchema = z.discriminatedUnion("kind", [
  z.discriminatedUnion("role", [
    z.object({
      kind: z.literal("message"),
      role: z.literal("user"),
      ...itemBase,
      ...UserMessagePayload.shape,
    }),
    z.object({
      kind: z.literal("message"),
      role: z.literal("bot"),
      ...itemBase,
      botId: Id,
      runId: Id,
      blocks: z.array(MessageBlock),
    }),
  ]),
  z.object({
    kind: z.literal("run"),
    ...itemBase,
    runId: Id,
    botId: Id,
    trigger: SessionRunTrigger,
    model: RunModel,
    effort: ThinkingLevelSchema.nullable(),
    finished: z
      .object({ outcome: RunOutcome, durationMs: z.number().int().nonnegative() })
      .nullable(),
  }),
  z.object({ kind: z.literal("subagent"), ...itemBase, runId: Id, ...SubagentPayload.shape }),
  z.object({
    kind: z.literal("handoff"),
    ...itemBase,
    fromBotId: Id,
    toBotId: Id,
    text: z.string(),
  }),
  z.discriminatedUnion("direction", [
    z.object({
      kind: z.literal("botMessage"),
      direction: z.literal("sent"),
      ...itemBase,
      botId: Id,
      peer: Peer,
      text: z.string(),
      intent: BotMessageIntent,
      exchangeId: EntryId,
      /** The later `bot.message.received` of the same exchange in this session, if any. */
      answeredBy: EntryId.nullable(),
    }),
    z.object({
      kind: z.literal("botMessage"),
      direction: z.literal("received"),
      ...itemBase,
      peer: Peer,
      text: z.string(),
      intent: BotMessageIntent,
      exchangeId: EntryId,
      origin: z.object({ sessionId: SessionId, entryId: EntryId }),
    }),
  ]),
  z.object({
    kind: z.literal("divider"),
    ...itemBase,
    reason: z.enum(["compaction", "rewind", "clear"]),
  }),
  z.object({
    kind: z.literal("effect"),
    ...itemBase,
    effectId: Id,
    effectKind: z.string(),
    proposal: JsonObject,
    decision: z.enum(["approved", "denied"]).nullable(),
  }),
  z.discriminatedUnion("type", [
    ComputerControlEntry.pick(noteFields).extend(noteKind),
    MemoryRevisedEntry.pick(noteFields).extend(noteKind),
    SkillSavedEntry.pick(noteFields).extend(noteKind),
    AttachmentAddedEntry.pick(noteFields).extend(noteKind),
    SessionTitleEntry.pick(noteFields).extend(noteKind),
    SystemNoteEntry.pick(noteFields).extend(noteKind),
  ]),
]);
export type ThreadItem = z.infer<typeof ThreadItemSchema>;
