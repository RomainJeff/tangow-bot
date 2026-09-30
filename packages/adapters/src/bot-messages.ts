import { runContinueJob } from "@rakazo/adapter-kit";
import type { BotMessageIntent, MessageBlock } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  botMessageContext,
  botMessageHopExhausted,
  buildBotMessageWakePrompt,
  clampBotMessage,
  nextBotMessageHop,
  repliesToOwnRequest,
  resolveBotAddress,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  createGroupRepos,
  createThreadMessageInTransaction,
  type PrismaClient,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { TERMINAL_WORK_STATUSES } from "./delegated-tasks.js";
import type { ExecutorDeps } from "./executor.js";

/**
 * The hop the current run sits at, read back from the message that woke this
 * bot. A run a person started carries no bot message, so it starts at 0.
 */
export async function currentBotMessageHop(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
): Promise<number> {
  if (!sourceMessageId) return 0;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true },
  });
  const blocks = Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [];
  return botMessageContext(blocks)?.hop ?? 0;
}

export async function loadBotMessageContext(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
) {
  if (!sourceMessageId) return undefined;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true, replyTo: { select: { blocks: true } } },
  });
  const context = botMessageContext(
    Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [],
  );
  if (!context) return undefined;
  const replyBlocks = Array.isArray(source?.replyTo?.blocks)
    ? (source.replyTo.blocks as MessageBlock[])
    : [];
  const repliesToRequest = repliesToOwnRequest(replyBlocks);
  return { ...context, repliesToRequest };
}

/** Follow a delegate reply back to the request this coordinator was handling.
 * The link is durable (reply -> outbound message -> originating run), so replies
 * from concurrent missions cannot borrow another mission's return address.
 */
export async function delegationReturnSource(
  prisma: PrismaClient,
  run: { botId: string; threadId: string; sourceMessageId?: string | null },
  targetBotId?: string,
): Promise<string | undefined> {
  let sourceMessageId = run.sourceMessageId ?? undefined;
  const visited = new Set<string>();
  while (sourceMessageId && !visited.has(sourceMessageId) && visited.size < 16) {
    visited.add(sourceMessageId);
    const context = await loadBotMessageContext(prisma, sourceMessageId);
    if (!context) return undefined;
    if (
      context.intent === undefined ||
      context.intent === "request" ||
      context.intent === "question"
    ) {
      return !targetBotId || context.fromBotId === targetBotId ? sourceMessageId : undefined;
    }
    if (context.intent !== "result" && context.intent !== "status") return undefined;
    const source = await prisma.message.findUnique({
      where: { id: sourceMessageId },
      select: {
        replyTo: {
          select: {
            botId: true,
            threadId: true,
            runId: true,
          },
        },
      },
    });
    const origin = source?.replyTo;
    if (origin?.botId !== run.botId || origin.threadId !== run.threadId) return undefined;
    if (!origin.runId) return undefined;
    const parentRun = await prisma.run.findFirst({
      where: { id: origin.runId, botId: run.botId, threadId: run.threadId },
      select: { sourceMessageId: true },
    });
    sourceMessageId = parentRun?.sourceMessageId ?? undefined;
  }
  return undefined;
}

