import { isDeepStrictEqual } from "node:util";
import type { Actor, MemoryMethodSnapshot, PreparedMemoryMethod } from "@rakazo/contracts";
import { MemoryMethodSnapshotSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { withTransactionRetry } from "@rakazo/db";
import { MemoryConflictError } from "./access.js";
import type { MemoryRow } from "./documents.js";
import { serializable } from "./documents.js";
import { fingerprint, isRecord } from "./shared.js";

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * The actor's own enabled bot with its latest prepared method (null when none was prepared yet), or
 * null when the bot is not the actor's or the actor left the Space.
 */
export async function loadCurrentBotMethod(
  db: Pick<Prisma.TransactionClient, "bot" | "spaceMember" | "botMemoryMethod">,
  actor: Pick<Actor, "spaceId" | "userId">,
  botId: string,
): Promise<{
  bot: { id: string; name: string; instructions: string };
  method: MemoryMethodSnapshot | null;
} | null> {
  const bot = await db.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: { id: true, name: true, memoryMethodDisabledAt: true, instructions: true },
  });
  if (!bot || bot.memoryMethodDisabledAt) return null;
  const membership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { spaceId: true },
  });
  if (!membership) return null;
  const row = await db.botMemoryMethod.findFirst({
    where: { botId },
    orderBy: { version: "desc" },
  });
  return {
    bot: { id: bot.id, name: bot.name, instructions: bot.instructions },
    method: row
      ? MemoryMethodSnapshotSchema.parse({ ...row, createdAt: row.createdAt.toISOString() })
      : null,
  };
}

/** The bot and method while `expected` is still its current method and `document` not another bot's. */
export async function currentBotMethod(
  db: Db,
  actor: Pick<Actor, "spaceId" | "userId">,
  document: MemoryRow,
  botId: string,
  expected: MemoryMethodSnapshot,
) {
  const current = await loadCurrentBotMethod(db, actor, botId);
  if (
    !current?.method ||
    current.method.instructions !== current.bot.instructions ||
    fingerprint(current.method) !== fingerprint(expected) ||
    (document.collection.kind === "agent" && document.collection.botId !== botId)
  )
    return null;
  return { bot: { id: current.bot.id, name: current.bot.name }, method: current.method };
}

/** The Space decision connection as a bot method records it; null when none is connected. */
export function memoryDecisionConnection(config: { provider: string; settings: unknown } | null) {
  if (!config) return null;
  const settings = isRecord(config.settings) ? config.settings : {};
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    provider: config.provider,
    model: text(settings.modelId) || "default",
    baseUrl: text(settings.baseUrl) || undefined,
  };
}

/** Save criteria prepared from the bot's current Instructions as its next method version. */
export function prepareBotMethod(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  botId: string,
  input: {
    expectedInstructions: string;
    expectedVersion: number | null;
    prepared: PreparedMemoryMethod;
  },
) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const bot = await tx.bot.findFirst({
        where: { id: botId, userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
        select: { instructions: true },
      });
      if (!bot || bot.instructions !== input.expectedInstructions)
        throw new MemoryConflictError(
          "Bot instructions changed. Read them again before preparing.",
        );
      const current = await tx.botMemoryMethod.findFirst({
        where: { botId },
        orderBy: { version: "desc" },
      });
      const connection = memoryDecisionConnection(
        await tx.spaceDecisionConfig.findUnique({
          where: { spaceId: actor.spaceId },
          select: { provider: true, settings: true },
        }),
      );
      const provider = connection?.provider ?? "local";
      const model = connection?.model ?? "reviewed-examples";
      if (
        current &&
        current.instructions === bot.instructions &&
        current.provider === provider &&
        current.model === model &&
        isDeepStrictEqual(current.prepared, input.prepared)
      )
        return { version: current.version, prepared: current.prepared };
      if ((current?.version ?? null) !== input.expectedVersion)
        throw new MemoryConflictError("Method changed. Read it again before preparing.");
      const method = await tx.botMemoryMethod.create({
        data: {
          botId,
          version: (current?.version ?? 0) + 1,
          instructions: bot.instructions,
          prepared: input.prepared as Prisma.InputJsonValue,
          provider,
          model,
        },
      });
      await tx.bot.update({ where: { id: botId }, data: { memoryMethodDisabledAt: null } });
      return { version: method.version, prepared: method.prepared, provider, model };
    }, serializable),
  );
}
