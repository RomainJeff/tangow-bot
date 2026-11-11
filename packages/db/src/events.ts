import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { AskAnswers, AskDraftEdits, FactualRunRecap, SessionId } from "@rakazo/contracts";
import {
  ASK_ANSWER_MAX_LENGTH,
  type AskQuestion,
  type BotSecretDestination,
  type MessageBlock,
  type ProductEvent,
  RUN_WORK_TYPES,
} from "@rakazo/contracts";
import type { DraftRecord } from "@rakazo/core";
import {
  ACTIVE_RUN_STATUSES,
  askDraftDetail,
  blocksToAgentHistoryText,
  DISMISSABLE_EFFECT_KINDS,
  DISMISSED_EFFECT_RESULT,
  DRAFT_GONE,
  draftMessage,
  draftWithState,
  editDraftRequest,
  fromParent,
  isApprovalAskBlock,
  isSecretAskBlock,
  isWorkingStatus,
  messagingChannelId,
  normalizeSpawnBotArgs,
  readDraft,
  runStartedByUser,
  sanitizeJsonValue,
  spawnBotApprovalBlock,
  spawnBotToolArgs,
  validateSpawnBotArgs,
  valueAt,
  withValueAt,
} from "@rakazo/core";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { getLogger } from "@rakazo/logging";
import { activeBotNames } from "./bot-names.js";
import type { BrowserApprovalCheckpoint } from "./browser-approval-checkpoint.js";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma, PrismaClient, Run } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { markThreadsUnread } from "./groups.js";
import { createBotMessageInTransaction, createThreadMessageInTransaction } from "./messages.js";
import {
  appendCardStateInTransaction,
  appendComputerControlInTransaction,
  appendRewindInTransaction,
  appendRunFinishedInTransaction,
  appendSessionEntryInTransaction,
  assertRunCanWriteHistory,
  blocksOf,
  ENTRY_ON_CHAIN,
  historyGeneration,
  latestRunAsk,
  RunHistoryWriteError,
  threadEntryByNonce,
  threadEventSeq,
} from "./sessions.js";
import { withTransactionRetry } from "./transaction-retry.js";

const EVENT_BATCH_SIZE = 200;
const PUSH_CATCH_UP_MS = 30_000;
const POLL_ONLY_CATCH_UP_MS = 400;

export interface AppendEventInput {
  spaceId: string;
  threadId: string;
  botId: string;
  type: ProductEvent["type"];
  payload: Record<string, unknown>;
  runId?: string;
}

export interface ThreadEvents {
  answerRunInput(input: AnswerRunInput): Promise<boolean>;
  append(input: AppendEventInput): Promise<ProductEvent>;
  claimSteering(input: ClaimSteeringInput): Promise<ClaimedSteeringMessage[]>;
  clearThread(input: ClearThreadInput): Promise<ClearThreadResult>;
  rewindThread(input: RewindThreadInput): Promise<RewindThreadResult | null>;
  finalizeComputerControlRelease(
    input: FinalizeComputerControlReleaseInput,
  ): Promise<FinalizeComputerControlReleaseResult | false>;
  finalizeRun(input: FinalizeRunInput): Promise<FinalizeRunResult | false>;
  notify(threadId: string, seq: number): Promise<void>;
  pauseRunForInput(input: PauseRunForInput): Promise<boolean>;
  pauseRunForParent(input: PauseRunForParent): Promise<{ wokenRunId: string | null } | null>;
  pauseRunForTakeover(input: PauseRunForTakeover): Promise<boolean>;
  sendUserMessage(input: SendUserMessageInput): Promise<SendUserMessageResult>;
  startInboundRoutineRuns(
    input: StartInboundRoutineRunsInput,
  ): Promise<StartInboundRoutineRunsResult>;
  /** `allowed` is asked again whenever new events arrive; once false, the stream ends. */
  follow(
    threadId: string,
    cursor: number,
    signal?: AbortSignal,
    allowed?: () => Promise<boolean>,
  ): AsyncGenerator<ProductEvent>;
}

export interface ClearThreadInput {
  spaceId: string;
  threadId: string;
  /** Event author and the bot-scoped target for one-to-one chats. */
  botId: string;
  groupId?: string;
  /** Who cleared, recorded on the runs this cancels. */
  userId?: string;
}

export interface ClearThreadResult {
  cancelledRunIds: string[];
  /** The history generation the clear ended, whose compacted summaries the caller purges. */
  historyGeneration: number;
}

export interface RewindThreadInput extends ClearThreadInput {
  /** The user message to rewind to; it and everything after it is removed. */
  messageId: string;
}

export interface RewindThreadResult {
  cancelledRunIds: string[];
  /**
   * The history generation the rewind ended, whose compacted summaries the caller purges; absent
   * when it cut no summarized turn.
   */
  historyGeneration?: number;
}

export interface FinalizeComputerControlReleaseInput {
  spaceId: string;
  computerId: string;
  botId: string;
  runId: string | null;
  leaseId: string;
  holder: "bot" | "none";
  reason: "done" | "expired" | "released" | "skipped";
}

export interface FinalizeComputerControlReleaseResult {
  runId: string | null;
}

export interface ClaimSteeringInput {
  threadId: string;
  botId: string;
  runId: string;
  leaseOwner: string;
  leaseFence: number;
  seenIds: string[];
}

export interface ClaimedSteeringMessage {
  id: string;
  messageId: string;
  text: string;
  blocks: MessageBlock[];
  untrusted: boolean;
}

export interface FinalizeRunResult {
  continuationRunId: string | null;
}

interface FinalizeRunBase {
  recap?: FactualRunRecap;
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
}

export type FinalizeRunInput = FinalizeRunBase &
  (
    | {
        outcome: "completed";
        blocks: MessageBlock[];
        /** Explicitly addressed terminal output, committed with the run's completion. */
        publicBlocks?: MessageBlock[];
        markUnread?: boolean;
        /** The run's final words, which a routine run reports to its thread. */
        result?: string;
      }
    | { outcome: "failed"; error: string }
  );

export interface PauseRunForInput {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  blocks: MessageBlock[];
  /**
   * Unredacted choice actions for resume. Persisted only on the run checkpoint
   * (not in message blocks) so clients still see redacted labels.
   */
  offeredActions?: Array<{ id: string; label: string }>;
  browserApprovalCheckpoint?: BrowserApprovalCheckpoint;
  /**
   * The effect an approval card asks about; its proposal is already redacted. `reopen` asks again
   * about a draft that did not leave, in the same transaction that parks the run on it.
   */
  effect?: { id: string; kind: string; proposal: Record<string, unknown>; reopen?: DraftRecord };
  /** The logged tool call the run pauses on, which gets its one result here, naming the pause. */
  pausedCall?: { sessionId: string; botId: string; runId: string; callId: string; output: string };
}

const CHOICE_ASK_CHECKPOINT_KIND = "choice_ask_v1";

/**
 * Appended to the prompt that resumes a run after the user answers an ask (from the card or the
 * composer). Without it the model tends to "go back up" the conversation and re-explain or
 * re-answer things already settled before the ask; this keeps it on the delta the answer adds.
 */
const RESUME_DELTA_RULE =
  "Respond only to what this reply adds or changes. Do not go back over the earlier conversation to re-explain, re-justify, or re-answer points that were already settled — the user has read all of that. If the reply needs no substantive answer, just continue the task or end the turn.";

function choiceAskCheckpoint(actions: Array<{ id: string; label: string }>): string {
  return JSON.stringify({ kind: CHOICE_ASK_CHECKPOINT_KIND, actions });
}

function resumeChoiceLabel(
  selected: { id: string; label: string },
  checkpoint: string | null | undefined,
): string {
  if (!checkpoint) return selected.label;
  try {
    const parsed = JSON.parse(checkpoint) as {
      kind?: string;
      actions?: Array<{ id?: unknown; label?: unknown }>;
    };
    if (parsed.kind !== CHOICE_ASK_CHECKPOINT_KIND || !Array.isArray(parsed.actions)) {
      return selected.label;
    }
    const offered = parsed.actions.find((action) => action.id === selected.id);
    return typeof offered?.label === "string" && offered.label.length > 0
      ? offered.label
      : selected.label;
  } catch {
    return selected.label;
  }
}

export interface PauseRunForParent {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  question: string;
}

export interface PauseRunForTakeover {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  reason: string;
  /** Computer that should expose the pending takeover to the UI via controlRunId. */
  computerId: string;
}

export interface AnswerRunInput {
  spaceId: string;
  threadId: string;
  runId: string;
  messageId: string;
  answeredByUserId: string;
  answer: string;
  /** Changes to a Create bot card or a mail draft, applied with "allow" by the run's owner only. */
  edits?: AskDraftEdits & { name?: string; instructions?: string };
}

export interface SendUserMessageInput {
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  blocks: MessageBlock[];
  prompt: string;
  trigger: "user" | "follow_up" | "webhook" | "messaging";
  /** Webhook runs only: false lets the run follow the normal approval rules. Defaults to true. */
  requireToolApproval?: boolean;
  clientNonce?: string;
  /** When false, persist the user message without starting a run (team-chat transcript). */
  createRun?: boolean;
  /** When true, start a new run even if the bot is already busy (team-chat delivery). */
  allowParallelRun?: boolean;
}

export interface SendUserMessageResult {
  messageId: string;
  seq: number;
  taskId: string | null;
  runId: string | null;
}

/**
 * Keeps runs that report only through a routine run card (every inbound routine wake and a
 * sub-bot's scheduled routine, mirroring `showsRoutineRunCard` in the executor) out of the
 * steering lookup: a message the user sends starts its own run instead of being folded into
 * one whose reply never reaches the conversation.
 */
export const conversationRunFilter = {
  parentRunId: null,
  NOT: {
    routineId: { not: null },
    OR: [{ trigger: "webhook" }, { trigger: "routine", bot: { parentBotId: { not: null } } }],
  },
} satisfies Prisma.RunWhereInput;

/** The routines one inbound delivery (webhook, GitHub, message) woke, one run each. */
export interface StartInboundRoutineRunsInput {
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  runs: Array<{
    routineId: string;
    prompt: string;
    requireToolApproval: boolean;
    clientNonce?: string;
  }>;
}

export interface StartInboundRoutineRunsResult {
  runIds: string[];
}

export interface RunSecretWriter {
  store(input: {
    botId: string;
    credential?: BotSecretDestination;
    runId: string;
    userId: string;
    spaceId: string;
    plaintext: string;
    tx: Prisma.TransactionClient;
  }): Promise<void>;
}

