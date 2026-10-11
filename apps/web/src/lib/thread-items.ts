import type { ProductEvent, SessionEntryOf, SessionId, ThreadItem } from "@rakazo/contracts";
import { appendedEntries } from "@rakazo/core";

export type ItemOf<K extends ThreadItem["kind"]> = Extract<ThreadItem, { kind: K }>;
export type MessageItem = ItemOf<"message">;

/** What an answer settles: the run that waits and the entry that asked. */
export type CardAnswerTarget = { runId: string; messageId: string };

/** A child session to read: a helper's by its session, a routine run's by its run. */
export type SessionViewTarget =
  | { kind: "session"; sessionId: SessionId; title: string }
  | { kind: "run"; runId: string; title: string };

export function botIdOf(item: MessageItem): string | undefined {
  return item.role === "bot" ? item.botId : undefined;
}

/** The bot's words an event appended: its `assistant.text` and `bot.text` entries. */
export function botWordsOf(event: ProductEvent): SessionEntryOf<"assistant.text" | "bot.text">[] {
  return appendedEntries(event).filter(
    (entry): entry is SessionEntryOf<"assistant.text" | "bot.text"> =>
      entry.type === "assistant.text" || entry.type === "bot.text",
  );
}

export function isLiveItem(item: ThreadItem): boolean {
  return item.kind === "message" && item.role === "bot" && item.live === true;
}
