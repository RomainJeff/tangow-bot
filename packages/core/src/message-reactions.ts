import type { EntryId, MessageBlock, MessageReaction, ThreadItem } from "@rakazo/contracts";
import { MessageReactionSchema } from "@rakazo/contracts";

type ReactionMessage = {
  id: string;
  role: string;
  blocks: MessageBlock[];
  replyToMessageId?: string | null;
};

/** Emoji-only user replies are conversation messages displayed compactly beneath their target. */
export function messageReaction(
  message: Pick<ReactionMessage, "role" | "blocks" | "replyToMessageId">,
): MessageReaction | null {
  if (message.role !== "user" || !message.replyToMessageId || message.blocks.length !== 1)
    return null;
  const block = message.blocks[0];
  return block?.kind === "text" ? (MessageReactionSchema.safeParse(block.text).data ?? null) : null;
}

export type ItemReactions = readonly (readonly [MessageReaction, number])[];

export function foldItemReactions(
  items: readonly ThreadItem[],
  rowOf: ReadonlyMap<string, EntryId>,
): {
  items: ThreadItem[];
  reactions: Map<EntryId, ItemReactions>;
  parentOf: Map<EntryId, EntryId>;
} {
  const byId = new Map(items.map((item) => [item.id, item]));
  const counts = new Map<EntryId, Map<MessageReaction, number>>();
  const parentOf = new Map<EntryId, EntryId>();
  const kept = items.filter((item) => {
    const emoji = itemReaction(item);
    const target = item.kind === "message" && item.role === "user" ? item.replyTo : undefined;
    const parentId = target && rowOf.get(target.entryId);
    const parent = parentId === undefined ? undefined : byId.get(parentId);
    if (!emoji || !parent || parent === item || itemReaction(parent)) return true;
    const emojis = counts.get(parent.id) ?? new Map<MessageReaction, number>();
    emojis.set(emoji, (emojis.get(emoji) ?? 0) + 1);
    counts.set(parent.id, emojis);
    parentOf.set(item.id, parent.id);
    return false;
  });
  const reactions = new Map([...counts].map(([id, emojis]) => [id, [...emojis]] as const));
  return { items: kept, reactions, parentOf };
}

function itemReaction(item: ThreadItem): MessageReaction | null {
  if (item.kind !== "message" || item.role !== "user") return null;
  return messageReaction({
    role: "user",
    blocks: item.blocks,
    replyToMessageId: item.replyTo?.entryId,
  });
}
