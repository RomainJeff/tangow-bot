import type { Actor, BotSharing } from "@tangow/contracts";
import { BotSharingSchema } from "@tangow/contracts";
import { ACTIVE_RUN_STATUSES } from "@tangow/core";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma, PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
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
 * Bots someone else owns that `userId` may use in `spaceId`, or in any Space without one. Only
 * Space members reach a Space (`requireMembership`), so a removed person matches nothing there;
 * a caller without that check must also require the membership.
 */
export function sharedWithFilter(
  userId: string,
  spaceId?: string | { in: string[] },
): Prisma.BotWhereInput {
  return {
    ...(spaceId ? { spaceId } : {}),
    userId: { not: userId },
    archivedAt: null,
    OR: [{ visibility: "space" }, { visibility: "people", shares: { some: { userId } } }],
  };
}

/** Of `botIds`, the ones `userId` may wake in `spaceId`: their own, or ones shared with them. */
export async function usableBotIds(
  db: Pick<Prisma.TransactionClient, "bot">,
  userId: string,
  spaceId: string | { in: string[] },
  botIds: readonly string[],
): Promise<Set<string>> {
  if (botIds.length === 0) return new Set();
  const bots = await db.bot.findMany({
    where: {
      id: { in: [...new Set(botIds)] },
      OR: [{ spaceId, userId, archivedAt: null }, sharedWithFilter(userId, spaceId)],
    },
    select: { id: true },
  });
  return new Set(bots.map((bot) => bot.id));
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
    select: { id: true, userId: true, visibility: true, connectors: true },
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
    connectors: botConnectors(bot.connectors),
  };
}

/**
 * An owner declares only the MCP servers they gave the bot. One declared before stays declared
 * after its owner deletes it, so it can still be unticked.
 */
async function requireOwnServers(
  tx: Prisma.TransactionClient,
  actor: Actor,
  botId: string,
  connectors: BotSharing["connectors"],
  stored: BotSharing["connectors"],
) {
  const serverIds = (list: BotSharing["connectors"]) =>
    list.flatMap((need) => (need.kind === "mcp" ? [need.serverId] : []));
  const kept = new Set(serverIds(stored));
  const added = [...new Set(serverIds(connectors).filter((id) => !kept.has(id)))];
  if (added.length === 0) return;
  const given = await tx.botMcpServer.count({
    where: { botId, serverId: { in: added }, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (given !== added.length) throw new IsolationError();
}

/** The apps a bot declares; a stored value that no longer parses declares none. */
export function botConnectors(value: Prisma.JsonValue): BotSharing["connectors"] {
  return BotSharingSchema.shape.connectors.catch([]).parse(value);
}

/**
 * The owner sets who uses the bot. People are kept only for `people`; whoever loses access keeps
 * their thread, hidden, and their runs of the bot, in it or in a group, and their routines on it stop.
 */
export async function setBotSharing(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId: string } & Omit<BotSharing, "connectors"> &
    Partial<Pick<BotSharing, "connectors">>,
): Promise<BotSharing> {
  const userIds = input.visibility === "people" ? [...new Set(input.userIds)] : [];
  return prisma.$transaction(async (tx) => {
    const bot = await ownedBot(tx, actor, input.botId);
    const members = await tx.spaceMember.count({
      where: { spaceId: actor.spaceId, userId: { in: userIds, not: actor.userId } },
    });
    if (members !== userIds.length) throw new NotSpaceMemberError();
    const stored = botConnectors(bot.connectors);
    const connectors = input.connectors ?? stored;
    await requireOwnServers(tx, actor, input.botId, connectors, stored);
    await tx.bot.update({
      where: { id: input.botId },
      data: { visibility: input.visibility, connectors },
    });
    await tx.botShare.deleteMany({ where: { botId: input.botId, userId: { notIn: userIds } } });
    await tx.botShare.createMany({
      data: userIds.map((userId) => ({ botId: input.botId, userId })),
      skipDuplicates: true,
    });
    if (input.visibility !== "space") {
      const runs = await tx.run.findMany({
        // Their runs of the bot anywhere: their own thread with it, and every group it is in.
        where: {
          botId: input.botId,
          userId: { notIn: [...userIds, actor.userId] },
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        select: { id: true, taskId: true },
      });
      await cancelRunsInTransaction(tx, runs, new Date(), actor.userId);
      // A cancelled run waiting on the screen gives the computer back at once.
      await expireComputerExecutionLeases(tx, { runId: { in: runs.map((run) => run.id) } });
      await tx.routine.updateMany({
        where: { botId: input.botId, userId: { notIn: [...userIds, actor.userId] } },
        data: { active: false, nextRunAt: null },
      });
    }
    return { visibility: input.visibility, userIds, connectors };
  });
}
