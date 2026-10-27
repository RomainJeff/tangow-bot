import * as z from "zod";
import { BotSecretDestination } from "./bot-secrets.js";
import { Id, SkillUidSchema } from "./ids.js";
import { LinkMentionBlock, LinkPreviewBlock } from "./link-preview.js";
import { McpTransportSchema } from "./mcp.js";

export const ProductEventType = z.enum([
  "thread.progress",
  "thread.artifact",
  "thread.ask",
  "thread.choice",
  "thread.meta",
  "thread.computer",
  "run.started",
  "run.checkpointed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "computer.status",
  "computer.takeover.requested",
  "computer.takeover.granted",
  "computer.takeover.released",
  "memory.revised",
  "routine.created",
  "routine.updated",
  "routine.fired",
  "skill.teaching.started",
  "skill.teaching.stopped",
  "skill.draft.created",
  "skill.saved",
  "effect.recorded",
  "agent.tool.completed",
  /** A run followed a skill: read it, was forced or cited to it, or opened its files; payload { name, via }. */
  "agent.skill.used",
  "agent.skill.collision",
  /** Written by the removed end-of-exchange skill nudge; older threads still hold it. */
  "agent.skill.nudge",
  "effect.reconciled",
  /** A person changed a proposed effect on its approval card; payload { effectId, proposed, approved }. */
  "effect.edited",
  "usage.recorded",
  "bot.spawned",
  "bot.updated",
  "bot.archived",
  "bot.deleted",
  "group.created",
  "group.updated",
  "group.handoff",
  "session.entry.appended",
]);
export type ProductEventType = z.infer<typeof ProductEventType>;

export const SkillChange = z.enum(["learned", "updated", "deleted"]);

export const MessageRole = z.enum(["user", "bot", "system"]);
export const BotMessageIntent = z.enum(["request", "result", "question", "status", "fyi"]);
export type BotMessageIntent = z.infer<typeof BotMessageIntent>;

export const MAX_CHART_DATA_ROWS = 5_000;

const ChartSpec = z.record(z.string(), z.any());

function embeddedChartRowCount(spec: Record<string, unknown>): number {
  const specData = Array.isArray(spec.data) ? spec.data.length : 0;
  const markData = Array.isArray(spec.marks)
    ? spec.marks.reduce((total, mark) => {
        if (!mark || typeof mark !== "object" || !Array.isArray(mark.data)) return total;
        return total + mark.data.length;
      }, 0)
    : 0;
  return specData + markData;
}

const ChartBlock = z
  .object({
    kind: z.literal("chart"),
    name: z.string(),
    /** Declarative Observable Plot spec, validated by render_plot before publish.
        z.any keeps the inferred type JSON-assignable for persistence. */
    spec: ChartSpec,
    data: z.array(z.any()).max(MAX_CHART_DATA_ROWS),
  })
  .superRefine((block, ctx) => {
    if (block.data.length + embeddedChartRowCount(block.spec) <= MAX_CHART_DATA_ROWS) return;
    ctx.addIssue({
      code: "custom",
      message: `Chart data exceeds the ${MAX_CHART_DATA_ROWS.toLocaleString("en-US")}-row limit`,
    });
  });

export const SecretAskPurpose = z.enum(["otp", "password", "api_key"]);
export type SecretAskPurpose = z.infer<typeof SecretAskPurpose>;

