import type { MessageBlock, SessionEntry } from "@rakazo/contracts";
import { rpc } from "./helpers";
import type { Page } from "./test";

type ThreadTarget = { botId: string } | { groupId: string };

/** The newest page of a thread's log, as `threads.messages` serves it. */
export async function threadEntries(
  page: Page,
  target: ThreadTarget & { includePeerRuns?: boolean },
): Promise<SessionEntry[]> {
  return (await rpc<{ entries: SessionEntry[] }>(page, "threads/messages", target)).entries;
}

/** Every block the entries show: the words, the cards and the receipts. */
export function blocksOf(entries: readonly SessionEntry[]): MessageBlock[] {
  return entries.flatMap((entry): MessageBlock[] => {
    switch (entry.type) {
      case "user.message":
      case "assistant.text":
      case "bot.text":
        return entry.payload.blocks;
      case "assistant.ask":
      case "assistant.choice":
        return [entry.payload.block];
      default:
        return [];
    }
  });
}

/** The entry that settled a card: a reply naming it, or a `card.answered` targeting it. */
export function answerOf(entries: readonly SessionEntry[], cardId: string) {
  return entries.find(
    (entry) =>
      (entry.type === "user.message" && entry.payload.replyTo?.entryId === cardId) ||
      (entry.type === "card.answered" && entry.payload.target === cardId),
  );
}
