import { botMessageRelaysToUser } from "@tangow/core";
import { loadBotMessageContexts } from "./bot-message-context.js";
import type { Prisma, PrismaClient } from "./client.js";

type RunDb = PrismaClient | Prisma.TransactionClient;

/**
 * The subset of `runIds` that are hidden peer runs: `bot_message` runs whose output must stay out
 * of the bot's own conversation with the user. Two shapes hide: a sub-bot's delegated run, which
 * belongs to its parent, and any run answering a peer's solicitation, whose reply is returned to
 * that peer rather than written for the user (`botMessageRelaysToUser`). What stays is the
 * top-level relay a bot owes the user after work it delegated (background-work-visibility
 * CA5/CA7). Ordinary triggers are never included.
 */
export async function hiddenPeerRunIds(prisma: RunDb, runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const runs = await prisma.run.findMany({
    where: { id: { in: runIds }, trigger: "bot_message" },
    select: { id: true, sourceMessageId: true, bot: { select: { parentBotId: true } } },
  });
  const contexts = await loadBotMessageContexts(
    prisma,
    runs.flatMap((run) => run.sourceMessageId ?? []),
  );
  return new Set(
    runs
      .filter(
        (run) =>
          run.bot.parentBotId != null ||
          !botMessageRelaysToUser(
            run.sourceMessageId ? contexts.get(run.sourceMessageId) : undefined,
          ),
      )
      .map((run) => run.id),
  );
}
