import type { Actor, BotSharing } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

export class NotBotOwnerError extends Error {
  constructor() {
    super("Only the bot's owner can change who it is shared with");
    this.name = "NotBotOwnerError";
  }
}

export class NotSpaceMemberError extends Error {
  constructor() {
    super("A bot can only be shared with members of its Space");
    this.name = "NotSpaceMemberError";
  }
}

/**
 * Bots someone else owns that `userId` may use in `spaceId`. Only Space members reach a Space
 * (`requireMembership`), so a removed person matches nothing here.
 */
export function sharedWithFilter(
  userId: string,
  spaceId: string | { in: string[] },
): Prisma.BotWhereInput {
  return {
    spaceId,
    userId: { not: userId },
    archivedAt: null,
    OR: [{ visibility: "space" }, { visibility: "people", shares: { some: { userId } } }],
  };
}

/** A bot shared with the actor and the actor's own thread with it, created on first use. */
export async function sharedBotThread(prisma: PrismaClient, actor: Actor, botId: string) {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, ...sharedWithFilter(actor.userId, actor.spaceId) },
    include: { computer: true },
  });
  if (!bot) return null;
  const thread = await prisma.thread.upsert({
    where: { memberBotId_userId: { memberBotId: bot.id, userId: actor.userId } },
    create: { spaceId: bot.spaceId, memberBotId: bot.id, userId: actor.userId },
    update: {},
  });
  return { bot, thread };
}

/** Creates the actor's missing member threads, so every listed shared bot has one. */
export async function ensureMemberThreads(
  prisma: PrismaClient,
  userId: string,
  bots: ReadonlyArray<{ id: string; spaceId: string; memberThreads: unknown[] }>,
): Promise<boolean> {
  const missing = bots.filter((bot) => bot.memberThreads.length === 0);
  if (missing.length === 0) return false;
  await prisma.thread.createMany({
    data: missing.map((bot) => ({ spaceId: bot.spaceId, memberBotId: bot.id, userId })),
    skipDuplicates: true,
  });
  return true;
}

async function ownedBot(db: Prisma.TransactionClient, actor: Actor, botId: string) {
  const bot = await db.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, archivedAt: null },
    select: { id: true, userId: true, visibility: true },
  });
  if (bot?.userId === actor.userId) return bot;
  // Someone the bot is shared with learns it exists already; anyone else learns nothing.
  if (bot && (await sharedWith(db, actor, botId))) throw new NotBotOwnerError();
  throw new IsolationError();
}

async function sharedWith(db: Prisma.TransactionClient, actor: Actor, botId: string) {
  return Boolean(
    await db.bot.findFirst({
      where: { id: botId, ...sharedWithFilter(actor.userId, actor.spaceId) },
      select: { id: true },
    }),
  );
}

export async function getBotSharing(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
): Promise<BotSharing> {
  const bot = await ownedBot(prisma, actor, botId);
  const shares = await prisma.botShare.findMany({
    where: { botId },
    select: { userId: true },
    orderBy: { createdAt: "asc" },
  });
  return {
    visibility: bot.visibility as BotSharing["visibility"],
    userIds: shares.map((share) => share.userId),
  };
}

/**
 * The owner sets who uses the bot. People are kept only for `people`; whoever loses access keeps
 * their thread, hidden, and their runs in it and their routines on the bot stop.
 */
export async function setBotSharing(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId: string } & BotSharing,
): Promise<BotSharing> {
  const userIds = input.visibility === "people" ? [...new Set(input.userIds)] : [];
  return prisma.$transaction(async (tx) => {
    await ownedBot(tx, actor, input.botId);
    const members = await tx.spaceMember.count({
      where: { spaceId: actor.spaceId, userId: { in: userIds, not: actor.userId } },
    });
    if (members !== userIds.length) throw new NotSpaceMemberError();
    await tx.bot.update({ where: { id: input.botId }, data: { visibility: input.visibility } });
    await tx.botShare.deleteMany({ where: { botId: input.botId, userId: { notIn: userIds } } });
    await tx.botShare.createMany({
      data: userIds.map((userId) => ({ botId: input.botId, userId })),
      skipDuplicates: true,
    });
    if (input.visibility !== "space") {
      const runs = await tx.run.findMany({
        where: {
          status: { in: [...ACTIVE_RUN_STATUSES] },
          thread: { memberBotId: input.botId, userId: { notIn: userIds } },
        },
        select: { id: true, taskId: true },
      });
      await cancelRunsInTransaction(tx, runs, new Date(), actor.userId);
      await tx.routine.updateMany({
        where: { botId: input.botId, userId: { notIn: [...userIds, actor.userId] } },
        data: { active: false, nextRunAt: null },
      });
    }
    return { visibility: input.visibility, userIds };
  });
}
