import { ORPCError } from "@orpc/server";
import { isMemoryClassifierProvider } from "@rakazo/adapters";
import type {
  Actor,
  MemoryMethodSnapshot,
  MemoryMethodUpdateInput,
  PreparedMemoryMethod,
} from "@rakazo/contracts";
import { PreparedMemoryMethodSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { withSerializableRetry } from "./serializable-retry.js";

type UpdateInput = MemoryMethodUpdateInput;
type BotRow = {
  id: string;
  spaceId: string;
  userId: string;
  name: string;
  archivedAt: Date | null;
  memoryMethodDisabledAt: Date | null;
};
export type PrepareMemoryMethod = (input: {
  bot: Pick<BotRow, "id" | "spaceId" | "userId" | "name">;
  instructions: string;
}) => Promise<PreparedMemoryMethod>;

type Deps = { prisma: PrismaClient; prepare: PrepareMemoryMethod };

export const missingMemoryMethodPreparer: PrepareMemoryMethod = async () => {
  throw new ORPCError("PRECONDITION_FAILED", {
    message: "Connect a model in Rakazo before preparing this method.",
  });
};

async function visibleBot(
  prisma: PrismaClient | Prisma.TransactionClient,
  actor: Actor,
  botId: string,
) {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, archivedAt: null },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      name: true,
      archivedAt: true,
      memoryMethodDisabledAt: true,
    },
  });
  if (!bot) throw new ORPCError("NOT_FOUND");
  const membership = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { role: true },
  });
  if (!membership) throw new ORPCError("FORBIDDEN");
  return { bot, isOwner: bot.userId === actor.userId };
}

function snapshot(row: {
  id: string;
  botId: string;
  version: number;
  instructions: string;
  prepared: unknown;
  provider: string;
  model: string;
  allowedCollections: unknown;
  sharing: string;
  createdAt: Date;
}): MemoryMethodSnapshot {
  return {
    id: row.id,
    botId: row.botId,
    version: row.version,
    instructions: row.instructions,
    prepared: PreparedMemoryMethodSchema.parse(row.prepared),
    provider: row.provider as MemoryMethodSnapshot["provider"],
    model: row.model as MemoryMethodSnapshot["model"],
    allowedCollections: row.allowedCollections as MemoryMethodSnapshot["allowedCollections"],
    sharing: row.sharing as MemoryMethodSnapshot["sharing"],
    createdAt: row.createdAt.toISOString(),
  };
}

async function latestMethod(prisma: PrismaClient | Prisma.TransactionClient, botId: string) {
  return prisma.botMemoryMethod.findFirst({ where: { botId }, orderBy: { version: "desc" } });
}

export async function getBotMemoryMethod(deps: Deps, actor: Actor, botId: string) {
  const { bot, isOwner } = await visibleBot(deps.prisma, actor, botId);
  const latest = await latestMethod(deps.prisma, botId);
  if (!latest || bot.memoryMethodDisabledAt || (!isOwner && latest.sharing !== "space"))
    return {
      method: null,
      currentVersion: isOwner ? (latest?.version ?? null) : null,
      canConfigure: isOwner,
    };
  return { method: snapshot(latest), currentVersion: latest.version, canConfigure: isOwner };
}

export async function listBotMemoryMethods(deps: Deps, actor: Actor) {
  const membership = await deps.prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { spaceId: true },
  });
  if (!membership) throw new ORPCError("FORBIDDEN");
  const methods = await deps.prisma.botMemoryMethod.findMany({
    where: { bot: { spaceId: actor.spaceId, archivedAt: null } },
    include: {
      bot: { select: { id: true, name: true, userId: true, memoryMethodDisabledAt: true } },
    },
    orderBy: [{ botId: "asc" }, { version: "desc" }],
  });
  const latestByBot = new Map<string, (typeof methods)[number]>();
  for (const method of methods)
    if (!latestByBot.has(method.botId)) latestByBot.set(method.botId, method);
  return [...latestByBot.values()]
    .filter(
      (method) =>
        !method.bot.memoryMethodDisabledAt &&
        (method.bot.userId === actor.userId || method.sharing === "space"),
    )
    .map((method) => ({
      bot: { id: method.bot.id, name: method.bot.name },
      method: snapshot(method),
      isOwn: method.bot.userId === actor.userId,
    }));
}

export async function updateBotMemoryMethod(deps: Deps, actor: Actor, input: UpdateInput) {
  const { bot, isOwner } = await visibleBot(deps.prisma, actor, input.botId);
  if (!isOwner) throw new ORPCError("FORBIDDEN");
  if (!isMemoryClassifierProvider(input.provider)) throw new ORPCError("BAD_REQUEST");
  if (input.provider === "local" && input.model !== "reviewed-examples")
    throw new ORPCError("BAD_REQUEST");
  if (input.provider !== "local") {
    const connected = await deps.prisma.spaceMemoryClassifierConfig.findUnique({
      where: { spaceId: actor.spaceId },
      select: { provider: true, model: true },
    });
    if (!connected || connected.provider !== input.provider || connected.model !== input.model)
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "Connect the Jev model selected by this bot method before saving it.",
      });
  }
  const currentBeforePrepare = await latestMethod(deps.prisma, input.botId);
  if ((currentBeforePrepare?.version ?? null) !== input.expectedVersion)
    throw new ORPCError("CONFLICT", { message: "This method changed. Reload it and try again." });

  let prepared: PreparedMemoryMethod;
  try {
    prepared = PreparedMemoryMethodSchema.parse(
      await deps.prepare({ bot, instructions: input.instructions }),
    );
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    throw new ORPCError("PRECONDITION_FAILED", {
      message:
        "The classification method could not be prepared. Refine the instructions and try again.",
    });
  }

  return withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const currentBot = await tx.bot.findFirst({
          where: {
            id: input.botId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            archivedAt: null,
          },
          select: { id: true },
        });
        if (!currentBot) throw new ORPCError("FORBIDDEN");
        const current = await latestMethod(tx, input.botId);
        if ((current?.version ?? null) !== input.expectedVersion)
          throw new ORPCError("CONFLICT", {
            message: "This method changed. Reload it and try again.",
          });
        const row = await tx.botMemoryMethod.create({
          data: {
            botId: input.botId,
            version: (current?.version ?? 0) + 1,
            instructions: input.instructions,
            prepared: prepared as unknown as Prisma.InputJsonValue,
            provider: input.provider,
            model: input.model,
            allowedCollections: input.allowedCollections as unknown as Prisma.InputJsonValue,
            sharing: input.sharing,
          },
        });
        await tx.bot.update({ where: { id: input.botId }, data: { memoryMethodDisabledAt: null } });
        return snapshot(row);
      },
      { isolationLevel: "Serializable" },
    ),
  );
}

export async function disableBotMemoryMethod(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
  expectedVersion: number,
) {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const bot = await tx.bot.findFirst({
          where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
          select: { id: true },
        });
        if (!bot) throw new ORPCError("FORBIDDEN");
        const current = await latestMethod(tx, botId);
        if (!current || current.version !== expectedVersion)
          throw new ORPCError("CONFLICT", {
            message: "This method changed. Reload it and try again.",
          });
        await tx.bot.update({ where: { id: botId }, data: { memoryMethodDisabledAt: new Date() } });
        return { ok: true as const };
      },
      { isolationLevel: "Serializable" },
    ),
  );
}