export function createThreadEvents(
  prisma: PrismaClient,
  realtime?: RealtimeFanout,
  options: { catchUpMs?: number; runSecretWriter?: RunSecretWriter } = {},
): ThreadEvents {
  return {
    answerRunInput: (input) => answerRunInput(prisma, input, realtime, options.runSecretWriter),
    append: (input) => appendEvent(prisma, input, realtime),
    claimSteering: (input) => claimSteering(prisma, input),
    clearThread: (input) => clearThread(prisma, input, realtime),
    rewindThread: (input) => rewindThread(prisma, input, realtime),
    finalizeComputerControlRelease: (input) =>
      finalizeComputerControlRelease(prisma, input, realtime),
    finalizeRun: (input) => finalizeRun(prisma, input, realtime),
    notify: (threadId, seq) => notifyRealtime(realtime, threadId, seq),
    pauseRunForInput: (input) => pauseRunForInput(prisma, input, realtime),
    pauseRunForParent: (input) => pauseRunForParent(prisma, input),
    pauseRunForTakeover: (input) => pauseRunForTakeover(prisma, input, realtime),
    sendUserMessage: (input) => sendUserMessage(prisma, input, realtime),
    startInboundRoutineRuns: (input) => startInboundRoutineRuns(prisma, input, realtime),
    follow: (threadId, cursor, signal, allowed) =>
      followThreadEvents(prisma, threadId, cursor, realtime, signal, options.catchUpMs, allowed),
  };
}

interface TruncateThreadInput extends ClearThreadInput {
  /** The runs that wrote entries of the main session from this seq on are cut with them. */
  fromSeq: number;
  /** Events with seq >= fromEventSeq are deleted; null keeps them all. */
  fromEventSeq: number | null;
  /** Runs started at or after this instant belong to the part of the conversation that goes. */
  fromCreatedAt: Date;
}

interface TruncateThreadResult {
  sessionId: string;
  cancelledRunIds: string[];
}

/** A group with more than one person keeps its history: nobody clears it or rewinds it. */
export class SharedGroupHistoryError extends Error {
  constructor() {
    super("A group's history is shared by its people");
    this.name = "SharedGroupHistoryError";
  }
}

/**
 * Shared by clearThread (cut at zero) and rewindThread (cut at a message): stop the thread's
 * work, release its computer, and drop the feed at or after the cut. The entry that cuts the
 * chain differs per caller and stays out of here.
 */
async function truncateThreadInTransaction(
  tx: Prisma.TransactionClient,
  input: TruncateThreadInput,
): Promise<TruncateThreadResult> {
  // Thread row first, as every send and finalizeRun take it: a group's update below writes no
  // column, so Prisma only reads the row and the person rows would be locked ahead of it.
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
  const thread = await tx.thread.update({
    where: {
      id: input.threadId,
      spaceId: input.spaceId,
      ...(input.groupId
        ? { groupId: input.groupId }
        : { OR: [{ botId: input.botId }, { memberBotId: input.botId }] }),
    },
    // A group keeps each person's read mark on their own row.
    data: input.groupId ? {} : { unread: false },
    select: { sessionId: true },
  });
  if (
    input.groupId &&
    (await tx.chatGroupPerson.count({ where: { groupId: input.groupId } })) > 1
  ) {
    throw new SharedGroupHistoryError();
  }
  if (input.groupId && input.userId) {
    await tx.chatGroupPerson.updateMany({
      where: { groupId: input.groupId, userId: input.userId },
      data: { unread: false },
    });
  }
  const activeRuns = await tx.run.findMany({
    where: {
      spaceId: input.spaceId,
      threadId: input.threadId,
      ...(input.groupId ? {} : { botId: input.botId }),
      status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
    },
    select: { id: true, taskId: true },
  });
  const now = new Date();
  const runIds = activeRuns.map((run) => run.id);
  await cancelRunsInTransaction(tx, activeRuns, now, input.userId);
  // Expire as tombstones so a still-open provider screen claim cannot reset fencing to 1.
  await expireComputerExecutionLeases(tx, { runId: { in: runIds } });
  await tx.computer.updateMany({
    where: { executionRunId: { in: runIds } },
    data: {
      executionRunId: null,
      executionBotId: null,
      executionLeaseExpiresAt: null,
    },
  });
  const cutRuns = await tx.sessionEntry.findMany({
    where: { sessionId: thread.sessionId, seq: { gte: input.fromSeq }, runId: { not: null } },
    select: { runId: true },
    distinct: ["runId"],
  });
  // Their skill lines belonged under the replies the cut leaves behind: none is written after this.
  await tx.run.updateMany({
    where: {
      threadId: input.threadId,
      skillLinesAt: null,
      OR: [
        { id: { in: [...runIds, ...cutRuns.flatMap((entry) => entry.runId ?? [])] } },
        { createdAt: { gte: input.fromCreatedAt } },
      ],
    },
    data: { skillLinesAt: now },
  });
  if (input.fromEventSeq !== null) {
    await tx.event.deleteMany({
      where: { threadId: input.threadId, seq: { gte: input.fromEventSeq } },
    });
  }
  if (input.groupId) {
    await tx.chatGroup.update({ where: { id: input.groupId }, data: { updatedAt: now } });
  } else {
    await tx.bot.update({
      where: { id: input.botId, spaceId: input.spaceId },
      data: { updatedAt: now },
    });
  }
  return { ...thread, cancelledRunIds: runIds };
}

export async function clearThread(
  prisma: PrismaClient,
  input: ClearThreadInput,
  realtime?: RealtimeFanout,
): Promise<ClearThreadResult> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const truncated = await truncateThreadInTransaction(tx, {
      ...input,
      fromSeq: 0,
      fromEventSeq: 0,
      fromCreatedAt: new Date(0),
    });
    const generation = await historyGeneration(tx, truncated.sessionId);
    await appendSessionEntryInTransaction(tx, {
      type: "clear",
      sessionId: truncated.sessionId as SessionId,
      payload: {},
      feedBotId: input.botId,
    });
    return {
      cancelledRunIds: truncated.cancelledRunIds,
      historyGeneration: generation,
      eventSeq: await threadEventSeq(tx, input.threadId),
    };
  });
  const { eventSeq, ...cleared } = committed;
  await notifyRealtime(realtime, input.threadId, eventSeq);
  return cleared;
}

/**
 * Cuts the chain back to before the target user message and everything after it, so the caller
 * can resend an edited version. Returns null when the target is not a person's message still on
 * the thread's chain: a rewind into what an earlier rewind or a clear cut would fork the log.
 */
export async function rewindThread(
  prisma: PrismaClient,
  input: RewindThreadInput,
  realtime?: RealtimeFanout,
): Promise<RewindThreadResult | null> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const [target] = await tx.$queryRaw<Array<{ seq: number; createdAt: Date }>>`
      SELECT e.seq, e."createdAt" FROM session_entries e
      JOIN sessions s ON s.id = e."sessionId" AND s."threadId" = ${input.threadId} AND s.kind = 'thread'
      WHERE e.id = ${input.messageId} AND e.type = 'user.message' AND ${ENTRY_ON_CHAIN}`;
    if (!target) return null;
    const [created] = await tx.$queryRaw<Array<{ seq: number }>>`
      SELECT seq FROM events
      WHERE "threadId" = ${input.threadId} AND type = 'session.entry.appended'
        AND payload -> 'entries' @> ${JSON.stringify([{ id: input.messageId }])}::jsonb
      ORDER BY seq LIMIT 1`;
    const truncated = await truncateThreadInTransaction(tx, {
      ...input,
      fromSeq: target.seq,
      // No event carried it (a message older than the feed): keep every event rather than guess
      // a cut point and drop the wrong range.
      fromEventSeq: created?.seq ?? null,
      fromCreatedAt: target.createdAt,
    });
    const generation = await historyGeneration(tx, truncated.sessionId);
    await appendRewindInTransaction(tx, {
      sessionId: truncated.sessionId as SessionId,
      messageId: input.messageId,
      feedBotId: input.botId,
    });
    const ended = (await historyGeneration(tx, truncated.sessionId)) !== generation;
    return {
      cancelledRunIds: truncated.cancelledRunIds,
      ...(ended ? { historyGeneration: generation } : {}),
      eventSeq: await threadEventSeq(tx, input.threadId),
    };
  });
  if (!committed) return null;
  const { eventSeq, ...rewound } = committed;
  await notifyRealtime(realtime, input.threadId, eventSeq);
  return rewound;
}

export async function sendUserMessage(
  prisma: PrismaClient,
  input: SendUserMessageInput,
  realtime?: RealtimeFanout,
): Promise<SendUserMessageResult> {
  const replay = async (): Promise<SendUserMessageResult | null> => {
    if (!input.clientNonce) return null;
    const message = await threadEntryByNonce(prisma, input.threadId, input.clientNonce);
    if (!message) return null;
    const { created, steered, answered } = await runsOfMessage(prisma, message);
    const [first] = created;
    return {
      messageId: message.id,
      seq: message.seq,
      taskId: first?.taskId ?? null,
      runId: (first ?? steered[0] ?? answered[0])?.id ?? null,
    };
  };
  const existing = await replay();
  if (existing) return existing;

  const commit = () =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Message first: its thread-row lock serializes the whole send against clearThread, so a
      // concurrent clear either sees the committed run and cancels it, or strictly precedes this
      // transaction. Created in separate transactions, the run could land inside the clear's
      // window and later repopulate the cleared conversation, and a clear could strand the
      // message without its event.
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "user",
        blocks: input.blocks,
        clientNonce: input.clientNonce,
        source: input.trigger === "messaging" || input.trigger === "webhook" ? "channel" : "app",
        feedBotId: input.botId,
      });
      const createRun = input.createRun !== false;
      const busy =
        createRun && !input.allowParallelRun
          ? await tx.run.findFirst({
              where: {
                threadId: input.threadId,
                botId: input.botId,
                status: {
                  in: ["running", "queued", "leased", "waiting_input", "waiting_takeover"],
                },
                ...conversationRunFilter,
              },
              select: { id: true, taskId: true },
            })
          : null;
      let task = null;
      let run = null;
      if (createRun && !busy) {
        task = await tx.task.create({
          data: {
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            userId: input.userId,
            prompt: input.prompt,
            status: "queued",
          },
        });
        run = await tx.run.create({
          data: {
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            taskId: task.id,
            userId: input.userId,
            status: "queued",
            trigger: input.trigger,
            requireToolApproval: input.requireToolApproval,
            clientNonce: input.clientNonce ? `send:${message.id}` : undefined,
            sourceMessageId: message.id,
          },
        });
      } else if (createRun && busy) {
        await tx.steeringMessage.create({
          data: {
            messageId: message.id,
            botId: input.botId,
            userId: input.userId,
            runId: busy.id,
            untrusted: !runStartedByUser({ trigger: input.trigger, sourceRole: "user" }),
          },
        });
      }
      return { message, task, run, busy, eventSeq: await threadEventSeq(tx, input.threadId) };
    });
  const committed = await commit().catch(async (error) => {
    const winner = await replay();
    if (winner) return { replay: winner } as const;
    throw error;
  });
  if ("replay" in committed) return committed.replay;
  await notifyRealtime(realtime, input.threadId, committed.eventSeq).catch((error) => {
    // The event is durable; subscribers recover it from their persisted cursor.
    getLogger().error("user message realtime notification", error);
  });
  return {
    messageId: committed.message.id,
    seq: committed.message.seq,
    taskId: committed.task?.id ?? null,
    runId: committed.run?.id ?? committed.busy?.id ?? null,
  };
}

