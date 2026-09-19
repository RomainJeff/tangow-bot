import { type MessageBlock, USER_MESSAGE_CLIENT_NONCE_PREFIX } from "@rakazo/contracts";

type PresentableMessage = {
  runId?: string;
  clientNonce?: string | null;
  blocks: readonly MessageBlock[];
};

export type UserVisibleMessagesOptions = {
  /**
   * Keep `bot_message_sent` / `bot_message_received` rows as compact chips
   * (web CollaborationMarker; mobile AgentEventLabel). Peer bodies stay hidden.
   */
  includePeerReceipts?: boolean;
  /** Peer-run ids from `run.trigger === "bot_message"` when receipts may be out of window. */
  knownPeerRunIds?: Iterable<string>;
  /**
   * Surface a peer-run's own `text` reply (e.g. a delegating bot's summary to the user)
   * alongside `ask` cards. Defaults to true for chat-thread rendering; set false for
   * contexts like sidebar previews that should stay ask-only and never echo peer chatter.
   */
  includeDelegatedReplyText?: boolean;
};

export function isPeerReceiptBlocks(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
  );
}

/** A note about the conversation rather than something a bot said to the user. */
const ASIDE_BLOCK_KINDS = new Set<MessageBlock["kind"]>([
  "handoff",
  "bot_message_sent",
  "bot_message_received",
  "channel_message",
  "meta",
]);

/**
 * The whole message is an aside: it reads as one centred line between messages,
 * with no author, no bubble and no message actions. Callers pass the blocks they
 * are about to render, so a hidden activity block cannot make a delegation look
 * like a reply. Role is not an input of this predicate and callers must not gate
 * on it either: an inbound `bot_message_received` receipt is stored with
 * `role: "user"` (it is the recipient's prompt, but still peer activity), and it
 * must render as an aside just the same as an outbound `bot_message_sent` one.
 */
export function isAsideOnlyMessage(blocks: readonly MessageBlock[]): boolean {
  return blocks.length > 0 && blocks.every((block) => ASIDE_BLOCK_KINDS.has(block.kind));
}

/**
 * A message a bot addressed to the user on purpose: `message_user` output (carries the
 * user-message clientNonce) or an `ask_user` question (an `ask` block). These must reach the
 * user even inside a delegated (peer, `trigger === "bot_message"`) run — a delegated bot has no
 * other way to talk to the user. Internal narration (user-progress clientNonce, published
 * before every tool call) / tool steps / peer receipts are NOT this.
 */
export function isUserDirectedMessage(message: {
  clientNonce?: string | null;
  blocks: readonly MessageBlock[];
}): boolean {
  if (message.clientNonce?.startsWith(USER_MESSAGE_CLIENT_NONCE_PREFIX)) return true;
  return message.blocks.some((block) => block.kind === "ask");
}

/** Drop peer-run activity/replies; keep messages the bot addressed to the user; optionally keep receipts. */
export function userVisibleMessages<T extends PresentableMessage>(
  messages: readonly T[],
  options: UserVisibleMessagesOptions = {},
): T[] {
  const peerRunIds = new Set([
    ...(options.knownPeerRunIds ?? []),
    ...messages
      .filter((message) => message.blocks.some((block) => block.kind === "bot_message_received"))
      .flatMap((message) => (message.runId ? [message.runId] : [])),
  ]);
  const includePeerReceipts = options.includePeerReceipts === true;

  return messages.filter((message) => {
    if (isPeerReceiptBlocks(message.blocks)) return includePeerReceipts;
    const isPeerRunMessage = !!message.runId && peerRunIds.has(message.runId);
    if (!isPeerRunMessage) return true;
    // Delegated run: keep only what the bot explicitly sent to the user. Callers that want
    // ask-only previews (sidebar) opt out of the bot's own reply text.
    if (options.includeDelegatedReplyText === false) {
      return message.blocks.some((block) => block.kind === "ask");
    }
    return isUserDirectedMessage(message);
  });
}
