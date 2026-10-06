import type { PrismaClient } from "./client.js";

/**
 * Names of the user's active bots in the space, optionally without one bot. The one source for
 * every uniqueness check on a bot name: the executor's spawn_bot handler and the transaction that
 * answers an edited Create bot card must agree on what is taken.
 */
export async function activeBotNames(
  client: { bot: Pick<PrismaClient["bot"], "findMany"> },
  scope: { spaceId: string; userId: string },
  exceptBotId?: string,
): Promise<string[]> {
  const bots = await client.bot.findMany({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      archivedAt: null,
      ...(exceptBotId ? { id: { not: exceptBotId } } : {}),
    },
    select: { name: true },
  });
  return bots.map((bot) => bot.name);
}