/** At most this many card answers follow one message: one per bot of a group. */
const ANSWERS_AFTER_MESSAGE = 50;

/**
 * The runs a person's message started, in the order it started them, the ones it steered, and the
 * ones whose question it answered from the composer: the answers its send logged right after it.
 */
export async function runsOfMessage(
  prisma: PrismaClient | Prisma.TransactionClient,
  message: { id: string; sessionId: string; seq: number },
): Promise<{ created: Run[]; steered: Run[]; answered: Run[] }> {
  const [created, steering, after] = await Promise.all([
    prisma.run.findMany({
      where: { sourceMessageId: message.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.steeringMessage.findMany({
      where: { messageId: message.id, runId: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { run: true },
    }),
    prisma.sessionEntry.findMany({
      where: { sessionId: message.sessionId, seq: { gt: message.seq } },
      orderBy: { seq: "asc" },
      take: ANSWERS_AFTER_MESSAGE,
      select: { id: true, parentId: true, type: true, payload: true },
    }),
  ]);
  const cards: string[] = [];
  let parentId = message.id;
  for (const entry of after) {
    if (entry.type !== "card.answered" || entry.parentId !== parentId) break;
    cards.push((entry.payload as { target: string }).target);
    parentId = entry.id;
  }
  const asked = cards.length
    ? await prisma.sessionEntry.findMany({ where: { id: { in: cards } }, select: { runId: true } })
    : [];
  const answeredRunIds = asked.flatMap((card) => card.runId ?? []);
  const answered = answeredRunIds.length
    ? await prisma.run.findMany({ where: { id: { in: answeredRunIds } } })
    : [];
  return { created, steered: steering.flatMap((row) => row.run ?? []), answered };
}

/**
 * Queue one run per routine an inbound delivery woke, without writing a user message: the
 * routine's instructions and the payload stay in the task prompt, and the thread only shows the
 * run card. All runs commit together, so a delivery is never left half-woken, and a redelivered
 * nonce returns the runs it already started.
 */
export async function startInboundRoutineRuns(
  prisma: PrismaClient,
  input: StartInboundRoutineRunsInput,
  realtime?: RealtimeFanout,
): Promise<StartInboundRoutineRunsResult> {
  const nonces = input.runs.flatMap((run) => (run.clientNonce ? [run.clientNonce] : []));
  const replay = async () => {
    if (nonces.length === 0) return null;
    const existing = await prisma.run.findMany({
      where: { spaceId: input.spaceId, clientNonce: { in: nonces } },
      select: { id: true, clientNonce: true },
    });
    if (existing.length === 0) return null;
    return nonces.flatMap((nonce) => existing.filter((run) => run.clientNonce === nonce));
  };
  const existing = await replay();
  if (existing) return { runIds: existing.map((run) => run.id) };

  const commit = () =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Same thread-row lock as sendUserMessage, so a concurrent clear either cancels these runs
      // or strictly precedes them.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
      const runIds: string[] = [];
      let lastEventSeq = 0;
      for (const routineRun of input.runs) {
        const task = await tx.task.create({
          data: {
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            userId: input.userId,
            prompt: routineRun.prompt,
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            taskId: task.id,
            userId: input.userId,
            status: "queued",
            trigger: "webhook",
            routineId: routineRun.routineId,
            requireToolApproval: routineRun.requireToolApproval,
            clientNonce: routineRun.clientNonce,
          },
        });
        const event = await appendEventInTransaction(tx, {
          spaceId: input.spaceId,
          threadId: input.threadId,
          botId: input.botId,
          type: "routine.fired",
          runId: run.id,
          payload: { routineId: routineRun.routineId },
        });
        runIds.push(run.id);
        lastEventSeq = event.seq;
      }
      return { runIds, lastEventSeq };
    });
  const committed = await commit().catch(async (error) => {
    const winner = await replay();
    if (winner) return { replay: winner } as const;
    throw error;
  });
  if ("replay" in committed) return { runIds: committed.replay.map((run) => run.id) };
  await notifyRealtime(realtime, input.threadId, committed.lastEventSeq).catch((error) => {
    getLogger().error("routine run realtime notification", error);
  });
  return { runIds: committed.runIds };
}

export async function claimSteering(
  prisma: PrismaClient,
  input: ClaimSteeringInput,
): Promise<ClaimedSteeringMessage[]> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        // A helper is no turn of the conversation: what the person sends goes to its parent.
        OR: [{ parentRunId: null }, { trigger: "helper" }],
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      select: {
        id: true,
        trigger: true,
        sessionId: true,
        historyThroughSeq: true,
        sourceMessage: { select: { payload: true } },
        thread: { select: { sessionId: true } },
      },
    });
    if (!run) return [];
    const channelId =
      run.trigger === "messaging" ? messagingChannelId(blocksOf(run.sourceMessage)) : undefined;
    const steering = await tx.steeringMessage.findMany({
      where: {
        botId: input.botId,
        id: input.seenIds.length ? { notIn: input.seenIds } : undefined,
        ...(run.trigger === "helper"
          ? // A background helper reads only what its parent sent it, in its own session, after
            // the history this attempt read, which holds every earlier message already.
            {
              runId: input.runId,
              message: { sessionId: run.sessionId, seq: { gte: run.historyThroughSeq ?? 0 } },
            }
          : {
              OR: [{ runId: null }, { runId: input.runId }],
              message: {
                sessionId: run.thread.sessionId,
                // Private follow-ups remain unclaimed for the existing private continuation.
                ...(channelId
                  ? {
                      payload: {
                        path: ["blocks"],
                        array_contains: [{ kind: "channel_message", channelId }],
                      },
                    }
                  : {}),
              },
            }),
      },
      include: { message: { select: { payload: true } } },
      orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
    });
    if (steering.length === 0) return [];
    await tx.steeringMessage.updateMany({
      where: { id: { in: steering.map((item) => item.id) }, claimedAt: null },
      data: { runId: input.runId, claimedAt: new Date() },
    });
    return steering.map((item) => {
      const blocks = blocksOf(item.message);
      const text = blocksToAgentHistoryText(blocks);
      return {
        id: item.id,
        messageId: item.messageId,
        text: run.trigger === "helper" ? fromParent(text) : text,
        blocks,
        untrusted: item.untrusted,
      };
    });
  });
}

/** The run is still awaiting an answer, but the submitted payload is malformed or incomplete. */
export class InvalidAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAnswerError";
  }
}

export async function answerRunInput(
  prisma: PrismaClient,
  input: AnswerRunInput,
  realtime?: RealtimeFanout,
  runSecretWriter?: RunSecretWriter,
): Promise<boolean> {
  const committed = await prisma.$transaction((tx: Prisma.TransactionClient) =>
    answerRunInputInTransaction(tx, input, runSecretWriter),
  );
  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

type SpawnBotEdit = {
  proposed: Record<string, string>;
  approved: Record<string, string>;
  key: string;
  /** text, detail and spawnBot of the card, rebuilt from the approved request. */
  card: Pick<Extract<MessageBlock, { kind: "ask" }>, "text" | "detail" | "spawnBot">;
};

/**
 * What a Create bot card becomes when the owner edited it: validated exactly like the model's own
 * request, with nothing written. Returns undefined when the edits change nothing once normalized.
 */
async function planSpawnBotEdit(
  tx: Prisma.TransactionClient,
  effect: { id: string; request: unknown; idempotencyKey: string },
  edits: { name?: string; instructions?: string },
  scope: { runId: string; spaceId: string; userId: string },
): Promise<SpawnBotEdit | undefined> {
  const request = effect.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new InvalidAnswerError("This bot creation cannot be edited");
  }
  const stored = normalizeSpawnBotArgs(request as Record<string, unknown>);
  if ("error" in stored) throw new InvalidAnswerError(stored.error);
  const proposed = spawnBotToolArgs(stored);
  const edited = normalizeSpawnBotArgs({
    ...(request as Record<string, unknown>),
    ...(edits.name !== undefined ? { name: edits.name } : {}),
    ...(edits.instructions !== undefined ? { instructions: edits.instructions } : {}),
  });
  if ("error" in edited) throw new InvalidAnswerError(edited.error);
  const approved = spawnBotToolArgs(edited);
  if (approved.name === proposed.name && approved.instructions === proposed.instructions) {
    return undefined;
  }
  const invalid = validateSpawnBotArgs(approved, await activeBotNames(tx, scope));
  if (invalid) throw new InvalidAnswerError(invalid);
  const key = approvalEffectKey(scope.runId, "spawn_bot", approved);
  const taken = await tx.externalEffect.findUnique({
    where: { idempotencyKey: key },
    select: { id: true },
  });
  if (taken) {
    throw new InvalidAnswerError("This run already has a bot creation with these exact settings");
  }
  const { text, detail, spawnBot } = spawnBotApprovalBlock(effect.id, approved, scope.userId);
  return { proposed, approved, key, card: { text, detail, spawnBot } };
}

type AskCard = Extract<MessageBlock, { kind: "ask" }>;

/**
 * What answering a draft card writes: Send approves the request with the user's edits written
 * where the bot's message sat, Discard denies it. The key never changes, so the bot's own call
 * finds the effect.
 */