/** ask_user v2: one or more questions answered in a single card (Claude Code style). */
export const AskQuestionOption = z.object({
  id: z.string(),
  label: z.string(),
  /** What the option does, one short line shown under the label. */
  description: z.string().optional(),
  /** At most one per question, shown as a muted "Recommended", never preselected. */
  recommended: z.boolean().optional(),
});
export const AskQuestion = z.object({
  id: z.string(),
  /** Short chip/tab label (<= 12 chars recommended). */
  header: z.string().optional(),
  question: z.string(),
  /** 0 options => a free-text question; 1-4 => tappable choices, "Other" always added by the UI. */
  options: z.array(AskQuestionOption).optional(),
  multiSelect: z.boolean().optional(),
  /** required:false renders a "Skip" affordance. Default true. */
  required: z.boolean().optional(),
});
export type AskQuestion = z.infer<typeof AskQuestion>;
/** The longest typed answer a question card takes: an "Other" text or a free-text answer. */
export const ASK_ANSWER_MAX_LENGTH = 2_000;
/** One question's answer: chosen option ids, an optional free-text "Other", or skipped. */
export const AskAnswer = z.object({
  selected: z.array(z.string()).optional(),
  other: z.string().optional(),
  skipped: z.boolean().optional(),
});
/** The full multi-question answer, keyed by question id. Submitted JSON-encoded in the answer field. */
export const AskAnswers = z.record(z.string(), AskAnswer);
export type AskAnswers = z.infer<typeof AskAnswers>;

/** What a card's action does once tapped. */
export const AskActionOutcome = z.enum(["created", "cancelled"]);
/** How a card was settled: its tapped action's outcome, or put away by a typed reply. */
export const AskOutcome = z.enum([...AskActionOutcome.options, "dismissed"]);
export type AskOutcome = z.infer<typeof AskOutcome>;
/** The `answer` of a proposal card the user put away by typing instead of tapping. */
export const ASK_DISMISSED_ANSWER = "dismissed";
/** What a card a bot shows on its own initiative proposes to create. */
export const ProposalKind = z.enum(["routine"]);
export type ProposalKind = z.infer<typeof ProposalKind>;

/** The longest message body a draft card sends. */
export const ASK_DRAFT_TEXT_MAX_LENGTH = 20_000;
export const ASK_DRAFT_SUBJECT_MAX_LENGTH = 1_000;
/** No mail address is longer. */
export const ASK_DRAFT_ADDRESS_MAX_LENGTH = 320;

export const AskDraftRecipient = z.object({
  role: z.enum(["to", "cc", "bcc"]),
  address: z.string(),
});
export type AskDraftRecipient = z.infer<typeof AskDraftRecipient>;

/** The most addresses a recipient line takes, or null when any number fits. */
const AskDraftRoom = z.number().int().positive().nullable();

/**
 * What the user changed on a mail draft before it leaves: its text, its whole recipient list, its
 * subject. The bounds refuse an enormous edit before any lock; the server applies the real limits.
 */
export const AskDraftEdits = z.object({
  text: z.string().max(ASK_DRAFT_TEXT_MAX_LENGTH).optional(),
  recipients: z
    .array(
      AskDraftRecipient.extend({ address: z.string().max(ASK_DRAFT_ADDRESS_MAX_LENGTH) }).strict(),
    )
    .max(1_000)
    .optional(),
  subject: z.string().max(ASK_DRAFT_SUBJECT_MAX_LENGTH).optional(),
});
export type AskDraftEdits = z.infer<typeof AskDraftEdits>;

/** Who a chat message goes to, as the chat app itself names them: a person or a channel. */
export const AskDraftConversation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), name: z.string(), handle: z.string().optional() }),
  z.object({ kind: z.literal("channel"), name: z.string() }),
]);
export type AskDraftConversation = z.infer<typeof AskDraftConversation>;

