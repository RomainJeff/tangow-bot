import type { RealtimeFanout } from "@rakazo/adapter-kit";
import {
  type AskQuestion,
  type BotSecretDestination,
  type MessageBlock,
  type ProductEvent,
  parseKnownMessageBlocks,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  blocksToAgentHistoryText,
  isApprovalAskBlock,
  isSecretAskBlock,
  messagingChannelId,
  sanitizeJsonValue,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma, PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import {
  assertRunCanWriteHistory,
  createThreadMessageInTransaction,
  RunHistoryWriteError,
} from "./messages.js";
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
  pauseRunForTakeover(input: PauseRunForTakeover): Promise<boolean>;
  sendUserMessage(input: SendUserMessageInput): Promise<SendUserMessageResult>;
  startInboundRoutineRuns(
    input: StartInboundRoutineRunsInput,
  ): Promise<StartInboundRoutineRunsResult>;
  follow(threadId: string, cursor: number, signal?: AbortSignal): AsyncGenerator<ProductEvent>;
}

export interface ClearThreadInput {
  spaceId: string;
  threadId: string;
  /** Event author and the bot-scoped target for one-to-one chats. */
  botId: string;
  groupId?: string;
}

export interface ClearThreadResult {
  event: ProductEvent;
  cancelledRunIds: string[];
  historyCompactionGeneration: number;
}

export interface RewindThreadInput extends ClearThreadInput {
  /** The user message to rewind to; it and everything after it is removed. */
  messageId: string;
}

export interface RewindThreadResult {
  event: ProductEvent;
  cancelledRunIds: string[];
  historyCompactionGeneration: number;
  fromSeq: number;
  /** Compaction covered the rewound range and was rolled back; derived memory is now stale. */
  compactionReset: boolean;
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
}

export interface FinalizeRunResult {
  continuationRunId: string | null;
}

interface FinalizeRunBase {
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
        markUnread?: boolean;
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
  linkMessageToRun?: boolean;
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
    pauseRunForTakeover: (input) => pauseRunForTakeover(prisma, input, realtime),
    sendUserMessage: (input) => sendUserMessage(prisma, input, realtime),
    startInboundRoutineRuns: (input) => startInboundRoutineRuns(prisma, input, realtime),
    follow: (threadId, cursor, signal) =>
      followThreadEvents(prisma, threadId, cursor, realtime, signal, options.catchUpMs),
  };
}

interface TruncateThreadInput extends ClearThreadInput {
  /** Messages with seq >= fromSeq are deleted. */
  fromSeq: number;
  /** Events with seq >= fromEventSeq are deleted. */
  fromEventSeq: number;
}

interface TruncateThreadResult {
  nextMessageSeq: number;
  historyCompactedUpToSeq: number | null;
  historyCompactionGeneration: number;
  cancelledRunIds: string[];
}

/**
 * Shared by clearThread (cut at zero) and rewindThread (cut at a message): stop the thread's
 * work, release its computer, and drop history at or after the cut. Compaction bookkeeping and
 * the trailing event differ per caller and stay out of here.
 */