function planDraftAnswer(
  effect: { request: unknown },
  draft: DraftRecord,
  input: Pick<AnswerRunInput, "answer" | "edits">,
  card: AskCard,
  shownProposal: unknown,
) {
  if (input.edits?.name !== undefined || input.edits?.instructions !== undefined) {
    throw new InvalidAnswerError("Only the message can be edited");
  }
  if (input.answer !== "allow") {
    return { data: { status: "denied", draft: draftWithState(draft, { state: "discarded" }) } };
  }
  const before = draftMessage(effect.request, draft);
  const edits: AskDraftEdits = {
    text: input.edits?.text ?? before.body,
    recipients: input.edits?.recipients,
    subject: input.edits?.subject,
  };
  const edited = editDraftRequest(effect.request, draft, edits);
  if ("error" in edited) throw new InvalidAnswerError(edited.error);
  const after = draftMessage(edited.request, draft);
  const shown = card.draft && {
    ...card.draft,
    ...after,
    recipients: after.recipients ?? card.draft.recipients,
    failure: undefined,
  };
  // The proposal the card was requested with, its run secrets masked, which the stored request
  // may hold unmasked: the audit reads it, now with the user's edits.
  const proposed = proposalRequest(shownProposal, effect.request);
  const proposal = editDraftRequest(proposed, draft, edits);
  return {
    data: {
      status: "approved",
      request: edited.request,
      draft: draftWithState(draft, { state: "approved" }),
    },
    edit:
      JSON.stringify(after) === JSON.stringify(before)
        ? undefined
        : {
            proposed: draftMessage(proposed, draft),
            approved: after,
            proposal: "request" in proposal ? asProposal(proposal.request, effect.request) : {},
            card: shown ? { draft: shown, detail: askDraftDetail(shown) } : {},
          },
  };
}

/** The request inside a logged proposal, which wraps a request that is not an object. */
function proposalRequest(proposal: unknown, request: unknown): unknown {
  return Array.isArray(request) ? valueAt(proposal, ["request"]) : proposal;
}

function asProposal(edited: unknown, request: unknown): Record<string, unknown> {
  const proposal = Array.isArray(request) ? { request: edited } : edited;
  return proposal && typeof proposal === "object" && !Array.isArray(proposal)
    ? (proposal as Record<string, unknown>)
    : {};
}

/**
 * Answer the pending ask of a waiting_input run inside an existing transaction. Called by
 * answerRunInput, and exported so a caller that already holds a transaction can reuse it.
 * Returns null when nothing was awaiting an answer; throws InvalidAnswerError when the run is
 * still waiting but the submitted answer is malformed or incomplete.
 */
export async function answerRunInputInTransaction(
  tx: Prisma.TransactionClient,
  input: AnswerRunInput,
  runSecretWriter?: RunSecretWriter,
): Promise<{ threadId: string; seq: number } | null> {
  {
    // Thread row first, then run rows — the same order as clearThread and finalizeRun, so a
    // concurrent clear cannot deadlock against this transaction.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        status: "waiting_input",
      },
      select: { botId: true, userId: true, checkpoint: true, sessionId: true },
    });
    if (!run) return null;
    const runLog = {
      sessionId: run.sessionId as SessionId,
      botId: run.botId,
      runId: input.runId,
    };
    const card = await latestRunAsk(tx, input.runId);
    if (!card || input.messageId !== card.entryId) return null;
    const { entryId: askId, block: pendingAsk } = card;
    const answerEntry = (text: string) =>
      appendSessionEntryInTransaction(tx, {
        type: "user.message",
        sessionId: runLog.sessionId,
        feedBotId: run.botId,
        payload: {
          blocks: [{ kind: "text", text }],
          replyTo: { entryId: askId },
          source: "card",
          // In a group, whom the bot reads as answering.
          authorId: input.answeredByUserId,
        },
      });
    // Edits only apply to an approval card (a Create bot card or a mail draft), answered "allow"
    // by the run's owner. Checked before any other branch and before any name is read, so the
    // refusal reveals nothing.
    if (input.edits) {
      if (pendingAsk.questions?.length || !isApprovalAskBlock(pendingAsk)) {
        throw new InvalidAnswerError("Only a Create bot card can be edited");
      }
      if (input.answer !== "allow") {
        throw new InvalidAnswerError(
          pendingAsk.draft
            ? "Edits can only be sent with Send"
            : "Edits can only be sent when creating the bot",
        );
      }
      if (input.answeredByUserId !== run.userId) {
        throw new InvalidAnswerError(
          `Only the owner of this run can edit the ${pendingAsk.draft ? "message" : "bot"}`,
        );
      }
    }

    // ask_user v2: a multi-question card submits one JSON payload of per-question answers.
    if (pendingAsk.questions?.length) {
      const questions = pendingAsk.questions;
      let raw: unknown;
      try {
        raw = JSON.parse(input.answer);
      } catch {
        throw new InvalidAnswerError("A multi-question answer must be a JSON payload");
      }
      const container =
        raw && typeof raw === "object" && "answers" in raw
          ? (raw as { answers: unknown }).answers
          : raw;
      if (!container || typeof container !== "object") {
        throw new InvalidAnswerError("A multi-question answer must be an object of answers");
      }
      const submitted = container as Record<
        string,
        { selected?: unknown; other?: unknown; skipped?: unknown } | undefined
      >;
      const lines: string[] = [];
      const storedAnswers: AskAnswers = {};
      for (let index = 0; index < questions.length; index += 1) {
        const question = questions[index]!;
        const entry = submitted[question.id] ?? {};
        const selectedIds = Array.isArray(entry.selected)
          ? Array.from(
              new Set(
                entry.selected
                  .map((id) => String(id))
                  .filter((id) => question.options?.some((option) => option.id === id)),
              ),
            )
          : [];
        // Same defense in depth as `required` below: a single-choice question keeps at most one
        // id, whatever a direct API call submits.
        const selected = question.multiSelect ? selectedIds : selectedIds.slice(0, 1);
        const other = typeof entry.other === "string" ? entry.other.trim() : "";
        if (other.length > ASK_ANSWER_MAX_LENGTH) {
          throw new InvalidAnswerError(`Answer ${index + 1} is too long`);
        }
        const answered = selected.length > 0 || other.length > 0;
        // Only the question's own `required` flag decides whether it may be skipped — a
        // client-asserted `skipped` cannot waive a required question (defense in depth: the
        // UI already gates Send, but a direct API call must not resume with a hole).
        const skipped = !answered && question.required === false;
        if (!answered && !skipped) {
          throw new InvalidAnswerError(`Question ${index + 1} needs an answer`);
        }
        const labels = selected.map(
          (id) => question.options?.find((option) => option.id === id)?.label ?? id,
        );
        if (other) labels.push(`Other: ${other}`);
        lines.push(
          `${index + 1}. ${question.question} — ${skipped ? "(skipped)" : labels.join(", ")}`,
        );
        storedAnswers[question.id] = {
          ...(selected.length ? { selected } : {}),
          ...(other ? { other } : {}),
          ...(skipped ? { skipped: true } : {}),
        };
      }
      const queued = await tx.run.updateMany({
        where: {
          id: input.runId,
          spaceId: input.spaceId,
          threadId: input.threadId,
          status: "waiting_input",
        },
        data: { status: "queued", checkpoint: null },
      });
      if (queued.count !== 1) return null;
      const task = await tx.task.updateMany({
        where: { runs: { some: { id: input.runId } } },
        data: {
          prompt: `The user answered your questions:\n${lines.join("\n")}\n\n${RESUME_DELTA_RULE}`,
        },
      });
      if (task.count !== 1) throw new Error("Run task was not available to answer");
      await appendCardStateInTransaction(tx, {
        type: "card.answered",
        feedBotId: run.botId,
        payload: { target: askId, answers: storedAnswers },
      });
      await answerEntry(lines.join("\n"));
      return { threadId: input.threadId, seq: await threadEventSeq(tx, input.threadId) };
    }

    const approvalAsk = isApprovalAskBlock(pendingAsk);
    const secretAsk = isSecretAskBlock(pendingAsk);
    const choiceAsk = !approvalAsk && !secretAsk && Boolean(pendingAsk.actions?.length);
    const selectedChoice = choiceAsk
      ? pendingAsk.actions?.find((action) => action.id === input.answer)
      : undefined;
    // A choice ask also accepts a free-text answer ("none of the above" typed in the composer):
    // the offered options are a convenience, never a constraint on what the user may say.
    const freeTextAnswer = choiceAsk && !selectedChoice ? input.answer.trim() : "";
    if (choiceAsk && !selectedChoice && !freeTextAnswer) {
      throw new InvalidAnswerError("Pick one of the offered choices or type an answer");
    }
    if (
      !approvalAsk &&
      !secretAsk &&
      !selectedChoice &&
      input.answer.trim().length > ASK_ANSWER_MAX_LENGTH
    ) {
      throw new InvalidAnswerError("This answer is too long");
    }
    if (secretAsk && !runSecretWriter) return null;
    if (secretAsk && pendingAsk.credential && run.userId !== input.answeredByUserId) return null;
    let approvalEffect: {
      id: string;
      kind: string;
      status: string;
      request: unknown;
      draft: unknown;
      idempotencyKey: string;
    } | null = null;
    let approvalUserId: string | null = null;
    let spawnBotEdit: SpawnBotEdit | undefined;
    let draftAnswer: ReturnType<typeof planDraftAnswer> | undefined;

    if (approvalAsk) {
      if (!pendingAsk.actions?.some((action) => action.id === input.answer)) return null;
      approvalEffect = await tx.externalEffect.findFirst({
        where: {
          id: pendingAsk.approvalEffectId,
          spaceId: input.spaceId,
          runId: input.runId,
          status: "intended",
        },
      });
      if (!approvalEffect) return null;
      const draft = readDraft(approvalEffect.status, approvalEffect.draft);
      // A mail draft leaves in the owner's name: nobody else may send, edit or discard it.
      if (draft && run.userId !== input.answeredByUserId) return null;
      if (input.answer === "always") {
        if (draft || run.userId !== input.answeredByUserId) return null;
        approvalUserId = input.answeredByUserId;
      }
      if (draft) {
        const requested = await tx.sessionEntry.findUnique({
          where: { id: askId },
          select: { payload: true },
        });
        draftAnswer = planDraftAnswer(
          approvalEffect,
          draft,
          input,
          pendingAsk,
          (requested?.payload as { proposal?: unknown } | null)?.proposal,
        );
      } else if (input.edits) {
        const { text, recipients, subject } = input.edits;
        if (text !== undefined || recipients !== undefined || subject !== undefined) {
          throw new InvalidAnswerError("Only a mail draft's message can be edited");
        }
        if (approvalEffect.kind !== "spawn_bot") {
          throw new InvalidAnswerError("Only a Create bot card can be edited");
        }
        spawnBotEdit = await planSpawnBotEdit(tx, approvalEffect, input.edits, {
          runId: input.runId,
          spaceId: input.spaceId,
          userId: run.userId,
        });
      }
    }

    const queued = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        status: "waiting_input",
      },
      data: {
        status: "queued",
        ...(choiceAsk ? { checkpoint: null } : {}),
      },
    });
    if (queued.count !== 1) return null;

    if (approvalAsk) {
      const allowed = input.answer === "allow" || input.answer === "always";
      if (spawnBotEdit || draftAnswer) {
        // Compare-and-set: only the effect the plan was made from may be rewritten. Anything
        // else throws, which rolls back the run update above and leaves the card pending.
        const rewritten = await tx.externalEffect.updateMany({
          where: {
            id: approvalEffect!.id,
            status: "intended",
            idempotencyKey: approvalEffect!.idempotencyKey,
          },
          data: {
            ...(spawnBotEdit
              ? {
                  request: spawnBotEdit.approved,
                  idempotencyKey: spawnBotEdit.key,
                  status: "approved",
                }
              : (draftAnswer!.data as Prisma.ExternalEffectUpdateManyMutationInput)),
            answeredAt: new Date(),
          },
        });
        if (rewritten.count !== 1) throw new Error("Bot creation changed while it was edited");
      } else {
        await tx.externalEffect.update({
          where: { id: approvalEffect!.id },
          data: { status: allowed ? "approved" : "denied", answeredAt: new Date() },
        });
      }
      if (input.answer === "always") {
        await tx.actionApprovalRule.upsert({
          where: {
            spaceId_createdByUserId_effect_matchKind_matchValue: {
              spaceId: input.spaceId,
              createdByUserId: approvalUserId!,
              effect: "always_allow",
              matchKind: "tool",
              matchValue: approvalEffect!.kind,
            },
          },
          create: {
            spaceId: input.spaceId,
            createdByUserId: approvalUserId!,
            effect: "always_allow",
            matchKind: "tool",
            matchValue: approvalEffect!.kind,
          },
          update: {},
        });
      }
    } else if (secretAsk) {
      await runSecretWriter!.store({
        botId: run.botId,
        credential: pendingAsk.credential,
        runId: input.runId,
        userId: run.userId,
        spaceId: input.spaceId,
        plaintext: input.answer,
        tx,
      });
      await tx.externalEffect.updateMany({
        where: {
          runId: input.runId,
          spaceId: input.spaceId,
          kind: "request_secret",
          status: "intended",
        },
        data: {
          status: "approved",
          ...(pendingAsk.credential ? { result: { credentialSaved: pendingAsk.credential } } : {}),
        },
      });
    } else {
      const resumeLabel = selectedChoice
        ? resumeChoiceLabel(selectedChoice, run.checkpoint)
        : undefined;
      const task = await tx.task.updateMany({
        where: { runs: { some: { id: input.runId } } },
        data: {
          prompt: `${
            selectedChoice
              ? `Selected choice ${selectedChoice.id}: ${resumeLabel}`
              : freeTextAnswer
                ? `Free-text answer (none of the offered choices): ${freeTextAnswer}`
                : input.answer
          }\n\n${RESUME_DELTA_RULE}`,
        },
      });
      if (task.count !== 1) throw new Error("Run task was not available to answer");
    }

    const answeredAsk = {
      ...pendingAsk,
      ...(spawnBotEdit ? spawnBotEdit.card : {}),
      ...draftAnswer?.edit?.card,
      status: "answered" as const,
      answer: secretAsk ? "" : freeTextAnswer || input.answer,
    };
    if (approvalEffect) {
      const effectId = approvalEffect.id;
      const edited = spawnBotEdit?.approved ?? draftAnswer?.edit?.proposal;
      if (edited) {
        await appendSessionEntryInTransaction(tx, {
          ...runLog,
          type: "effect.edited",
          payload: { effectId, proposal: edited, card: answeredAsk },
        });
      }
      await appendSessionEntryInTransaction(tx, {
        ...runLog,
        type: "effect.resolved",
        payload: {
          effectId,
          decision: input.answer === "allow" || input.answer === "always" ? "approved" : "denied",
          answerId: input.answer,
        },
      });
    } else {
      await appendCardStateInTransaction(tx, {
        type: "card.answered",
        feedBotId: run.botId,
        payload: { target: askId, answer: answeredAsk.answer },
      });
      if (!secretAsk) await answerEntry(selectedChoice?.label ?? (freeTextAnswer || input.answer));
    }
    const audit = spawnBotEdit ?? draftAnswer?.edit;
    if (audit) {
      // The audit keeps what the model proposed next to what the person approved.
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: run.botId,
        type: "effect.edited",
        runId: input.runId,
        payload: {
          effectId: approvalEffect!.id,
          proposed: audit.proposed,
          approved: audit.approved,
        },
      });
    }
    return { threadId: input.threadId, seq: await threadEventSeq(tx, input.threadId) };
  }
}