export async function messageBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  sender: { id: string; name: string },
  input: {
    group_id?: string;
    bot_id?: string;
    confirm_name?: string;
    message: string;
    intent?: BotMessageIntent;
    deliveryKey?: string;
  },
  options?: { allowTerminalSource?: boolean },
) {
  const message = String(input.message ?? "").trim();
  if (!message) return { ok: false as const, error: "message is required" };
  if (message.length > BOT_MESSAGE_MAX_LENGTH) {
    return {
      ok: false as const,
      error: `message exceeds the ${BOT_MESSAGE_MAX_LENGTH} character limit`,
    };
  }

  let sourceContext = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  const intent = input.intent ?? "request";

  const candidates = await deps.prisma.bot.findMany({
    where: { spaceId: run.spaceId, userId: run.userId, archivedAt: null },
    select: {
      id: true,
      name: true,
      title: true,
      thread: { select: { id: true } },
      scopedTasksAsExecutor: {
        where: { status: { notIn: TERMINAL_WORK_STATUSES } },
        select: { id: true, specialistThreadId: true },
      },
    },
  });
  const target = resolveBotAddress(candidates, {
    botId: input.bot_id,
    name: input.confirm_name,
  });
  if (!target) return { ok: false as const, error: "no bot found with that id or name" };
  if (target.id === sender.id) return { ok: false as const, error: "a bot cannot message itself" };
  if (!target.thread)
    return { ok: false as const, error: `${target.name} has no chat to deliver to` };
  if (intent === "result" || intent === "status") {
    const returnSource = await delegationReturnSource(deps.prisma, run, target.id);
    if (returnSource) sourceContext = await loadBotMessageContext(deps.prisma, returnSource);
  }
  const hop = nextBotMessageHop(sourceContext?.hop);
  const returnsToSender =
    (intent === "result" || (intent === "status" && options?.allowTerminalSource === true)) &&
    (sourceContext?.intent === undefined ||
      sourceContext.intent === "request" ||
      sourceContext.intent === "question") &&
    sourceContext?.fromBotId === target.id;
  if (botMessageHopExhausted(hop) && !returnsToSender) {
    return {
      ok: false as const,
      error:
        "bot-to-bot message limit reached for this chain; report back to the user instead of messaging another bot",
    };
  }

  let targetThreadId = target.thread.id;
  let routesToWorkThread = false;
  if (
    sourceContext?.fromBotId === target.id &&
    intent !== "fyi" &&
    sourceContext.returnToMessageId
  ) {
    const origin = await deps.prisma.message.findUnique({
      where: { id: sourceContext.returnToMessageId },
      select: {
        botId: true,
        threadId: true,
        thread: {
          select: {
            spaceId: true,
            userId: true,
            botId: true,
            group: {
              select: { members: { where: { botId: target.id }, select: { botId: true } } },
            },
            externalConversation: { select: { botId: true } },
            scopedTask: { select: { executorBotId: true } },
          },
        },
      },
    });
    if (
      origin?.botId === target.id &&
      origin.thread.spaceId === run.spaceId &&
      origin.thread.userId === run.userId &&
      (origin.thread.externalConversation?.botId === target.id ||
        origin.thread.botId === target.id ||
        origin.thread.group?.members.some((member) => member.botId === target.id) ||
        origin.thread.scopedTask?.executorBotId === target.id)
    ) {
      targetThreadId = origin.threadId;
      routesToWorkThread = origin.thread.scopedTask?.executorBotId === target.id;
    }
  }

  if (input.group_id) {
    const group = await createGroupRepos(deps.prisma).getGroup(
      {
        userId: run.userId,
        spaceId: run.spaceId,
        email: "",
        isDeploymentOwner: false,
      },
      input.group_id,
    );
    if (
      !group.members.some((member) => member.bot.id === sender.id) ||
      !group.members.some((member) => member.bot.id === target.id)
    ) {
      return { ok: false as const, error: "Both bots must belong to the group" };
    }
    targetThreadId = group.thread!.id;
  }

  // A specialist owns one scoped task for its lifetime. A peer reply waking that
  // specialist remains ordinary peer traffic, but its resulting run still belongs
  // to the existing work only when it is delivered into that work's thread. Persistent
  // peers (and a specialist's ordinary direct thread) keep a null work link.
  const scopedTaskId = target.scopedTasksAsExecutor?.find(
    (scopedTask) => scopedTask.specialistThreadId === targetThreadId,
  )?.id;

  // A tool call can be re-executed after a lease expiry, so a delivery has to be
  // replayable: without this the recipient is messaged twice and woken twice.
  const deliveryKey = input.deliveryKey ? `bot-message:${input.deliveryKey}` : undefined;
  const replayed = () =>
    ({
      ok: true as const,
      botId: target.id,
      name: target.name,
      delivered: message,
      replayed: true as const,
      note: `Already sent to ${target.name} in this turn; it was not sent again.`,
    }) as const;

  const wakePrompt = buildBotMessageWakePrompt({ from: sender, text: message, intent });
  const outboundBlock: MessageBlock = {
    kind: "bot_message_sent",
    toBotId: target.id,
    toBotName: target.name,
    text: message,
    intent,
    purpose: "peer_message",
  };

  let committed:
    | {
        ok: true;
        runId: string;
        targetEventSeq: number;
        senderEventSeq: number;
      }
    | {
        ok: true;
        passiveReceipt: true;
        targetEventSeq: number;
        senderEventSeq: number;
      }
    | {
        ok: false;
        error: string;
      }
    | {
        ok: true;
        replayed: true;
      };
  try {
    committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        for (const threadId of [run.threadId, targetThreadId].sort()) {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        }
        // Claim the delivery key inside the transaction so a concurrent retry
        // either sees the winner or loses on the unique (threadId, clientNonce).
        if (deliveryKey) {
          const already = await tx.message.findUnique({
            where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
            select: { id: true },
          });
          if (already) return { ok: true as const, replayed: true as const };
        }

        const senderStillRunning = await tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            userId: run.userId,
            status: options?.allowTerminalSource
              ? { in: ["completed", "failed", "cancelled"] }
              : "running",
          },
          select: { id: true, status: true },
        });
        if (!senderStillRunning)
          return { ok: false as const, error: "source run is no longer active" };

        // Re-read the target inside the transaction: it can be archived between
        // resolving it above and committing here.
        const stillAddressable = await tx.bot.findFirst({
          where: {
            id: target.id,
            spaceId: run.spaceId,
            userId: run.userId,
            archivedAt: null,
          },
          select: { id: true },
        });
        if (!stillAddressable)
          return { ok: false as const, error: `${target.name} is no longer available` };

        // A peer can finish after the work that asked it has been cancelled. Preserve the
        // correlated message, but do not create a Task/Run that would revive closed work.
        // Lock the work row too: cancellation updates that row, so whichever operation wins
        // the lock decides whether this delivery is a wake or a passive receipt.
        const [targetWork] = routesToWorkThread
          ? await tx.$queryRaw<Array<{ status: string }>>`
              SELECT status FROM scoped_tasks
              WHERE "specialistThreadId" = ${targetThreadId} AND "executorBotId" = ${target.id}
              FOR UPDATE
            `
          : [];
        const passiveReceipt = Boolean(
          targetWork && TERMINAL_WORK_STATUSES.includes(targetWork.status),
        );

        // Echo into the sender's chat in the same transaction so a failed notify
        // cannot leave one side delivered and the other blank.
        const outbound = await createThreadMessageInTransaction(tx, {
          threadId: run.threadId,
          role: "bot",
          blocks: [outboundBlock],
          botId: run.botId,
          // A cancelled sender may only write this automatic terminal receipt;
          // leave the row unowned so the general cancelled-run history guard stays closed.
          runId: senderStillRunning.status === "cancelled" ? undefined : run.id,
        });
        const inboundBlock: MessageBlock = {
          kind: "bot_message_received",
          fromBotId: sender.id,
          fromBotName: sender.name,
          text: message,
          fromRunId: run.id,
          terminalOutcome: options?.allowTerminalSource === true,
          hop,
          intent,
          purpose: "peer_message",
          returnToMessageId: outbound.id,
        };
        // This is the recipient's prompt, but it is still unread peer activity.
        const inbound = await createThreadMessageInTransaction(tx, {
          threadId: targetThreadId,
          role: "user",
          blocks: [inboundBlock],
          replyToMessageId:
            sourceContext?.fromBotId === target.id && intent !== "fyi"
              ? sourceContext.returnToMessageId
              : undefined,
          clientNonce: deliveryKey,
          markUnread: true,
        });
        if (passiveReceipt) {
          const inboundEvent = await appendEventInTransaction(tx, {
            spaceId: run.spaceId,
            threadId: targetThreadId,
            botId: target.id,
            type: "thread.message.created",
            payload: { messageId: inbound.id, role: "user", blocks: [inboundBlock] },
          });
          const outboundEvent = await appendEventInTransaction(tx, {
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            type: "thread.message.created",
            runId: senderStillRunning.status === "cancelled" ? undefined : run.id,
            payload: { messageId: outbound.id, role: "bot", blocks: [outboundBlock] },
          });
          return {
            ok: true as const,
            passiveReceipt: true as const,
            targetEventSeq: inboundEvent.seq,
            senderEventSeq: outboundEvent.seq,
          };
        }
        const task = await tx.task.create({
          data: {
            spaceId: run.spaceId,
            botId: target.id,
            threadId: targetThreadId,
            userId: run.userId,
            prompt: wakePrompt,
            status: "queued",
          },
        });
        const nextRun = await tx.run.create({
          data: {
            spaceId: run.spaceId,
            botId: target.id,
            threadId: targetThreadId,
            taskId: task.id,
            userId: run.userId,
            status: "queued",
            trigger: "bot_message",
            sourceMessageId: inbound.id,
            scopedTaskId,
          },
          select: { id: true },
        });
        await tx.message.update({ where: { id: inbound.id }, data: { runId: nextRun.id } });
        const inboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: targetThreadId,
          botId: target.id,
          type: "thread.message.created",
          runId: nextRun.id,
          payload: { messageId: inbound.id, role: "user", blocks: [inboundBlock] },
        });
        const outboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          type: "thread.message.created",
          runId: senderStillRunning.status === "cancelled" ? undefined : run.id,
          payload: { messageId: outbound.id, role: "bot", blocks: [outboundBlock] },
        });
        return {
          ok: true as const,
          runId: nextRun.id,
          targetEventSeq: inboundEvent.seq,
          senderEventSeq: outboundEvent.seq,
        };
      }),
    );
  } catch (error) {
    // Two concurrent retries can both miss the in-transaction lookup; the
    // loser hits the unique key. Treat that as a successful replay.
    if (deliveryKey && isUniqueConstraintError(error)) {
      const winner = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
        select: { id: true },
      });
      if (winner) return replayed();
    }
    throw error;
  }
  if ("replayed" in committed) return replayed();
  if (!committed.ok) return committed;

  await deps.events.notify(targetThreadId, committed.targetEventSeq).catch((error) => {
    getLogger().error("bot message realtime notification", error);
  });
  await deps.events.notify(run.threadId, committed.senderEventSeq).catch((error) => {
    getLogger().error("bot message sender echo notification", error);
  });
  if ("runId" in committed) {
    await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
      // The queued run is durable; the job reconciler repairs a missed wake.
      getLogger().error("bot message enqueue", error);
    });
  }
  return {
    ok: true as const,
    botId: target.id,
    name: target.name,
    delivered: message,
    note:
      "passiveReceipt" in committed
        ? `Sent to ${target.name} as a passive receipt; its closed work was not reopened.`
        : `Sent to ${target.name}. Delivery is async; a reply starts a new run. Do not sleep, poll, or wait actively. Continue independent work only when it does not depend on the reply, record a short pending state if needed, then end this turn. Send another update only when it adds something new.`,
  };
}

