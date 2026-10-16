import { randomUUID } from "node:crypto";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { BotMessageIntent, EntryId, Peer, SessionId } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_HOPS,
  BOT_MESSAGE_MAX_LENGTH,
  botMessageHopExhausted,
  buildBotMessageWakePrompt,
  clampBotMessage,
  nextBotMessageHop,
  resolveBotAddress,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendSessionEntryInTransaction,
  loadBotMessageContext,
  threadEntryByNonce,
  threadEventSeq,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";

type RunHopSource = {
  sourceMessageId?: string | null;
  routineId?: string | null;
  trigger?: string;
};

/**
 * The hop the run sits at: the deepest of the bot message or group handoff that woke it and
 * the hop its routine inherited when a bot created it mid-chain. A run a person started
 * carries none of these, so it starts at 0. A routine run whose routine is gone (routineId
 * null) cannot prove where it started, so it counts as the end of the chain.
 */
export async function resolveRunHop(
  db: Pick<PrismaClient, "sessionEntry" | "routine">,
  run: RunHopSource,
): Promise<number> {
  // Only a scheduled routine run always has a routine: a webhook run may never have had one.
  if (run.routineId === null && run.trigger === "routine") {
    return BOT_MESSAGE_MAX_HOPS;
  }
  const [source, routine] = await Promise.all([
    run.sourceMessageId
      ? db.sessionEntry.findUnique({
          where: { id: run.sourceMessageId },
          select: { type: true, payload: true },
        })
      : null,
    run.routineId
      ? db.routine.findUnique({ where: { id: run.routineId }, select: { inheritedHop: true } })
      : null,
  ]);
  // The run row is read once, so a routine deleted during its own run still has an id here.
  if (run.routineId && !routine) return BOT_MESSAGE_MAX_HOPS;
  const sourceHop =
    source?.type === "bot.message.received" || source?.type === "handoff"
      ? ((source.payload as { hop?: number }).hop ?? 0)
      : 0;
  return Math.max(sourceHop, routine?.inheritedHop ?? 0);
}

async function exchangeOf(
  tx: Prisma.TransactionClient,
  sourceMessageId: string | null | undefined,
): Promise<EntryId | undefined> {
  if (!sourceMessageId) return undefined;
  const woke = await tx.sessionEntry.findUnique({
    where: { id: sourceMessageId },
    select: { type: true, payload: true },
  });
  return woke?.type === "bot.message.received"
    ? ((woke.payload as { exchangeId: string }).exchangeId as EntryId)
    : undefined;
}