export interface ResumeAskWithComposerTextInput {
  spaceId: string;
  threadId: string;
  runId: string;
  /** Free text typed in the main composer while the run is parked on an ask. */
  text: string;
}

/** Reconciliation happens at the next agent turn, never inside this transaction (spec §3/§5). */
export type ResumeAskWithComposerTextResult =
  | {
      resolvable: true;
      runId: string;
    }
  | { resolvable: false };

/**
 * Builds the resume prompt: the user's raw composer text, plus (for a multi-question card) the
 * still-open questions so the model can map what applies and only re-ask the remainder — never a
 * structured re-ask of the whole batch.
 */
function buildComposerResumePrompt(text: string, questions: AskQuestion[] | undefined): string {
  if (!questions?.length) {
    return `The user replied in the composer instead of the ask card:\n${text}\n\n${RESUME_DELTA_RULE}`;
  }
  const lines = questions.map((question, index) => `${index + 1}. ${question.question}`);
  return [
    "The user replied in the composer instead of the ask card:",
    text,
    "",
    "Pending questions (offered as a convenience, not a constraint): map what the reply already",
    "answers, only re-ask what's genuinely left uncovered, and pivot instead of re-asking if the",
    "reply asks for something else entirely.",
    ...lines,
    "",
    RESUME_DELTA_RULE,
  ].join("\n");
}

/**
 * Resolves a pending ask_user card with the main composer's free text instead of the card's own
 * UI (spec `ask-answer-via-composer`, PR 1). Unlike `answerRunInputInTransaction`'s
 * `questions[]` branch, this never JSON-parses the answer and never requires full question
 * coverage — the model reconciles prose against the pending questions at the next agent turn.
 *
 * Approval and secret asks are refused outright (`resolvable: false`, zero writes): this
 * function never calls `externalEffect.update` or `RunSecretWriter.store`, so even a
 * classification bug can at worst leave the run blocked, never approve an effect or store a
 * secret (threat model T1/T2). The caller is expected to throw `CONFLICT` on `resolvable: false`,
 * preserving today's "answer the pending ask first" guard for those two types and for a run whose
 * last bot message carries no resolvable pending ask.
 */
export async function resumeAskWithComposerTextInTransaction(
  tx: Prisma.TransactionClient,
  input: ResumeAskWithComposerTextInput,
): Promise<ResumeAskWithComposerTextResult> {
  const run = await tx.run.findFirst({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    select: { botId: true },
  });
  if (!run) return { resolvable: false };

  const card = await latestRunAsk(tx, input.runId);
  if (!card) return { resolvable: false };
  const { entryId: askEntryId, block: pendingAsk } = card;

  // Approval and secret asks stay blocked in PR 1 — classification reuses the same audited
  // helpers `answerRunInputInTransaction` already relies on (packages/core/action-approval.ts).
  if (isApprovalAskBlock(pendingAsk) || isSecretAskBlock(pendingAsk)) {
    return { resolvable: false };
  }

  const text = input.text.trim();
  if (!text) return { resolvable: false };

  const queued = await tx.run.updateMany({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    data: { status: "queued", checkpoint: null },
  });
  if (queued.count !== 1) return { resolvable: false };

  const task = await tx.task.updateMany({
    where: { runs: { some: { id: input.runId } } },
    data: { prompt: buildComposerResumePrompt(text, pendingAsk.questions) },
  });
  if (task.count !== 1) throw new Error("Run task was not available to answer");

  // Answered without echoing the reply onto the card: the user's words already live in their own
  // message bubble right below, so an `answer` here would duplicate them (design D2), and the card
  // renders a plain resolved "Answered" state.
  await appendCardStateInTransaction(tx, {
    type: "card.answered",
    feedBotId: run.botId,
    payload: { target: askEntryId },
  });
  return { resolvable: true, runId: input.runId };
}

/** A waiting mail draft as the user left it, named by its card's entry. */
export type DraftLeft = AskDraftEdits & { messageId: string; text: string };

export interface DismissProposalWithTextInput {
  spaceId: string;
  threadId: string;
  runId: string;
  /** Who typed: only the run's own user puts its card away. */
  userId: string;
  /** A mail draft as the user left it on the card they typed over, named by its entry. */
  draft?: DraftLeft;
  /** Put away only a mail draft, as in a group, where other approval cards wait for a tap. */
  draftsOnly?: true;
}

/**
 * `dismissed`: the card is put away and the run queued again on its checkpoint. `settled`: a tap
 * answered the proposal card first, the run goes on, and the caller steers the message into it.
 * `keep`: not a card a reply puts away; the caller applies the usual rule.
 */
export type DismissProposalWithTextResult =
  | { outcome: "dismissed"; status: "queued" }
  | { outcome: "settled"; status: string }
  | { outcome: "keep" };

const STEERABLE_AFTER_ANSWER = new Set(["queued", "leased", "running"]);

/**
 * Puts away a proposal or mail draft card the user answered by typing instead of tapping. Separate
 * from resumeAskWithComposerTextInTransaction, which never writes an effect. The card's kind is
 * read from the stored effect, never from the block; the only transition written is
 * intended → denied, marked dismissed so no guard counts it as a no. The run keeps its checkpoint:
 * the pending call resumes and reads that it was dismissed, then the typed message steers it. A
 * mail draft ends replaced, never sent, its body set to the text the user left on that card; the
 * run logs that as the draft call's result when it resumes.
 */