async function truncateThreadInTransaction(
  tx: Prisma.TransactionClient,
  input: TruncateThreadInput,
): Promise<TruncateThreadResult> {
  const thread = await tx.thread.update({
    where: {
      id: input.threadId,
      spaceId: input.spaceId,
      ...(input.groupId ? { groupId: input.groupId } : { botId: input.botId }),
    },
    data: { unread: false },
    select: {
      nextMessageSeq: true,
      historyCompactedUpToSeq: true,
      historyCompactionGeneration: true,
    },
  });
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
  await cancelRunsInTransaction(tx, activeRuns, now);
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
  await tx.message.deleteMany({
    where: { threadId: input.threadId, seq: { gte: input.fromSeq } },
  });
  await tx.event.deleteMany({
    where: { threadId: input.threadId, seq: { gte: input.fromEventSeq } },
  });
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
    });
    await tx.thread.update({
      where: { id: input.threadId },
      data: {
        // nextMessageSeq is not reset, so mark every deleted message as already compacted.
        // Leaving the cursor behind would let compaction re-summarize deleted history (or, reset
        // to null, immediately re-fire on the fresh conversation).
        ...(truncated.nextMessageSeq > 0
          ? { historyCompactedUpToSeq: truncated.nextMessageSeq - 1 }
          : {}),
        historyCompactionSummary: null,
        historyCompactionGeneration: { increment: 1 },
      },
    });
    const event = await appendEventInTransaction(tx, {
      ...input,
      type: "thread.cleared",
      payload: {},
    });
    return {
      event,
      cancelledRunIds: truncated.cancelledRunIds,
      historyCompactionGeneration: truncated.historyCompactionGeneration,
    };
  });
  await notifyRealtime(realtime, committed.event.threadId, committed.event.seq);
  return {
    event: mapProductEvent(committed.event),
    cancelledRunIds: committed.cancelledRunIds,
    historyCompactionGeneration: committed.historyCompactionGeneration,
  };
}

/**
 * Drops the target user message and everything after it, so the caller can resend an edited
 * version. Returns null when the target is gone or is not a user message.
 */
export async function rewindThread(
  prisma: PrismaClient,
  input: RewindThreadInput,
  realtime?: RealtimeFanout,
): Promise<RewindThreadResult | null> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const target = await tx.message.findFirst({
      where: { id: input.messageId, threadId: input.threadId, role: "user" },
      select: { seq: true },
    });
    if (!target) return null;
    const created = await tx.event.findFirst({
      where: {
        threadId: input.threadId,
        type: "thread.message.created",
        payload: { path: ["messageId"], equals: input.messageId },
      },
      orderBy: { seq: "asc" },
      select: { seq: true },
    });
    const truncated = await truncateThreadInTransaction(tx, {
      ...input,
      fromSeq: target.seq,
      // No creation event (only possible if history was already pruned): keep every event
      // rather than guess a cut point and drop the wrong range.
      fromEventSeq: created?.seq ?? Number.MAX_SAFE_INTEGER,
    });
    // Compaction covered the rewound messages, so its summary now describes deleted history.
    const compactionReset =
      truncated.historyCompactedUpToSeq !== null && target.seq <= truncated.historyCompactedUpToSeq;
    if (compactionReset) {
      await tx.thread.update({
        where: { id: input.threadId },
        data: {
          historyCompactedUpToSeq: null,
          historyCompactionSummary: null,
          historyCompactionGeneration: { increment: 1 },
        },
      });
    }
    const event = await appendEventInTransaction(tx, {
      ...input,
      type: "thread.rewound",
      payload: { fromSeq: target.seq },
    });
    return {
      event,
      cancelledRunIds: truncated.cancelledRunIds,
      historyCompactionGeneration: truncated.historyCompactionGeneration,
      fromSeq: target.seq,
      compactionReset,
    };
  });
  if (!committed) return null;
  await notifyRealtime(realtime, committed.event.threadId, committed.event.seq);
  return { ...committed, event: mapProductEvent(committed.event) };
}

