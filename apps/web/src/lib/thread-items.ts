import type { ProductEvent, SessionEntryOf, SessionId, ThreadItem } from "@rakazo/contracts";
import { appendedEntries } from "@rakazo/core";

export type ItemOf<K extends ThreadItem["kind"]> = Extract<ThreadItem, { kind: K }>;
export type MessageItem = ItemOf<"message">;

export type CardAnswerTarget = { runId: string; messageId: string };

export type SessionViewTarget =
  | { kind: "session"; sessionId: SessionId; title: string }
  | { kind: "run"; runId: string; title: string };

export function botIdOf(item: MessageItem): string | undefined {
  return item.role === "bot" ? item.botId : undefined;
}

const BOT_WORDS_TYPES = [
  "assistant.text",
  "bot.text",
  "assistant.ask",
  "assistant.choice",
  "effect.requested",
] as const;
type BotWords = SessionEntryOf<(typeof BOT_WORDS_TYPES)[number]>;
const BOT_WORDS = new Set<string>(BOT_WORDS_TYPES);

/** What a bot said to the person in this event: a reply, a question, or a card to act on. */
export function botWordsOf(event: ProductEvent): BotWords[] {
  return appendedEntries(event).filter((entry): entry is BotWords => BOT_WORDS.has(entry.type));
}

export function textOfBotWords(entry: BotWords): string {
  switch (entry.type) {
    case "assistant.text":
    case "bot.text":
      return entry.payload.blocks
        .map((block) => (block.kind === "text" ? block.text : ""))
        .filter(Boolean)
        .join("\n");
    case "assistant.ask":
      return entry.payload.block.text;
    case "assistant.choice":
      return entry.payload.block.question;
    case "effect.requested":
      return entry.payload.card?.text ?? "";
  }
}

export function isLiveItem(item: ThreadItem): boolean {
  return item.kind === "message" && item.role === "bot" && item.live === true;
}