export async function dismissProposalWithTextInTransaction(
  tx: Prisma.TransactionClient,
  input: DismissProposalWithTextInput,
): Promise<DismissProposalWithTextResult> {
  // Thread row first, then run rows: the order answerRunInputInTransaction takes, so a tap on the
  // card and this reply run one after the other.
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
  const run = await tx.run.findFirst({
    where: { id: input.runId, spaceId: input.spaceId, threadId: input.threadId },
    select: { botId: true, userId: true, status: true, sessionId: true },
  });
  if (!run || run.userId !== input.userId) return { outcome: "keep" };
  const waiting = run.status === "waiting_input";
  // A tap that came first answered the card: the reply steers its run only if it was a proposal.
  const card = await latestRunAsk(tx, input.runId);
  if (!card || !isApprovalAskBlock(card.block)) return { outcome: "keep" };
  const pendingAsk = card.block;
  const effect = await tx.externalEffect.findFirst({
    where: { id: pendingAsk.approvalEffectId, spaceId: input.spaceId, runId: input.runId },
    select: { id: true, kind: true, status: true, request: true, draft: true },
  });
  if (!effect) return { outcome: "keep" };
  const draft = readDraft(effect.status, effect.draft);
  if (!draft && (input.draftsOnly || !DISMISSABLE_EFFECT_KINDS.has(effect.kind))) {
    return { outcome: "keep" };
  }
  // A tap answered the card first: the reply steers its run, and a draft's text is moot.
  if (!waiting) {
    return STEERABLE_AFTER_ANSWER.has(run.status)
      ? { outcome: "settled", status: run.status }
      : { outcome: "keep" };
  }
  const replacing = draft?.state === "pending";
  // A text is only ever for the very draft card it was edited on.
  if (input.draft && (!replacing || input.draft.messageId !== card.entryId)) {
    return { outcome: "keep" };
  }
  if (draft && !replacing) return { outcome: "keep" };
  // Nothing leaves a replaced draft, so its text may be left empty; its recipients and subject
  // are checked as on Send, since the bot reads them back.
  const left =
    replacing && input.draft
      ? editDraftRequest(withValueAt(effect.request, draft.path, input.draft.text), draft, {
          recipients: input.draft.recipients,
          subject: input.draft.subject,
        })
      : { request: effect.request };
  // A request with no place for the text is no longer this draft's: the usual rule applies.
  if ("error" in left && left.error === DRAFT_GONE) return { outcome: "keep" };
  if ("error" in left) throw new InvalidAnswerError(left.error);
  const { request } = left;
  const replaced = replacing ? draftWithState(draft, { state: "replaced" }) : undefined;
  const dismissed = await tx.externalEffect.updateMany({
    where: replaced
      ? { id: effect.id, status: "intended" }
      : { id: effect.id, status: "intended", kind: { in: [...DISMISSABLE_EFFECT_KINDS] } },
    data: replaced
      ? {
          status: "denied",
          answeredAt: new Date(),
          request: request as Prisma.InputJsonValue,
          draft: replaced,
        }
      : { status: "denied", answeredAt: new Date(), result: DISMISSED_EFFECT_RESULT },
  });
  // Answered while the run still waits: steering into it would reach a run that never wakes, so
  // the caller keeps the usual pending-card rule.
  if (dismissed.count !== 1) return { outcome: "keep" };
  const queued = await tx.run.updateMany({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    data: { status: "queued" },
  });
  // Under the thread lock both rows move together; anything else rolls the effect back too.
  if (queued.count !== 1) throw new Error("The run changed while its card was put away");
  await appendSessionEntryInTransaction(tx, {
    type: "effect.resolved",
    sessionId: run.sessionId as SessionId,
    botId: run.botId,
    runId: input.runId,
    payload: { effectId: effect.id, decision: "denied", dismissed: true },
  });
  return { outcome: "dismissed", status: "queued" };
}

export async function pauseRunForInput(
  prisma: PrismaClient,
  input: PauseRunForInput,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Thread row first, then run rows — the same order as clearThread and finalizeRun, so a
    // concurrent clear cannot deadlock against this transaction.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: "waiting_input",
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(input.offeredActions?.length
          ? { checkpoint: choiceAskCheckpoint(input.offeredActions) }
          : {}),
        ...(input.browserApprovalCheckpoint
          ? { checkpoint: JSON.stringify(input.browserApprovalCheckpoint) }
          : {}),
      },
    });
    if (paused.count !== 1) return null;
    const hold = input.browserApprovalCheckpoint;
    if (hold?.lease) {
      const retained = await tx.computerExecutionLease.updateMany({
        where: { ...hold.lease, expiresAt: { gt: new Date() } },
        data: { expiresAt: new Date(hold.deadline) },
      });
      if (retained.count !== 1) throw new Error("The browser approval lost its computer lease");
    }

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        // A run can park during setup, before its runtime starts: a draft the user approved that
        // did not leave is asked about again before any turn.
        status: { in: ["setting_up", "running"] },
      },
      data: { status: "waiting_input", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    if (input.effect?.reopen) {
      const reopened = await tx.externalEffect.updateMany({
        where: { id: input.effect.id, status: { in: ["approved", "executing"] } },
        data: { status: "intended", draft: input.effect.reopen },
      });
      if (reopened.count !== 1) throw new Error("The draft changed before it was shown again");
    }
    if (input.effect) {
      const { sessionId } = await tx.run.findUniqueOrThrow({
        where: { id: input.runId },
        select: { sessionId: true },
      });
      await markThreadsUnread(tx, [input.threadId]);
      await appendSessionEntryInTransaction(tx, {
        type: "effect.requested",
        sessionId: sessionId as SessionId,
        botId: input.botId,
        runId: input.runId,
        payload: {
          effectId: input.effect.id,
          effectKind: input.effect.kind,
          proposal: input.effect.proposal,
          card: input.blocks.find((block) => block.kind === "ask"),
        },
      });
    } else {
      await createBotMessageInTransaction(tx, {
        threadId: input.threadId,
        botId: input.botId,
        runId: input.runId,
        blocks: input.blocks,
      });
    }
    if (input.pausedCall) {
      const { sessionId, callId, output, ...log } = input.pausedCall;
      await appendSessionEntryInTransaction(tx, {
        ...log,
        sessionId: sessionId as SessionId,
        type: "tool.result",
        payload: { callId, output, isError: false, artifactIds: [] },
      });
    }
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    return { threadId: input.threadId, seq: await threadEventSeq(tx, input.threadId) };
  });

  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

/**
 * A background helper waits on a question to the bot that started it, with its attempt parked and
 * its resources still held. The question wakes the bot once no turn of it runs; no card and no
 * notification reach the person. Null when the attempt no longer holds the run, else the run the
 * question woke.
 */
export async function pauseRunForParent(
  prisma: PrismaClient,
  input: PauseRunForParent,
): Promise<{ wokenRunId: string | null } | null> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        trigger: "helper",
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: { status: "waiting_input", leaseOwner: null, leaseExpiresAt: null },
    });
    if (paused.count !== 1) return null;
    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "waiting_input", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");
    const { sessionId } = await tx.thread.findUniqueOrThrow({
      where: { id: input.threadId },
      select: { sessionId: true },
    });
    await appendSessionEntryInTransaction(tx, {
      type: "helper.question",
      sessionId: sessionId as SessionId,
      botId: input.botId,
      payload: { helperId: input.runId, question: input.question },
    });
    return { wokenRunId: await createSteeringContinuation(tx, input) };
  });
}

/**
 * What a bot sends one of its background helpers in the thread. A helper waiting on its question
 * takes it as the answer, the result of its `ask_parent` call, and queues to resume; a working one
 * reads it as steering in its own session.
 */
export async function messageHelper(
  prisma: PrismaClient,
  input: { threadId: string; botId: string; helperId: string; text: string },
): Promise<"answered" | "steered" | "ended" | "unknown"> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const helper = await tx.run.findFirst({
      where: {
        id: input.helperId,
        threadId: input.threadId,
        botId: input.botId,
        trigger: "helper",
      },
      select: { status: true, sessionId: true, userId: true },
    });
    if (!helper) return "unknown";
    const sessionId = helper.sessionId as SessionId;
    if (helper.status === "waiting_input") {
      const asked = await tx.sessionEntry.findFirstOrThrow({
        where: {
          sessionId,
          runId: input.helperId,
          type: "tool.call",
          payload: { path: ["name"], equals: "ask_parent" },
        },
        orderBy: { seq: "desc" },
        select: { payload: true },
      });
      await appendSessionEntryInTransaction(tx, {
        type: "tool.result",
        sessionId,
        botId: input.botId,
        runId: input.helperId,
        payload: {
          callId: (asked.payload as { callId: string }).callId,
          output: input.text,
          isError: false,
          artifactIds: [],
        },
      });
      await tx.run.update({ where: { id: input.helperId }, data: { status: "queued" } });
      return "answered";
    }
    if (!isWorkingStatus(helper.status)) return "ended";
    const message = await appendSessionEntryInTransaction(tx, {
      type: "user.message",
      sessionId,
      botId: input.botId,
      payload: { blocks: [{ kind: "text", text: input.text }], source: "parent" },
    });
    await tx.steeringMessage.create({
      data: {
        messageId: message.id,
        botId: input.botId,
        userId: helper.userId,
        runId: input.helperId,
      },
    });
    return "steered";
  });
}

/** Whether the bot's computer control belongs to the person whose run is pausing. */
async function controlIsRunPersons(
  tx: Prisma.TransactionClient,
  controlRunId: string | null,
  input: { runId: string; botId: string },
): Promise<boolean> {
  const [run, holder] = await Promise.all([
    tx.run.findUnique({ where: { id: input.runId }, select: { userId: true } }),
    controlRunId
      ? tx.run.findUnique({ where: { id: controlRunId }, select: { userId: true } })
      : tx.bot.findUnique({ where: { id: input.botId }, select: { userId: true } }),
  ]);
  return Boolean(run && run.userId === holder?.userId);
}