/** Return a delegated run's terminal outcome unless it already sent one explicitly. */
export async function returnBotMessageOutcome(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  sender: { id: string; name: string },
  text: string,
  intent: "result" | "status" = "result",
) {
  const returnSourceId = await delegationReturnSource(deps.prisma, run);
  const source = await loadBotMessageContext(deps.prisma, returnSourceId);
  if (!source) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    // Handled: nothing to deliver. Return true so callers do not release a reservation.
    return true;
  }
  const sourceIntent = source.intent ?? "request";
  if (sourceIntent !== "request" && sourceIntent !== "question") {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  const sent = await deps.prisma.message.findMany({
    where: { threadId: run.threadId, runId: run.id },
    select: { blocks: true },
  });
  // Only an explicit result counts as a terminal outcome. Interim message_bot
  // status updates must not suppress the automatic final return.
  const alreadyReturned = sent.some((message) =>
    (Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : []).some(
      (block) =>
        block.kind === "bot_message_sent" &&
        block.toBotId === source.fromBotId &&
        block.intent === "result",
    ),
  );
  if (alreadyReturned) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  const outcome = await messageBot(
    deps,
    { ...run, sourceMessageId: returnSourceId },
    sender,
    {
      bot_id: source.fromBotId,
      message: clampBotMessage(text),
      intent,
      // One key per run so status vs result (executor vs reconciler) cannot double-deliver.
      deliveryKey: `auto-outcome:${run.id}`,
    },
    { allowTerminalSource: true },
  );
  if (outcome.ok) await markBotOutcomeReturned(deps.prisma, run.id);
  return outcome.ok;
}

async function markBotOutcomeReturned(prisma: PrismaClient, runId: string) {
  await prisma.run.updateMany({
    where: {
      id: runId,
      status: { in: ["completed", "failed", "cancelled"] },
      botOutcomeReturnedAt: null,
    },
    data: { botOutcomeReturnedAt: new Date() },
  });
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
