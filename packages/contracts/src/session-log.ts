import * as z from "zod";
import {
  AskAnswers,
  AskBlock,
  BotMessageIntent,
  ChoiceBlock,
  MessageBlock,
  SkillChange,
  SkillDraftBlock,
} from "./events.js";
import { Id, IsoDate, ThinkingLevelSchema } from "./ids.js";
import { isLinkPreviewCard, LinkPreviewBlock } from "./link-preview.js";

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
  /** Started by the app with its task alone, such as a taught skill's test: no entry woke it. */
  z.object({ kind: z.literal("direct") }),
  /** A helper's run in its own session, woken by the parent's `tool.call` in the parent session. */
  z.object({ kind: z.literal("subagent"), entryId: EntryId }),
]);
export type SessionRunTrigger = z.infer<typeof SessionRunTrigger>;

export const RunOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), usage: TokenUsage }),
  z.object({ status: z.literal("failed"), usage: TokenUsage, error: z.string() }),
  z.object({ status: z.literal("cancelled"), usage: TokenUsage, by: Id.optional() }),
]);
export type RunOutcome = z.infer<typeof RunOutcome>;

/** How a routine run ended, as its thread learns it: the run's outcome and its final words. */
const RoutineFinishedPayload = RunOutcome.and(
  z.object({
    /** The run's final text, empty when it ended without one. */
    result: z.string(),
  }),
);

const JsonObject = z.record(z.string(), z.unknown());
/**
 * On an entry addressed to a child session that rose to the thread's main session, the child
 * session it was addressed to. The store sets it; an entry written to its own session has none.
 */
const risen = { originSessionId: SessionId.optional() };
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
  z.object({ ...risen, holder: z.enum(["user", "bot"]) }),
);
const MemoryRevisedEntry = entry(
  "memory.revised",
  z.object({ ...risen, facts: z.array(z.string()) }),
);
const SkillLearntEntry = entry(
  "skill.learnt",
  z.object({ ...risen, skillId: Id, name: z.string(), change: SkillChange }),
);
const AttachmentAddedEntry = entry("attachment.added", z.object({ artifactId: Id }));
const SessionTitleEntry = entry("session.title", z.object({ title: z.string() }));
const SystemNoteEntry = entry("system.note", z.object({ text: z.string() }));
const BlocksPayload = z.object({ ...risen, blocks: z.array(MessageBlock) });
/**
 * The entry a card's later state is about. `parentId` stays the chain link and names the head, so a
 * state change points at its card here, the way `replyTo` and a trigger's `entryId` do.
 */
const target = { target: EntryId };
/** The approval card as the person sees it, absent on entries written before it was kept. */
const card = AskBlock.optional();