export async function pauseRunForTakeover(
  prisma: PrismaClient,
  input: PauseRunForTakeover,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: "waiting_takeover",
        leaseOwner: null,
        leaseExpiresAt: null,
        checkpoint: null,
      },
    });
    if (paused.count !== 1) return null;

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "waiting_takeover", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    const now = new Date();
    // Serialize with concurrent computer/takeover grants that mutate the same row.
    await tx.$queryRaw`
      SELECT id FROM computers WHERE id = ${input.computerId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    const computer = await tx.computer.findFirst({
      where: { id: input.computerId, spaceId: input.spaceId },
      select: {
        controlHolder: true,
        controlBotId: true,
        controlLeaseId: true,
        controlLeaseExpiresAt: true,
        controlRunId: true,
      },
    });
    const activeUserLease = Boolean(
      computer?.controlHolder === "user" &&
        computer.controlLeaseId &&
        computer.controlLeaseExpiresAt &&
        computer.controlLeaseExpiresAt.getTime() > now.getTime(),
    );
    // Keep an active same-bot user lease so Skip / I'm done appear immediately, when it is the
    // pausing run's person's: control taken by hand is the owner's, control taken for a run is
    // that run's person's. On a shared bot, another person's lease is kept like another bot's.
    // Preserve another bot's active lease — computer/takeover owns revocation. Do not attach
    // this run to that lease: release validates controlBotId and could clear the binding without
    // resuming the waiting run. The requesting bot's takeover flow binds it after revocation.
    // Otherwise clear stale control, but bind controlRunId so takeoverRequested is true.
    const sameBotLease = Boolean(activeUserLease && computer?.controlBotId === input.botId);
    const retainControl =
      sameBotLease && (await controlIsRunPersons(tx, computer?.controlRunId ?? null, input));
    const preserveForeignLease = Boolean(
      activeUserLease && computer?.controlBotId && !retainControl,
    );
    const marked = await tx.computer.updateMany({
      where: { id: input.computerId, spaceId: input.spaceId },
      data: retainControl
        ? { state: "running", controlRunId: input.runId }
        : preserveForeignLease
          ? { state: "running" }
          : {
              state: "running",
              controlHolder: "none",
              controlLeaseId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: input.runId,
            },
    });
    if (marked.count !== 1) throw new Error("Computer was not available to mark for takeover");

    const waitingEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "computer.takeover.requested",
      runId: input.runId,
      payload: {
        reason: input.reason,
        takeoverRequested: true,
        retainedControl: retainControl,
      },
    });
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    return { threadId: waitingEvent.threadId, seq: waitingEvent.seq };
  });

  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

export async function finalizeComputerControlRelease(
  prisma: PrismaClient,
  input: FinalizeComputerControlReleaseInput,
  realtime?: RealtimeFanout,
): Promise<FinalizeComputerControlReleaseResult | false> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // The bot's thread before the computer and the run, the order a stop and a grant take. A
    // member's run on a shared bot waits in their own thread with it, never the owner's.
    const memberThread = input.runId
      ? await tx.thread.findFirst({
          where: { memberBotId: input.botId, runs: { some: { id: input.runId } } },
          select: { id: true },
        })
      : null;
    const [thread] = memberThread
      ? await tx.$queryRaw<Array<{ id: string; sessionId: string }>>`
          SELECT id, "sessionId" FROM threads WHERE id = ${memberThread.id} FOR UPDATE`
      : await tx.$queryRaw<Array<{ id: string; sessionId: string }>>`
          SELECT threads.id, threads."sessionId" FROM threads JOIN bots ON bots.id = threads."botId"
          WHERE bots.id = ${input.botId} AND bots."spaceId" = ${input.spaceId}
          FOR UPDATE OF threads`;
    // Control taken by hand gives the screen to a run of the bot that already waits for a
    // takeover: on a shared bot, a member's run that paused while its owner had the screen.
    const waiting = input.runId ? null : await waitingTakeoverRun(tx, input);
    const cleared = await tx.computer.updateMany({
      where: {
        id: input.computerId,
        spaceId: input.spaceId,
        controlBotId: input.botId,
        controlLeaseId: input.leaseId,
        controlRunId: input.runId,
      },
      data: {
        controlHolder: input.holder,
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: waiting?.id ?? null,
      },
    });
    if (cleared.count !== 1) return null;

    const checkpoint =
      input.reason === "skipped" || input.reason === "expired" ? "takeover-skipped" : "takeover";
    const resumed = input.runId
      ? await tx.run.updateMany({
          where: {
            id: input.runId,
            spaceId: input.spaceId,
            botId: input.botId,
            status: "waiting_takeover",
          },
          data: {
            status: "queued",
            checkpoint,
          },
        })
      : { count: 0 };
    // A steered continue may already hold the run as leased/running. Stamp the
    // checkpoint without stealing the lease so the worker can restore tools.
    const stamped =
      input.runId && resumed.count !== 1
        ? await tx.run.updateMany({
            where: {
              id: input.runId,
              spaceId: input.spaceId,
              botId: input.botId,
              status: { in: ["leased", "running"] },
            },
            data: { checkpoint },
          })
        : { count: 0 };
    const runId = resumed.count === 1 || stamped.count === 1 ? input.runId : null;

    if (!thread) return { threadId: null, seq: null, runId, waiting };
    await appendComputerControlInTransaction(tx, {
      sessionId: thread.sessionId as SessionId,
      botId: input.botId,
      holder: "bot",
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: thread.id,
      botId: input.botId,
      runId: runId ?? undefined,
      type: "computer.takeover.released",
      payload: {
        holder: input.holder,
        leaseId: input.leaseId,
        reason: input.reason,
      },
    });
    return { threadId: event.threadId, seq: event.seq, runId, waiting };
  });

  if (!committed) return false;
  if (committed.threadId && committed.seq !== null) {
    await notifyRealtime(realtime, committed.threadId, committed.seq);
  }
  // After the commit, so this thread's lock never waits behind the computer's.
  if (committed.waiting && committed.waiting.threadId !== committed.threadId) {
    await appendEvent(
      prisma,
      {
        spaceId: input.spaceId,
        threadId: committed.waiting.threadId,
        botId: input.botId,
        runId: committed.waiting.id,
        type: "computer.status",
        payload: { status: "running" },
      },
      realtime,
    );
  }
  return { runId: committed.runId };
}

/** The bot's run that holds its computer and waits for someone to take over the screen. */
async function waitingTakeoverRun(
  tx: Prisma.TransactionClient,
  input: { computerId: string; botId: string; spaceId: string },
) {
  const lease = await tx.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId: input.computerId, botId: input.botId } },
    select: { runId: true },
  });
  if (!lease) return null;
  return tx.run.findFirst({
    where: {
      id: lease.runId,
      spaceId: input.spaceId,
      botId: input.botId,
      status: "waiting_takeover",
    },
    select: { id: true, threadId: true },
  });
}

export async function appendEvent(
  prisma: PrismaClient,
  input: AppendEventInput,
  realtime?: RealtimeFanout,
): Promise<ProductEvent> {
  const event = await prisma.$transaction((tx: Prisma.TransactionClient) =>
    appendEventInTransaction(tx, input),
  );
  const productEvent = mapProductEvent(event);
  await notifyRealtime(realtime, event.threadId, event.seq);
  return productEvent;
}

export async function finalizeRun(
  prisma: PrismaClient,
  input: FinalizeRunInput,
  realtime?: RealtimeFanout,
): Promise<FinalizeRunResult | false> {
  const committed = await withTransactionRetry(() => finalizeRunOnce(prisma, input));
  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return { continuationRunId: committed.continuationRunId };
}

/** Stamps one turn-level wall-clock duration on the final tool block. */
export function completedRunBlocks(
  blocks: MessageBlock[],
  startedAt: Date | null,
  completedAt: Date,
): MessageBlock[] {
  if (!startedAt) return blocks;
  const durationMs = completedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(durationMs) || durationMs < 0) return blocks;
  const index = blocks.findLastIndex((block) => block.kind === "steps");
  if (index < 0) return blocks;
  return blocks.map((block, blockIndex) =>
    blockIndex === index && block.kind === "steps"
      ? { ...block, durationMs: Math.round(durationMs) }
      : block,
  );
}

/** How much of a background helper's final answer its parent reads. */
const HELPER_REPORT_MAX_CHARS = 4_000;

async function finalizeRunOnce(
  prisma: PrismaClient,
  input: FinalizeRunInput,
): Promise<{ threadId: string; seq: number; continuationRunId: string | null } | null> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    let writableRun: { startedAt: Date | null } | undefined;
    try {
      writableRun = await assertRunCanWriteHistory(tx, input.runId);
    } catch (error) {
      if (error instanceof RunHistoryWriteError) return null;
      throw error;
    }
    const now = new Date();
    const terminal = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        taskId: input.taskId,
        OR: [
          { status: "running", leaseOwner: input.leaseOwner },
          ...(input.outcome === "failed"
            ? [
                {
                  status: { in: ["waiting_input", "waiting_takeover"] },
                  OR: [{ leaseOwner: input.leaseOwner }, { leaseOwner: null }],
                },
              ]
            : []),
        ],
        leaseFence: input.leaseFence,
      },
      data: {
        status: input.outcome,
        error: input.outcome === "failed" ? input.error : null,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (terminal.count !== 1) return null;
    const ended = await tx.run.findUniqueOrThrow({
      where: { id: input.runId },
      select: { trigger: true, helper: true, historyThroughSeq: true },
    });
    // A background helper's end is news for its parent only, never for the person.
    const background = ended.trigger === "helper";

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: {
          in:
            input.outcome === "failed"
              ? ["setting_up", "running", "waiting_input", "waiting_takeover"]
              : ["setting_up", "running"],
        },
      },
      data: {
        status: input.outcome,
        error: input.outcome === "failed" ? input.error : null,
        finishedAt: now,
      },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to finalize");

    const task = await tx.task.updateMany({
      where: {
        id: input.taskId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
      },
      data: { status: input.outcome },
    });
    if (task.count !== 1) throw new Error("Run task was not available to finalize");

    if (input.outcome === "completed") {
      const completedBlocks = completedRunBlocks(input.blocks, writableRun?.startedAt ?? null, now);
      if (completedBlocks.length > 0) {
        await createBotMessageInTransaction(tx, {
          threadId: input.threadId,
          botId: input.botId,
          runId: input.runId,
          blocks: completedBlocks,
          markUnread: background ? false : input.markUnread,
        });
      }
      if (input.publicBlocks?.length) {
        await createBotMessageInTransaction(tx, {
          threadId: input.threadId,
          botId: input.botId,
          runId: input.runId,
          blocks: input.publicBlocks,
          toPerson: true,
          markUnread: input.markUnread,
        });
      }
    }
    // A background helper outlives its parent's turn.
    const strandedHelpers = await tx.run.findMany({
      where: {
        parentRunId: input.runId,
        trigger: "subagent",
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      select: { id: true, taskId: true },
    });
    await cancelRunsInTransaction(tx, strandedHelpers, now);
    await appendRunFinishedInTransaction(
      tx,
      input.runId,
      input.outcome === "completed"
        ? { status: "completed" }
        : { status: "failed", error: input.error },
      { result: input.outcome === "completed" ? input.result : undefined, recap: input.recap },
    );
    if (background) {
      const { sessionId } = await tx.thread.findUniqueOrThrow({
        where: { id: input.threadId },
        select: { sessionId: true },
      });
      const report = input.outcome === "completed" ? (input.result ?? "") : input.error;
      // What the parent sent after the helper's last read of its history and that it never claimed.
      const unread = await tx.steeringMessage.findMany({
        where: {
          runId: input.runId,
          claimedAt: null,
          message: { seq: { gte: ended.historyThroughSeq ?? 0 } },
        },
        select: { message: { select: { payload: true } } },
        orderBy: { message: { seq: "asc" } },
      });
      await appendSessionEntryInTransaction(tx, {
        type: "helper.report",
        sessionId: sessionId as SessionId,
        botId: input.botId,
        payload: {
          helperId: input.runId,
          profile: ended.helper,
          status: input.outcome,
          report:
            report.length > HELPER_REPORT_MAX_CHARS
              ? `${report.slice(0, HELPER_REPORT_MAX_CHARS)}… truncated`
              : report,
          ...(unread.length
            ? {
                unreadMessages: unread.map((item) =>
                  blocksToAgentHistoryText(blocksOf(item.message)),
                ),
              }
            : {}),
        },
      });
    }
    const lastEvent = background
      ? { threadId: input.threadId, seq: await threadEventSeq(tx, input.threadId) }
      : await appendEventInTransaction(tx, {
          spaceId: input.spaceId,
          threadId: input.threadId,
          botId: input.botId,
          type: input.outcome === "completed" ? "run.completed" : "run.failed",
          runId: input.runId,
          payload: input.outcome === "completed" ? {} : { error: input.error },
        });
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    if (input.outcome === "completed") {
      await tx.steeringMessage.deleteMany({
        where: { runId: input.runId, claimedAt: { not: null } },
      });
      await tx.steeringMessage.updateMany({
        where: { runId: input.runId },
        data: { runId: null },
      });
    } else {
      const { sourceMessage } = await tx.run.findUniqueOrThrow({
        where: { id: input.runId },
        select: { sourceMessage: { select: { seq: true } } },
      });
      // A continuation's source is the newest steering it was created for. Only newer
      // messages justify another run after failure, even if setup failed before claiming.
      await tx.steeringMessage.updateMany({
        where: {
          runId: input.runId,
          message: sourceMessage ? { seq: { gt: sourceMessage.seq } } : undefined,
        },
        data: { runId: null },
      });
    }
    const continuationRunId = await createSteeringContinuation(tx, input);
    // A run with nothing to say leaves the bot's row time on its last visible activity.
    if (!background && (input.outcome === "failed" || input.markUnread !== false)) {
      await tx.bot.update({ where: { id: input.botId }, data: { updatedAt: now } });
    }
    return { threadId: lastEvent.threadId, seq: lastEvent.seq, continuationRunId };
  });
}

type WakeScope = Pick<FinalizeRunBase, "spaceId" | "threadId" | "botId">;

async function createSteeringContinuation(
  tx: Prisma.TransactionClient,
  input: WakeScope,
): Promise<string | null> {
  const active = await tx.run.findFirst({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      ...conversationRunFilter,
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    select: { id: true },
  });
  if (active) return null;
  const pending = await tx.steeringMessage.findMany({
    where: {
      botId: input.botId,
      runId: null,
      message: { session: { threadId: input.threadId, kind: "thread" } },
    },
    include: { message: { select: { id: true } } },
    orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
  });
  const followUp = async (userId: string, prompt: string, sourceMessageId: string | null) => {
    const task = await tx.task.create({
      data: {
        spaceId: input.spaceId,
        botId: input.botId,
        threadId: input.threadId,
        userId,
        prompt,
        status: "queued",
      },
    });
    return tx.run.create({
      data: {
        spaceId: input.spaceId,
        botId: input.botId,
        threadId: input.threadId,
        taskId: task.id,
        userId,
        status: "queued",
        trigger: "follow_up",
        sourceMessageId,
      },
    });
  };
  if (pending.length === 0) {
    // As the source message, the entry would stand in for the prompt and never reach the model.
    if (!(await hasUnreadHelperEntry(tx, input))) return null;
    const { userId } = await tx.thread.findUniqueOrThrow({
      where: { id: input.threadId },
      select: { userId: true },
    });
    const woken = await followUp(userId, "A helper you started wrote back.", null);
    return woken.id;
  }
  const last = pending.at(-1)!;
  const run = await followUp(
    pending[0]!.userId,
    "Respond to the user's steering context.",
    last.message.id,
  );
  await tx.steeringMessage.updateMany({
    where: { id: { in: pending.map((item) => item.id) }, runId: null },
    data: { runId: run.id, claimedAt: null },
  });
  return run.id;
}

/**
 * Whether the bot's newest helper report or question in the thread came after every history its
 * turns read, so no turn has seen it yet. Session seqs order the two without any clock.
 */
async function hasUnreadHelperEntry(tx: Prisma.TransactionClient, input: WakeScope) {
  const report = await tx.sessionEntry.findFirst({
    where: {
      botId: input.botId,
      type: { in: ["helper.report", "helper.question"] },
      session: { threadId: input.threadId, kind: "thread" },
    },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  if (!report) return false;
  const { _max: read } = await tx.run.aggregate({
    where: { threadId: input.threadId, botId: input.botId, ...conversationRunFilter },
    _max: { historyThroughSeq: true },
  });
  return read.historyThroughSeq == null || report.seq >= read.historyThroughSeq;
}

export async function appendEventInTransaction(
  tx: Prisma.TransactionClient,
  input: AppendEventInput,
) {
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: { nextEventSeq: { increment: 1 } },
    select: { nextEventSeq: true },
  });
  await assertRunCanWriteHistory(tx, input.runId);
  // Unpaired UTF-16 surrogates (e.g. a split emoji high half) are invalid JSON for Postgres.
  const payload = sanitizeJsonValue(input.payload);
  return tx.event.create({
    data: {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      seq: thread.nextEventSeq - 1,
      type: input.type,
      payload: payload as Prisma.InputJsonValue,
      runId: input.runId,
    },
  });
}

async function notifyRealtime(
  realtime: RealtimeFanout | undefined,
  threadId: string,
  cursor: number,
): Promise<void> {
  await realtime?.publish(threadTopic(threadId), JSON.stringify({ cursor })).catch(() => undefined);
}

export async function eventsAfter(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  limit?: number,
) {
  return prisma.event.findMany({
    where: { threadId, seq: { gt: cursor } },
    orderBy: { seq: "asc" },
    ...(limit ? { take: limit } : {}),
  });
}

/**
 * A run's progress since the newest of its entries that replaced its live line, as the client's
 * `reduceProgressLayer` does: the tool calls and results it logs as it works keep the line on.
 * A feed event's `runId` is only its first entry's, so each entry is matched.
 */
export async function progressSinceLastEntry(
  prisma: PrismaClient | Prisma.TransactionClient,
  threadId: string,
  runIds: readonly string[],
): Promise<ProductEvent[]> {
  if (runIds.length === 0) return [];
  const rows = await prisma.$queryRaw<Parameters<typeof mapProductEvent>[0][]>`
    WITH cutoff AS (
      SELECT r.id AS "runId", COALESCE((
        SELECT max(a.seq) FROM events a
        WHERE a."threadId" = ${threadId} AND a.type = 'session.entry.appended'
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(a.payload -> 'entries') x
            WHERE x ->> 'runId' = r.id AND x ->> 'type' <> ALL(${[...RUN_WORK_TYPES]}::text[]))
      ), -1) AS seq
      FROM (SELECT DISTINCT unnest(${[...runIds]}::text[]) AS id) r)
    SELECT e.id, e."spaceId", e."threadId", e."botId", e.seq, e.type, e.payload, e."runId",
      e."createdAt"
    FROM events e JOIN cutoff c ON c."runId" = e."runId"
    WHERE e."threadId" = ${threadId} AND e.type = 'thread.progress' AND e.seq > c.seq
    ORDER BY e.seq`;
  return rows.map(mapProductEvent);
}

export async function* followThreadEvents(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  realtime?: RealtimeFanout,
  signal?: AbortSignal,
  catchUpMs = realtime ? PUSH_CATCH_UP_MS : POLL_ONLY_CATCH_UP_MS,
  allowed?: () => Promise<boolean>,
): AsyncGenerator<ProductEvent> {
  let seq = cursor;
  const latch = new ChangeLatch();
  const unsubscribe = realtime
    ? await realtime
        .subscribe(threadTopic(threadId), () => latch.notify())
        .catch(() => async () => {})
    : async () => {};
  try {
    while (!signal?.aborted) {
      const observedGeneration = latch.generation;
      let batchSize = 0;
      do {
        const events = await eventsAfter(prisma, threadId, seq, EVENT_BATCH_SIZE);
        batchSize = events.length;
        if (batchSize > 0 && allowed && !(await allowed())) return;
        for (const event of events) {
          seq = event.seq;
          yield mapProductEvent(event);
        }
      } while (batchSize === EVENT_BATCH_SIZE && !signal?.aborted);
      if (signal?.aborted) break;
      await latch.waitForChange(observedGeneration, catchUpMs, signal);
    }
  } finally {
    await unsubscribe();
  }
}

function threadTopic(threadId: string): string {
  return `thread:${threadId}`;
}

function mapProductEvent(event: {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  seq: number;
  type: string;
  payload: unknown;
  runId: string | null;
  createdAt: Date;
}): ProductEvent {
  return {
    id: event.id,
    spaceId: event.spaceId,
    threadId: event.threadId,
    botId: event.botId,
    seq: event.seq,
    type: event.type as ProductEvent["type"],
    runId: event.runId ?? undefined,
    createdAt: event.createdAt.toISOString(),
    payload: event.payload as Record<string, unknown>,
  };
}

class ChangeLatch {
  generation = 0;
  private wake: (() => void) | undefined;

  notify(): void {
    this.generation += 1;
    this.wake?.();
  }

  async waitForChange(expected: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.generation !== expected || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        if (this.wake === finish) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.wake = finish;
      signal?.addEventListener("abort", finish, { once: true });
      if (this.generation !== expected || signal?.aborted) finish();
    });
  }
}