export async function appendBotMessageInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    sender: { sessionId: SessionId; botId: string; runId?: string; peer: Peer };
    receiver: { sessionId: SessionId; botId: string; peer: Peer };
    sentId: string;
    receivedId: string;
    sourceMessageId: string | null | undefined;
    text: string;
    intent: BotMessageIntent;
    hop: number;
    deliveryKey?: string;
  },
): Promise<void> {
  const sentId = input.sentId as EntryId;
  const exchangeId = (await exchangeOf(tx, input.sourceMessageId)) ?? sentId;
  const { text, intent, hop } = input;
  const sent = await appendSessionEntryInTransaction(tx, {
    id: sentId,
    type: "bot.message.sent",
    sessionId: input.sender.sessionId,
    botId: input.sender.botId,
    ...(input.sender.runId ? { runId: input.sender.runId } : {}),
    payload: { to: input.receiver.peer, text, intent, hop, exchangeId },
  });
  await appendSessionEntryInTransaction(tx, {
    id: input.receivedId as EntryId,
    type: "bot.message.received",
    sessionId: input.receiver.sessionId,
    feedBotId: input.receiver.botId,
    payload: {
      from: input.sender.peer,
      fromSessionId: sent.sessionId,
      fromEntryId: sentId,
      text,
      intent,
      hop,
      exchangeId,
      ...(input.deliveryKey ? { clientNonce: input.deliveryKey } : {}),
    },
  });
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
    routineId?: string | null;
    trigger?: string;
  },
  sender: { id: string; name: string },
  input: {
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

  const sourceContext = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  const intent = input.intent ?? "request";
  const hop = nextBotMessageHop(await resolveRunHop(deps.prisma, run));

  const candidates = await deps.prisma.bot.findMany({
    where: { spaceId: run.spaceId, userId: run.userId, archivedAt: null },
    select: {
      id: true,
      name: true,
      title: true,
      thread: { select: { id: true, sessionId: true } },
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
  const returnsToSender =
    options?.allowTerminalSource === true &&
    (intent === "result" || intent === "status") &&
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

  const targetThreadId = target.thread.id;
  const targetSessionId = target.thread.sessionId;

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

  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      for (const threadId of [run.threadId, targetThreadId].sort()) {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      }
      // Under both thread locks, so a concurrent retry waits and then finds this delivery.
      if (deliveryKey && (await threadEntryByNonce(tx, targetThreadId, deliveryKey))) {
        return { ok: true as const, replayed: true as const };
      }

      const senderStillRunning = await tx.run.findFirst({
        where: {
          id: run.id,
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          userId: run.userId,
          status: options?.allowTerminalSource ? { in: ["completed", "failed"] } : "running",
        },
        select: { id: true, sessionId: true, status: true },
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

      // Both sides in one transaction so a failed notify cannot leave one delivered and the other
      // blank. The delivery is the recipient's prompt, but it is still unread peer activity.
      await tx.thread.updateMany({
        where: { id: { in: [run.threadId, targetThreadId] } },
        data: { unread: true },
      });
      const receivedId = randomUUID();
      await appendBotMessageInTransaction(tx, {
        sender: {
          sessionId: senderStillRunning.sessionId as SessionId,
          botId: run.botId,
          runId: senderStillRunning.status === "running" ? run.id : undefined,
          peer: { kind: "bot", botId: sender.id, name: sender.name },
        },
        receiver: {
          sessionId: targetSessionId as SessionId,
          botId: target.id,
          peer: { kind: "bot", botId: target.id, name: target.name },
        },
        sentId: randomUUID(),
        receivedId,
        sourceMessageId: run.sourceMessageId,
        text: message,
        intent,
        hop,
        deliveryKey,
      });
      // Read back as the woken run reads it: only the recipient's log knows what it asked for.
      const delivered = await loadBotMessageContext(tx, receivedId);
      const task = await tx.task.create({
        data: {
          spaceId: run.spaceId,
          botId: target.id,
          threadId: targetThreadId,
          userId: run.userId,
          prompt: buildBotMessageWakePrompt({
            from: sender,
            text: message,
            intent,
            repliesToRequest: delivered?.repliesToRequest,
          }),
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
          sourceMessageId: receivedId,
        },
        select: { id: true },
      });
      return {
        ok: true as const,
        runId: nextRun.id,
        targetEventSeq: await threadEventSeq(tx, targetThreadId),
        senderEventSeq: await threadEventSeq(tx, run.threadId),
      };
    }),
  );
  if ("replayed" in committed) return replayed();
  if (!committed.ok) return committed;

  await deps.events.notify(targetThreadId, committed.targetEventSeq).catch((error) => {
    getLogger().error("bot message realtime notification", error);
  });
  await deps.events.notify(run.threadId, committed.senderEventSeq).catch((error) => {
    getLogger().error("bot message sender echo notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    // The queued run is durable; the job reconciler repairs a missed wake.
    getLogger().error("bot message enqueue", error);
  });
  return {
    ok: true as const,
    botId: target.id,
    name: target.name,
    delivered: message,
    note: `Sent to ${target.name}. Delivery is async; a reply wakes you later as a new message. Continue independent work; send another update later only if it adds something new.`,
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
  const source = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
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
  // Only an explicit result counts as a terminal outcome. Interim message_bot
  // status updates must not suppress the automatic final return.
  const alreadyReturned = await deps.prisma.sessionEntry.findFirst({
    where: {
      runId: run.id,
      type: "bot.message.sent",
      AND: [
        { payload: { path: ["intent"], equals: "result" } },
        { payload: { path: ["to", "botId"], equals: source.fromBotId } },
      ],
    },
    select: { id: true },
  });
  if (alreadyReturned) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  const outcome = await messageBot(
    deps,
    run,
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
      status: { in: ["completed", "failed"] },
      botOutcomeReturnedAt: null,
    },
    data: { botOutcomeReturnedAt: new Date() },
  });
}