export async function sendUserMessage(
  prisma: PrismaClient,
  input: SendUserMessageInput,
  realtime?: RealtimeFanout,
): Promise<SendUserMessageResult> {
  const replay = async (): Promise<SendUserMessageResult | null> => {
    if (!input.clientNonce) return null;
    const message = await prisma.message.findUnique({
      where: {
        threadId_clientNonce: {
          threadId: input.threadId,
          clientNonce: input.clientNonce,
        },
      },
      include: { sourceRuns: { orderBy: { createdAt: "asc" }, take: 1 } },
    });
    if (!message) return null;
    const created = message.sourceRuns[0];
    const run =
      created ??
      (message.runId ? await prisma.run.findUnique({ where: { id: message.runId } }) : null);
    return {
      messageId: message.id,
      seq: message.seq,
      taskId: created?.taskId ?? null,
      runId: run?.id ?? null,
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
        if (input.linkMessageToRun) {
          await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
        }
      } else if (createRun && busy) {
        await tx.steeringMessage.create({
          data: {
            messageId: message.id,
            botId: input.botId,
            userId: input.userId,
            runId: busy.id,
          },
        });
        await tx.message.update({ where: { id: message.id }, data: { runId: busy.id } });
      }
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: run?.id ?? busy?.id,
        payload: { messageId: message.id, role: "user", blocks: input.blocks },
      });
      return { message, task, run, busy, event };
    });
  const committed = await commit().catch(async (error) => {
    const winner = await replay();
    if (winner) return { replay: winner } as const;
    throw error;
  });
  if ("replay" in committed) return committed.replay;
  await notifyRealtime(realtime, input.threadId, committed.event.seq).catch((error) => {
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
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      select: { id: true, trigger: true, sourceMessage: { select: { blocks: true } } },
    });
    if (!run) return [];
    const channelId =
      run.trigger === "messaging"
        ? messagingChannelId(run.sourceMessage?.blocks as MessageBlock[] | undefined)
        : undefined;
    const steering = await tx.steeringMessage.findMany({
      where: {
        botId: input.botId,
        id: input.seenIds.length ? { notIn: input.seenIds } : undefined,
        OR: [{ runId: null }, { runId: input.runId }],
        message: {
          threadId: input.threadId,
          // Private follow-ups remain unclaimed for the existing private continuation.
          ...(channelId
            ? { blocks: { array_contains: [{ kind: "channel_message", channelId }] } }
            : {}),
        },
      },
      include: { message: { select: { blocks: true, seq: true } } },
      orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
    });
    if (steering.length === 0) return [];
    await tx.steeringMessage.updateMany({
      where: { id: { in: steering.map((item) => item.id) }, claimedAt: null },
      data: { runId: input.runId, claimedAt: new Date() },
    });
    return steering.map((item) => ({
      id: item.id,
      messageId: item.messageId,
      text: blocksToAgentHistoryText(item.message.blocks as MessageBlock[]),
      blocks: item.message.blocks as MessageBlock[],
    }));
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
      select: { botId: true, userId: true, checkpoint: true },
    });
    if (!run) return null;
    const message = await tx.message.findFirst({
      where: {
        id: input.messageId,
        threadId: input.threadId,
        runId: input.runId,
        role: "bot",
      },
    });
    // Tolerant lookup, and the rewrites below map over the stored array by index: a block this
    // build does not recognise neither hides the pending ask nor gets dropped from the message.
    const known = parseKnownMessageBlocks(message?.blocks);
    const pending = known.find(({ block }) => block.kind === "ask" && block.status !== "answered");
    if (!message || pending?.block.kind !== "ask") return null;
    const pendingAsk = pending.block;
    const storedBlocks = message.blocks as Prisma.InputJsonValue[];

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
      const storedAnswers: Record<
        string,
        { selected?: string[]; other?: string; skipped?: boolean }
      > = {};
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
      const answeredBlocks = storedBlocks.map((block, index) =>
        index === pending.index
          ? { ...pendingAsk, status: "answered" as const, answers: storedAnswers }
          : block,
      );
      await tx.message.update({ where: { id: message.id }, data: { blocks: answeredBlocks } });
      const updated = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: run.botId,
        type: "thread.message.updated",
        runId: input.runId,
        payload: { messageId: message.id, role: "bot", blocks: answeredBlocks },
      });
      return { threadId: updated.threadId, seq: updated.seq };
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
    if (secretAsk && !runSecretWriter) return null;
    if (secretAsk && pendingAsk.credential && run.userId !== input.answeredByUserId) return null;
    let approvalEffect: { id: string; kind: string } | null = null;
    let approvalUserId: string | null = null;

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
      if (input.answer === "always") {
        if (run.userId !== input.answeredByUserId) return null;
        approvalUserId = input.answeredByUserId;
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
      await tx.externalEffect.update({
        where: { id: approvalEffect!.id },
        data: { status: allowed ? "approved" : "denied" },
      });
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

    const blocks = storedBlocks.map((block, index) =>
      index === pending.index
        ? {
            ...pendingAsk,
            status: "answered" as const,
            answer: secretAsk ? "" : freeTextAnswer || input.answer,
          }
        : block,
    );
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    const updated = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: run.botId,
      type: "thread.message.updated",
      runId: input.runId,
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { threadId: updated.threadId, seq: updated.seq };
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
      threadId: string;
      runId: string;
      botId: string;
      messageId: string;
      /** The stored blocks with the ask marked answered — unrecognised entries passed through. */
      blocks: Prisma.InputJsonValue[];
      eventSeq: number;
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

  // The card is always the run's own pausing message (pauseRunForInput writes the ask blocks
  // directly onto it), so the latest bot message for this run is the one to inspect.
  const message = await tx.message.findFirst({
    where: { threadId: input.threadId, runId: input.runId, role: "bot" },
    orderBy: { seq: "desc" },
  });
  // Tolerant lookup: a block this build does not recognise (older/newer writer) must not hide a
  // pending ask the client is already rendering as pending — that mismatch is what makes the
  // caller throw CONFLICT on a card the user can see.
  const known = parseKnownMessageBlocks(message?.blocks);
  const pending = known.find(({ block }) => block.kind === "ask" && block.status !== "answered");
  if (!message || pending?.block.kind !== "ask") return { resolvable: false };
  const pendingAsk = pending.block;

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

  // Mark answered without echoing the reply onto the card: the user's words already live in
  // their own message bubble right below, so storing `answer`/`answers` here would duplicate them
  // (design D2). Absent `answer` makes the card render a plain resolved "Answered" state, and
  // absent `answers` keeps the multi-question card from fabricating a per-question breakdown.
  // Map over the stored array, not the parsed copy: every other block is written back exactly as
  // it came out of the database, unrecognised ones included.
  const blocks = (message.blocks as Prisma.InputJsonValue[]).map((block, index) =>
    index === pending.index ? { ...pendingAsk, status: "answered" as const } : block,
  );
  await tx.message.update({ where: { id: message.id }, data: { blocks } });
  const updated = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: run.botId,
    type: "thread.message.updated",
    runId: input.runId,
    payload: { messageId: message.id, role: "bot", blocks },
  });

  return {
    resolvable: true,
    threadId: updated.threadId,
    runId: input.runId,
    botId: run.botId,
    messageId: message.id,
    blocks,
    eventSeq: updated.seq,
  };
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
      data: { status: "waiting_input", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    const message = await createThreadMessageInTransaction(tx, {
      threadId: input.threadId,
      role: "bot",
      blocks: input.blocks,
      botId: input.botId,
      runId: input.runId,
    });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.created",
      runId: input.runId,
      payload: { messageId: message.id, role: "bot", blocks: input.blocks },
    });
    const waitingEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "run.waiting_input",
      runId: input.runId,
      payload: {},
    });
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    return { threadId: waitingEvent.threadId, seq: waitingEvent.seq };
  });

  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
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
      },
    });
    const activeUserLease = Boolean(
      computer?.controlHolder === "user" &&
        computer.controlLeaseId &&
        computer.controlLeaseExpiresAt &&
        computer.controlLeaseExpiresAt.getTime() > now.getTime(),
    );
    // Keep an active same-bot user lease so Skip / I'm done appear immediately.
    // Preserve another bot's active lease — computer/takeover owns revocation. Do not attach
    // this run to that lease: release validates controlBotId and could clear the binding without
    // resuming the waiting run. The requesting bot's takeover flow binds it after revocation.
    // Otherwise clear stale control, but bind controlRunId so takeoverRequested is true.
    const retainControl = Boolean(activeUserLease && computer?.controlBotId === input.botId);
    const preserveForeignLease = Boolean(
      activeUserLease && computer?.controlBotId && computer.controlBotId !== input.botId,
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
        controlRunId: null,
      },
    });
    if (cleared.count !== 1) return null;

    const checkpoint =
      input.reason === "expired"
        ? "takeover-expired"
        : input.reason === "skipped"
          ? "takeover-skipped"
          : "takeover";
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

    const bot = await tx.bot.findFirst({
      where: { id: input.botId, spaceId: input.spaceId },
      select: { thread: { select: { id: true } } },
    });
    if (!bot?.thread) return { threadId: null, seq: null, runId };
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: bot.thread.id,
      botId: input.botId,
      runId: runId ?? undefined,
      type: "computer.takeover.released",
      payload: {
        holder: input.holder,
        leaseId: input.leaseId,
        reason: input.reason,
      },
    });
    return { threadId: event.threadId, seq: event.seq, runId };
  });

  if (!committed) return false;
  if (committed.threadId && committed.seq !== null) {
    await notifyRealtime(realtime, committed.threadId, committed.seq);
  }
  return { runId: committed.runId };
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

