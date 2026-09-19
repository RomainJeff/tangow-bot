import type { MessageBlock } from "@rakazo/contracts";
import { botMessageRunRelaysToUser } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";

type RunDb = PrismaClient | Prisma.TransactionClient;

/**
 * A `bot_message` run whose output must stay out of the bot's own conversation with the user.
 *
 * Two shapes hide: a sub-bot's delegated run, which belongs to its parent, and any run answering
 * a peer's solicitation, whose reply is returned to that peer rather than written for the user
 * (`botMessageRunRelaysToUser`). What stays is the top-level relay a bot owes the user after work
 * it delegated (background-work-visibility CA5/CA7).
 */
const hiddenPeerRunSelect = {
  id: true,
  bot: { select: { parentBotId: true } },
  sourceMessage: { select: { blocks: true, replyTo: { select: { blocks: true } } } },
} satisfies Prisma.RunSelect;

type HiddenPeerRunRow = Prisma.RunGetPayload<{ select: typeof hiddenPeerRunSelect }>;

function asBlocks(blocks: Prisma.JsonValue | undefined): MessageBlock[] {
  return Array.isArray(blocks) ? (blocks as MessageBlock[]) : [];
}

function isHiddenPeerRun(run: HiddenPeerRunRow): boolean {
  if (run.bot.parentBotId != null) return true;
  return !botMessageRunRelaysToUser({
    blocks: asBlocks(run.sourceMessage?.blocks),
    replyToBlocks: asBlocks(run.sourceMessage?.replyTo?.blocks),
  });
}

/** The subset of `runIds` that are hidden peer runs; ordinary triggers are never included. */
export async function hiddenPeerRunIds(prisma: RunDb, runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const runs = await prisma.run.findMany({
    where: { id: { in: runIds }, trigger: "bot_message" },
    select: hiddenPeerRunSelect,
  });
  return new Set(runs.filter(isHiddenPeerRun).map((run) => run.id));
}