/** A message the bot proposes to send: the card shows it as it will leave. */
export const AskDraft = z.object({
  app: z.object({
    name: z.string(),
    logo: z.string().nullable(),
    /** The sending account, when the send names it. */
    account: z.string().optional(),
  }),
  recipients: z.array(AskDraftRecipient).min(1),
  /**
   * A chat message's one recipient, named by its app; its `recipients` hold the app's id for it.
   * Absent on mail.
   */
  conversation: AskDraftConversation.optional().catch(undefined),
  subject: z.string().optional(),
  /**
   * The lines the user may edit besides the text, each offered even when empty. Absent on a draft
   * whose recipients and subject stay as the bot wrote them.
   */
  fields: z
    .object({
      to: AskDraftRoom,
      cc: AskDraftRoom.optional(),
      bcc: AskDraftRoom.optional(),
      subject: z.literal(true).optional(),
    })
    .optional()
    .catch(undefined),
  body: z.string(),
  /** Why the last Send did not go out; `disconnected` when the app needs reconnecting. */
  failure: z.object({ reason: z.string(), disconnected: z.literal(true).optional() }).optional(),
  /** When it left, and whether the user changed the bot's message first. */
  sent: z.object({ at: z.string(), edited: z.boolean() }).optional(),
  /** The run's owner, the only person the server lets send, edit or discard the draft. */
  owner: z.object({ userId: z.string(), name: z.string().optional() }).optional().catch(undefined),
});
export type AskDraft = z.infer<typeof AskDraft>;
export type AskDraftFields = NonNullable<AskDraft["fields"]>;

export type AskDraftState = "pending" | "sending" | "sent" | "not_sent" | "discarded" | "replaced";

/** Where a draft card stands, read from the card alone. */
export function askDraftState(card: {
  status?: "pending" | "answered";
  answer?: string;
  failed?: true;
  draft?: Pick<AskDraft, "failure" | "sent">;
}): AskDraftState {
  if (card.status !== "answered") return card.draft?.failure ? "not_sent" : "pending";
  if (card.answer === ASK_DISMISSED_ANSWER) return "replaced";
  if (card.answer !== "allow") return "discarded";
  if (card.draft?.sent) return "sent";
  return card.failed ? "not_sent" : "sending";
}

export const AskBlock = z.object({
  kind: z.literal("ask"),
  text: z.string(),
  approvalEffectId: Id.optional(),
  detail: z.string().optional(),
  input: z.enum(["text", "secret"]).optional(),
  /** Why the secret is needed; drives field label on the masked card. */
  purpose: SecretAskPurpose.optional(),
  credential: BotSecretDestination.optional(),
  status: z.enum(["pending", "answered"]).optional(),
  answer: z.string().optional(),
  actions: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        outcome: AskActionOutcome.optional(),
      }),
    )
    .optional(),
  /** ask_user v2: when present, the card renders a multi-question stepper. */
  questions: z.array(AskQuestion).optional(),
  /** Structured answers once submitted; drives the frozen summary. */
  answers: AskAnswers.optional(),
  /** A spawn_bot approval card: the normalized fields, so a client can offer to edit them. */
  spawnBot: z
    .object({
      name: z.string(),
      title: z.string(),
      instructions: z.string(),
      prompt: z.string(),
      computerMode: z.enum(["", "team", "dedicated"]),
      /** The run's owner, the only person the server lets edit the card. */
      ownerUserId: z.string().optional(),
    })
    .optional(),
  proposal: ProposalKind.optional(),
  /** A routine card: what it sets up, the schedule as the server resolved it. */
  routine: z
    .object({ name: z.string(), schedule: z.string(), prompt: z.string(), notify: z.boolean() })
    .optional(),
  /** Written once the routine exists: the card links to it. */
  created: z.object({ kind: ProposalKind, id: z.string(), label: z.string() }).optional(),
  /** The proposal was approved but could not be created. */
  failed: z.literal(true).optional(),
  /**
   * What became of the routine the card is about. A confirmation the server settled has no
   * `answer`, so nothing the user typed in the app is in it.
   */
  confirms: z.enum(["created", "updated"]).optional(),
  /** An outbound mail: a draft the user sends. A shape this client cannot read shows as the plain card. */
  draft: AskDraft.optional().catch(undefined),
});

export const CHOICE_DISMISSED_ANSWER_ID = "_dismissed";

/**
 * The `answerId` of an `app_connect` card once its app is connected. One message holds several
 * cards, and one app can sit under two connectors, so it names both.
 */
export function appConnectAnswerId(card: { connectorId?: string; provider: string }): string {
  return `${card.connectorId ?? "composio"}:${card.provider}`;
}