/**
 * Picks the start time to measure a completed run's duration from: the current attempt's start
 * when known, falling back to the run's own start. A run can pause and resume (ask_user answers,
 * takeovers, approvals); using the latest attempt's start excludes time spent waiting on a human.
 * It also leaves out setup before the attempt row exists and the work of an attempt that crashed.
 */
export function runDurationStart(
  run: { startedAt: Date | null } | null,
  attempt: { startedAt: Date | null } | null,
): Date | null {
  return attempt?.startedAt ?? run?.startedAt ?? null;
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
        status: "running",
        leaseOwner: input.leaseOwner,
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

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
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
      const attemptTiming = await tx.attempt.findUnique({
        where: { id: input.attemptId },
        select: { startedAt: true },
      });
      const durationStartedAt = runDurationStart(writableRun ?? null, attemptTiming ?? null);
      const completedBlocks = completedRunBlocks(input.blocks, durationStartedAt, now);
      if (completedBlocks.length > 0) {
        const message = await createThreadMessageInTransaction(tx, {
          threadId: input.threadId,
          role: "bot",
          blocks: completedBlocks,
          botId: input.botId,
          runId: input.runId,
          markUnread: input.markUnread,
        });
        await appendEventInTransaction(tx, {
          spaceId: input.spaceId,
          threadId: input.threadId,
          botId: input.botId,
          type: "thread.message.created",
          runId: input.runId,
          payload: { messageId: message.id, role: "bot", blocks: completedBlocks },
        });
      }
    }
    const lastEvent = await appendEventInTransaction(tx, {
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
    await tx.bot.update({ where: { id: input.botId }, data: { updatedAt: now } });
    return { threadId: lastEvent.threadId, seq: lastEvent.seq, continuationRunId };
  });
}

async function createSteeringContinuation(
  tx: Prisma.TransactionClient,
  input: FinalizeRunBase,
): Promise<string | null> {
  const active = await tx.run.findFirst({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    select: { id: true },
  });
  if (active) return null;
  const pending = await tx.steeringMessage.findMany({
    where: {
      botId: input.botId,
      runId: null,
      message: { threadId: input.threadId },
    },
    include: { message: { select: { id: true, blocks: true, seq: true } } },
    orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
  });
  if (pending.length === 0) return null;
  const last = pending.at(-1)!;
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId: pending[0]!.userId,
      prompt: "Respond to the user's steering context.",
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      taskId: task.id,
      userId: pending[0]!.userId,
      status: "queued",
      trigger: "follow_up",
      sourceMessageId: last.message.id,
    },
  });
  await tx.steeringMessage.updateMany({
    where: { id: { in: pending.map((item) => item.id) }, runId: null },
    data: { runId: run.id, claimedAt: null },
  });
  return run.id;
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

export async function* followThreadEvents(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  realtime?: RealtimeFanout,
  signal?: AbortSignal,
  catchUpMs = realtime ? PUSH_CATCH_UP_MS : POLL_ONLY_CATCH_UP_MS,
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
