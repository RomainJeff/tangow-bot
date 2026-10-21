import { runContinueJob } from "@rakazo/adapter-kit";
import type { SessionId } from "@rakazo/contracts";
import { botMessageHopExhausted, nextBotMessageHop, renderGroupMembersContext } from "@rakazo/core";
import {
  appendEventInTransaction,
  appendSessionEntryInTransaction,
  IsolationError,
  lockOwnedGroup,
  type PrismaClient,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { resolveRunHop } from "./bot-messages.js";
import type { ExecutorDeps } from "./executor.js";

export async function handoffToGroupBot(
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
  groupId: string,
  input: { bot_id?: string; confirm_name?: string; message: string },
) {
  const committed = await deps.prisma.$transaction(async (tx) => {
    try {
      await lockOwnedGroup(tx, run, groupId);
    } catch (error) {
      if (error instanceof IsolationError)
        return { error: "group is no longer available" } as const;
      throw error;
    }
    const [group, activeSource] = await Promise.all([
      tx.chatGroup.findFirst({
        where: { id: groupId, archivedAt: null, thread: { id: run.threadId } },
        include: {
          members: {
            where: { bot: { archivedAt: null } },
            include: { bot: { select: { id: true, name: true } } },
            orderBy: { createdAt: "asc" },
          },
        },
      }),
      tx.run.findFirst({
        where: {
          id: run.id,
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          userId: run.userId,
          status: "running",
        },
        select: {
          id: true,
          sessionId: true,
          sourceMessageId: true,
          routineId: true,
          trigger: true,
          sourceMessage: { select: { type: true, payload: true } },
        },
      }),
    ]);
    if (!group || !activeSource) return { error: "source run is no longer active" } as const;
    if (!group.members.some((member) => member.bot.id === run.botId)) {
      return { error: "source bot is no longer a group member" } as const;
    }

    // A run hands off once: a retry finds the handoff it already wrote.
    const existing = await tx.sessionEntry.findFirst({
      where: { runId: run.id, type: "handoff" },
      select: {
        sourceRuns: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { id: true, botId: true },
        },
      },
    });
    if (existing) {
      const nextRun = existing.sourceRuns[0];
      const event = await tx.event.findFirst({
        where: { threadId: run.threadId, runId: run.id, type: "group.handoff" },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      if (!nextRun || !event) return { error: "recorded handoff is incomplete" } as const;
      return { ok: true, botId: nextRun.botId, runId: nextRun.id, eventSeq: event.seq } as const;
    }

    let targetId = input.bot_id?.trim();
    if (!targetId && input.confirm_name?.trim()) {
      const name = input.confirm_name.trim().toLowerCase();
      targetId = group.members.find((member) => member.bot.name.toLowerCase() === name)?.bot.id;
    }
    if (!targetId) return { error: "handoff target bot is required" } as const;
    if (targetId === run.botId) return { error: "cannot hand off to yourself" } as const;
    if (!group.members.some((member) => member.bot.id === targetId)) {
      return { error: "handoff target is not a group member" } as const;
    }

    const source = activeSource.sourceMessage;
    const handedBy =
      source?.type === "handoff" ? (source.payload as { fromBotId?: string }).fromBotId : undefined;
    if (handedBy === targetId) {
      return {
        error:
          "do not hand this stage back to its sender; post the result in the shared thread instead",
      } as const;
    }
    const hop = nextBotMessageHop(await resolveRunHop(tx, activeSource));
    if (botMessageHopExhausted(hop)) {
      return {
        error:
          "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
      } as const;
    }

    await tx.thread.update({ where: { id: run.threadId }, data: { unread: true } });
    const handoff = await appendSessionEntryInTransaction(tx, {
      type: "handoff",
      sessionId: activeSource.sessionId as SessionId,
      botId: run.botId,
      runId: run.id,
      payload: { fromBotId: run.botId, toBotId: targetId, text: input.message, hop },
    });
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: targetId,
        threadId: run.threadId,
        userId: run.userId,
        prompt: input.message,
        status: "queued",
      },
    });
    const nextRun = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: targetId,
        threadId: run.threadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: "follow_up",
        sourceMessageId: handoff.id,
      },
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "group.handoff",
      runId: run.id,
      payload: {
        messageId: handoff.id,
        fromBotId: run.botId,
        toBotId: targetId,
        text: input.message,
      },
    });
    await touchGroupUpdatedAt(tx, groupId);
    return { ok: true, botId: targetId, runId: nextRun.id, eventSeq: event.seq } as const;
  });
  if ("error" in committed) return committed;
  await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("group handoff realtime notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    // The queued run is durable and the job reconciler will repair a missed immediate wake.
    getLogger().error("group handoff enqueue", error);
  });
  return {
    ok: true,
    botId: committed.botId,
    runId: committed.runId,
    note: "Handoff recorded. End this turn without narrating it; the next bot owns the next stage.",
  };
}

/**
 * The group's rendered roster context, plus the id → name map it was built from.
 *
 * History rendering needs the same names to attribute a member's turn and to read
 * a handoff, and this is the only read that already has them: returning the map
 * keeps that to one query instead of one lookup per message.
 */
export async function loadGroupContext(
  prisma: PrismaClient,
  groupId: string,
  self: { id: string; name: string },
): Promise<{ context: string; memberNames: Map<string, string> } | undefined> {
  const group = await prisma.chatGroup.findUnique({
    where: { id: groupId },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: {
          bot: { select: { id: true, name: true, title: true, description: true } },
        },
        orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
      },
    },
  });
  if (!group) return undefined;
  const members = group.members.map((member) => member.bot);
  return {
    context: renderGroupMembersContext(group.name, members, self, group.description),
    memberNames: new Map(members.map((bot) => [bot.id, bot.name])),
  };
}