const EntryShapes = z.discriminatedUnion("type", [
  entry("user.message", UserMessagePayload.extend(risen)),
  runEntry(
    "assistant.text",
    BlocksPayload.extend({
      /** Words the bot addressed to the person through `message_user`, kept even in a hidden peer run. */
      toPerson: z.literal(true).optional(),
    }),
  ),
  runEntry("assistant.reasoning", z.object({ text: z.string() })),
  runEntry("assistant.ask", z.object({ ...risen, block: AskBlock })),
  runEntry("assistant.choice", z.object({ ...risen, block: ChoiceBlock })),
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
  /** In the thread's main session, when a routine run opens its own session `sessionId`. */
  runEntry(
    "routine.started",
    z.object({
      sessionId: SessionId,
      routineId: Id,
      name: z.string(),
      trigger: z.enum(["routine", "webhook"]),
      scheduledAt: IsoDate,
      model: RunModel,
    }),
  ),
  runEntry("routine.finished", RoutineFinishedPayload),
  /** A bot's words outside any run, such as an onboarding card or a teaching session's draft. */
  z.object({
    ...envelope,
    botId: Id,
    runId: z.never().optional(),
    type: z.literal("bot.text"),
    payload: BlocksPayload,
  }),
  entry(
    "handoff",
    z.object({ ...risen, fromBotId: Id, toBotId: Id, text: z.string(), hop: BotMessageHop }),
  ),
  z.object({
    ...envelope,
    botId: Id,
    type: z.literal("bot.message.sent"),
    payload: z.object({
      ...risen,
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
    z.object({ ...risen, effectId: Id, effectKind: z.string(), proposal: JsonObject, card }),
  ),
  entry("effect.edited", z.object({ ...risen, effectId: Id, proposal: JsonObject, card })),
  entry(
    "effect.resolved",
    z.object({
      ...risen,
      effectId: Id,
      decision: z.enum(["approved", "denied"]),
      /** The action the person tapped, which tells allowing once from always. */
      answerId: z.string().optional(),
      /** Denied because the person answered something else instead of tapping the card. */
      dismissed: z.literal(true).optional(),
    }),
  ),
  /** What came of an approved card that creates a routine: the routine, or a failure. */
  entry(
    "effect.applied",
    z.object({
      ...target,
      routineId: Id.optional(),
      change: z.enum(["created", "updated"]).optional(),
      failed: z.literal(true).optional(),
    }),
  ),
  /**
   * A card settled: a choice chosen (`answerId`), a card dismissed, an ask the composer resumed (no
   * answer), an ask answered inside the card (`answer`, `""` for a secret, or a multi-question
   * card's `answers`), a connector connected (`answerId` the connector).
   */
  entry(
    "card.answered",
    z.object({
      ...target,
      answerId: z.string().optional(),
      answer: z.string().optional(),
      answers: AskAnswers.optional(),
      dismissed: z.literal(true).optional(),
    }),
  ),
  entry(
    "link.preview",
    z.object({
      ...target,
      block: LinkPreviewBlock.refine(isLinkPreviewCard, "A preview entry holds a card"),
      artifactId: Id.optional(),
    }),
  ),
  /** `target` is the `link.preview` entry the person removed. */
  entry("link.preview.removed", z.object(target)),
  /** One revision of a taught skill's draft card; the newest revision of a card wins. */
  entry("skill.draft", SkillDraftBlock.omit({ kind: true }).extend(target)),
  ComputerControlEntry,
  MemoryRevisedEntry,
  SkillLearntEntry,
  AttachmentAddedEntry,
  SessionTitleEntry,
  SystemNoteEntry,
  entry(
    "compaction",
    z.object({
      summary: z.string(),
      /**
       * The seq of the last entry the summary covers. The chain entries after it are the window
       * the compaction keeps word for word, so a reader of the tail walks back to it.
       */
      coveredUpToSeq: EntrySeq,
    }),
  ),
  z.object({
    ...envelope,
    parentId: EntryId,
    type: z.literal("rewind"),
    payload: z.object({
      reason: z.string().optional(),
      /** It cut a turn a compaction on the chain had summarized, so it starts a history generation. */
      cutsSummary: z.literal(true).optional(),
    }),
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
  if ("originSessionId" in entry.payload && entry.payload.originSessionId === entry.sessionId) {
    ctx.addIssue({
      code: "custom",
      path: ["payload", "originSessionId"],
      message: "An entry rises only from another session",
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
  "routine.started": { inference: "context", ui: true },
  "routine.finished": { inference: "yes", ui: true },
  "bot.text": { inference: "yes", ui: true },
  handoff: { inference: "yes", ui: true },
  "bot.message.sent": { inference: "yes", ui: true },
  "bot.message.received": { inference: "yes", ui: true },
  "run.started": { inference: "context", ui: true },
  "run.finished": { inference: "no", ui: true },
  "effect.requested": { inference: "no", ui: true },
  "effect.edited": { inference: "no", ui: true },
  "effect.resolved": { inference: "no", ui: true },
  "effect.applied": { inference: "no", ui: true },
  "card.answered": { inference: "no", ui: true },
  "link.preview": { inference: "no", ui: true },
  "link.preview.removed": { inference: "no", ui: true },
  "skill.draft": { inference: "no", ui: true },
  "computer.control": { inference: "context", ui: true },
  "memory.revised": { inference: "no", ui: true },
  "skill.learnt": { inference: "no", ui: true },
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

/**
 * What a run writes about its own work. A child session keeps only these; anything else its run
 * writes is conversation with the person and lands in the thread's main session.
 */
export const RUN_TRACE_TYPES: ReadonlySet<SessionEntryType> = new Set([
  "run.started",
  "run.finished",
  "assistant.text",
  "assistant.reasoning",
  "tool.call",
  "tool.result",
  "subagent",
] satisfies SessionEntryType[]);

export const BLOCK_KINDS_NEEDING_THE_PERSON: ReadonlySet<MessageBlock["kind"]> = new Set([
  "mcp_approval",
] satisfies MessageBlock["kind"][]);

type EntryBody = {
  [T in SessionEntryType]: Pick<SessionEntryOf<T>, "type" | "payload">;
}[SessionEntryType];

/**
 * Whether a child session keeps the entry: one of its run's trace types, except an
 * `assistant.text` holding a block that needs the person, which goes to the person whole.
 */
export function isRunTrace(entry: EntryBody): boolean {
  if (entry.type === "assistant.text") {
    return !entry.payload.blocks.some((block) => BLOCK_KINDS_NEEDING_THE_PERSON.has(block.kind));
  }
  return RUN_TRACE_TYPES.has(entry.type);
}

export function isInferenceEntry(entry: SessionEntry): entry is InferenceEntry {
  return ENTRY_AUDIENCE[entry.type].inference !== "no";
}

export function isUiEntry(entry: SessionEntry): entry is UiEntry {
  return ENTRY_AUDIENCE[entry.type].ui;
}

/** A turn of the history the runtime replays, in the shape `AgentRunRequest.history` takes. */
export type AgentHistoryTurn = {
  /** The entry the turn renders, so the runtime can drop the turn it already holds as its prompt. */
  id?: string;
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
/**
 * The child session an item's entry rose from, named when the same page holds the routine's start
 * or the helper's entry.
 */
const itemOrigin = {
  origin: z
    .object({
      sessionId: SessionId,
      kind: z.enum(["routine", "subagent"]).optional(),
      name: z.string().optional(),
    })
    .optional(),
};
const noteFields = { id: true, ts: true, type: true, payload: true } as const;
const noteKind = { kind: z.literal("note"), ...itemOrigin };

/** What a thread renders, one item per kind. A run becomes a run item and a message per stretch. */
export const ThreadItemSchema = z.discriminatedUnion("kind", [
  z.discriminatedUnion("role", [
    z.object({
      kind: z.literal("message"),
      role: z.literal("user"),
      ...itemBase,
      ...UserMessagePayload.shape,
      ...itemOrigin,
    }),
    z.object({
      kind: z.literal("message"),
      role: z.literal("bot"),
      ...itemBase,
      botId: Id,
      /** Absent for a bot's words outside any run. */
      runId: Id.optional(),
      blocks: z.array(MessageBlock),
      /** It holds the open run's streamed text, which its next entry replaces. */
      live: z.literal(true).optional(),
      ...itemOrigin,
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
  z.discriminatedUnion("status", [
    z.object({ kind: z.literal("subagent"), ...itemBase, runId: Id, ...SubagentPayload.shape }),
    /** A helper still at work: its `run_subagent` call has no answer yet. */
    z.object({
      kind: z.literal("subagent"),
      status: z.literal("running"),
      ...itemBase,
      runId: Id,
      callId: z.string().min(1),
      name: z.string(),
      task: z.string(),
    }),
  ]),
  z.object({
    kind: z.literal("routine"),
    ...itemBase,
    runId: Id,
    botId: Id,
    sessionId: SessionId,
    routineId: Id,
    name: z.string(),
    finished: z
      .object({ status: z.enum(["completed", "failed", "cancelled"]), result: z.string() })
      .nullable(),
  }),
  z.object({
    kind: z.literal("handoff"),
    ...itemBase,
    fromBotId: Id,
    toBotId: Id,
    text: z.string(),
    ...itemOrigin,
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
      ...itemOrigin,
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
    botId: Id.optional(),
    runId: Id.optional(),
    /** The approval card with its answer and what came of it applied. */
    card,
    ...itemOrigin,
  }),
  z.discriminatedUnion("type", [
    ComputerControlEntry.pick(noteFields).extend(noteKind),
    MemoryRevisedEntry.pick(noteFields).extend(noteKind),
    SkillLearntEntry.pick(noteFields).extend(noteKind),
    AttachmentAddedEntry.pick(noteFields).extend(noteKind),
    SessionTitleEntry.pick(noteFields).extend(noteKind),
    SystemNoteEntry.pick(noteFields).extend(noteKind),
  ]),
]);
export type ThreadItem = z.infer<typeof ThreadItemSchema>;