export const ChoiceBlock = z.object({
  kind: z.literal("choice"),
  question: z.string(),
  subtitle: z.string().optional(),
  options: z.array(z.object({ id: z.string(), letter: z.string(), label: z.string() })),
  /** Set once the user picks an option; renders the picker as answered. */
  answerId: z.string().optional(),
});

export const SkillDraftBlock = z.object({
  kind: z.literal("skill_draft"),
  skillId: Id,
  name: z.string(),
  goal: z.string(),
  playbook: z.object({
    whenToUse: z.string(),
    inputs: z.array(z.string()),
    steps: z.array(z.string()),
    howToCheck: z.string(),
    whatToReturn: z.string(),
    approvalBoundaries: z.string(),
    failureHandling: z.string(),
  }),
  status: z.enum(["draft", "saved"]),
});

export const MessageBlock = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({
    kind: z.literal("card"),
    lines: z.array(z.object({ k: z.string(), v: z.string() })),
  }),
  AskBlock,
  ChoiceBlock,
  z.object({
    /** Inline app authorization card (Composio-backed): logo, name, one-line
        description, and an Authorize button that flips to connected. */
    kind: z.literal("app_connect"),
    connectorId: z.string().optional(),
    provider: z.string(),
    name: z.string(),
    description: z.string(),
    logo: z.string().nullable(),
    status: z.enum(["pending", "connected"]),
  }),
  z.object({
    kind: z.literal("connect"),
    name: z.string(),
    initial: z.string(),
    color: z.string(),
    status: z.enum(["pending", "connected"]),
  }),
  z.object({
    kind: z.literal("computer"),
    state: z.string(),
    text: z.string(),
  }),
  z.object({ kind: z.literal("meta"), text: z.string() }),
  // Legacy: reasoning is no longer produced or rendered, but threads persisted while it
  // was still stream them, and output validation rejects the whole page without it.
  z.object({ kind: z.literal("reasoning"), text: z.string() }),
  z.object({
    kind: z.literal("progress"),
    text: z.string(),
    /** Provider-generated tool status rather than assistant-authored narration. */
    activity: z.literal(true).optional(),
    pendingToolNames: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("steps"),
    steps: z.array(
      z.object({
        label: z.string(),
        count: z.number().int().positive(),
        /** One entry per collapsed call, for the "Display agent steps" detail view. */
        calls: z
          .array(
            z.object({
              name: z.string(),
              input: z.string(),
              output: z.string(),
              /** Provider tool-call id: lets a later turn replay the call as a real tool
                  turn. Absent on blocks recorded before it was stored. */
              id: z.string().optional(),
              /** The result is the outcome of a card the call raised, which a short replay of
                  past steps reads whole: it holds what the person decided or wrote. */
              outcome: z.literal(true).optional(),
            }),
          )
          .optional(),
      }),
    ),
    durationMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("child_bot"),
    botId: z.string(),
    name: z.string(),
    title: z.string().optional(),
    status: z.enum(["created", "archived", "deleted"]),
  }),
  SkillDraftBlock,
  ChartBlock,
  z.object({
    /** Approval card for an agent-created MCP server. The user completes the
        OAuth popup (or confirms no authorization is needed) in the UI. */
    kind: z.literal("mcp_approval"),
    name: z.string(),
    serverId: Id,
    transport: McpTransportSchema,
    endpoint: z.string().nullable(),
    needsOAuth: z.boolean(),
  }),
  z.object({
    kind: z.literal("image"),
    artifactId: Id,
    mimeType: z.string(),
    name: z.string(),
  }),
  z.object({
    kind: z.literal("file"),
    artifactId: Id,
    mimeType: z.string(),
    name: z.string(),
    size: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("handoff"),
    fromBotId: Id,
    toBotId: Id,
    text: z.string(),
    /** Links ownership transfers in one user-started group turn. */
    hop: z.number().int().positive().optional(),
  }),
  z.object({
    /** A group-chat message delivered into a member bot's own thread. */
    kind: z.literal("channel_message"),
    provider: z.string(),
    /** Per-message network when a provider spans multiple transports. */
    transport: z.string().optional(),
    channelId: Id,
    fromAddress: z.string(),
    fromLabel: z.string(),
    text: z.string(),
    hop: z.number().int().nonnegative().optional(),
  }),
  z.object({
    /** A sub-bot's routine run, traced in its own thread instead of a free closing text.
        Driven by the run lifecycle (queued/running/completed/failed/cancelled), not by
        model-authored narration; `headline`/`digest` are untrusted content, rendered as
        escaped text with no remote resource loads. */
    kind: z.literal("routine_run"),
    routineId: Id.optional(),
    routineName: z.string(),
    state: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    /** One-line summary shown at rest; the first non-empty line of `digest`, truncated. */
    headline: z.string().optional(),
    /** Full result text, shown in a collapsed-by-default toggle. */
    digest: z.string().optional(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    /** Mirrors the routine's `notify` setting at the time this card was rendered, so the
        client can default the toggle open/closed without a second lookup. */
    notify: z.boolean().optional(),
  }),
  z.object({
    /** A skill a bot learned, updated or deleted during this exchange, one block per skill.
        Written by the server from the run's skill writes, never by the model; clients show it
        as a link under the message, outside its content. `skillId` and `name` are the ones the
        bot wrote; `skillUid` is only on lines written while skills kept versions. */
    kind: z.literal("skill_source"),
    skillUid: SkillUidSchema.optional(),
    skillId: z.string(),
    name: z.string(),
    change: SkillChange,
  }),
  LinkPreviewBlock,
  LinkMentionBlock,
]);
export type MessageBlock = z.infer<typeof MessageBlock>;

