import { type MessageBlock, USER_PROGRESS_CLIENT_NONCE_PREFIX } from "@rakazo/contracts";

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
};

export function isPeerReceiptBlocks(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
  );
}

/**
 * A message a bot addressed to the user on purpose: `message_user` output (carries the
 * user-progress clientNonce) or an `ask_user` question (an `ask` block). These must reach the
 * user even inside a delegated (peer, `trigger === "bot_message"`) run — a delegated bot has no
 * other way to talk to the user. Internal narration / tool steps / peer receipts are NOT this.
 */
export function isUserDirectedMessage(message: {
  clientNonce?: string | null;
  blocks: readonly MessageBlock[];
}): boolean {
  if (message.clientNonce?.startsWith(USER_PROGRESS_CLIENT_NONCE_PREFIX)) return true;
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
    // Delegated run: keep only what the bot explicitly sent to the user.
    return isUserDirectedMessage(message);
  });
}
