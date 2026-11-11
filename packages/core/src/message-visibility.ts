import type { MessageBlock } from "@tangow/contracts";

/** A note about the conversation rather than something a bot said to the user. */
const ASIDE_BLOCK_KINDS = new Set<MessageBlock["kind"]>(["handoff", "channel_message", "meta"]);

/**
 * The whole message is an aside: it reads as one centred line between messages,
 * with no author, no bubble and no message actions. Callers pass the blocks they
 * are about to render, so a hidden activity block cannot make a delegation look
 * like a reply.
 */
export function isAsideOnlyMessage(blocks: readonly MessageBlock[]): boolean {
  return blocks.length > 0 && blocks.every((block) => ASIDE_BLOCK_KINDS.has(block.kind));
}