export const ProductEventSchema = z.object({
  id: Id,
  spaceId: Id,
  threadId: Id,
  botId: Id,
  seq: z.number().int().nonnegative(),
  type: ProductEventType,
  runId: Id.optional(),
  createdAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type ProductEvent = z.infer<typeof ProductEventSchema>;

/**
 * A block whose `kind` this build does not know must not take the whole conversation down
 * with it. The union is exhaustive, so one unrecognised entry fails output validation and
 * the response carrying it is lost: every message in the thread disappears at once, and the
 * ORPCError it raises is not logged, which leaves no trace of why. That happens whenever the
 * data outlives the code that reads it, after a rollback or between two deployed versions.
 * Unrecognised entries are dropped instead, so the rest of the conversation still renders.
 */
export const MessageBlocks = z
  .array(z.unknown())
  .transform((blocks) => parseKnownMessageBlocks(blocks).map(({ block }) => block));

/**
 * Same tolerance as `MessageBlocks`, but keeps each known block's position in the original
 * array. A writer that has to rewrite one block (marking an ask answered, say) maps over the
 * stored array by index, so unrecognised entries survive the write instead of being dropped.
 */
export function parseKnownMessageBlocks(blocks: unknown): { index: number; block: MessageBlock }[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((entry, index) => {
    const parsed = MessageBlock.safeParse(entry);
    return parsed.success ? [{ index, block: parsed.data }] : [];
  });
}

export const ThreadMessageSchema = z.object({
  id: Id,
  threadId: Id,
  seq: z.number().int().nonnegative(),
  role: MessageRole,
  blocks: MessageBlocks,
  botId: Id.optional(),
  replyToMessageId: Id.optional(),
  replyQuote: z.string().optional(),
  runId: Id.optional(),
  // Set for message_user output (user-progress prefix); lets delegated (peer) runs still
  // surface messages the bot addressed to the user. See core/message-visibility.
  clientNonce: z.string().optional(),
  createdAt: z.string(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

export function canReactToThreadMessage(message: Pick<ThreadMessage, "id" | "blocks">): boolean {
  return (
    !message.id.startsWith("progress:") &&
    !message.id.startsWith("subagent:") &&
    !message.blocks.some((block) => block.kind === "channel_message")
  );
}
