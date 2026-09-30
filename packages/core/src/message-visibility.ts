import { type MessageBlock, USER_MESSAGE_CLIENT_NONCE_PREFIX } from "@rakazo/contracts";

/** Explicit final outcome selected by message_user, shared by every delivery surface. */
export const USER_OUTCOME_CLIENT_NONCE_PREFIX = `${USER_MESSAGE_CLIENT_NONCE_PREFIX}outcome:`;

export function userOutcomeClientNonce(runId: string): string {
  return `${USER_OUTCOME_CLIENT_NONCE_PREFIX}${runId}`;
}

export function isUserOutcomeMessage(message: { clientNonce?: string | null }): boolean {
  return Boolean(message.clientNonce?.startsWith(USER_OUTCOME_CLIENT_NONCE_PREFIX));
}

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
  /**
   * The peer runs to hide, resolved by the caller from the database. This is the only
   * source of peer runs: see `userVisibleMessages`.
   */
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

function isUserOutcomeArtifactDelivery(blocks: readonly MessageBlock[]): boolean {
  return (
    blocks.length > 0 && blocks.every((block) => block.kind === "file" || block.kind === "image")
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

/**
 * Drop peer-run activity/replies; keep messages the bot addressed to the user; optionally keep receipts.
 *
 * Peer runs come from `knownPeerRunIds` only, never from the blocks in the page. Whether a
 * `bot_message` run is hidden peer work depends on `bot.parentBotId`, which lives in the
 * database: a sub-bot's delegated run is hidden, a top-level bot's run is its visible relay to
 * the user (background-work-visibility CA5/CA7). Callers holding that answer pass it in; the
 * API already applies the same rule in `withoutPeerRunMessages` before a page or snapshot ships,
 * so a caller rendering server-filtered messages has nothing left to hide. Inferring a peer run
 * from a `bot_message_received` block instead swallowed every top-level relay: the orchestrator
 * replied, the push notification and the sidebar preview carried it, and the thread showed nothing.
 */
export function userVisibleMessages<T extends PresentableMessage>(
  messages: readonly T[],
  options: UserVisibleMessagesOptions = {},
): T[] {
  const peerRunIds = new Set(options.knownPeerRunIds ?? []);
  const includePeerReceipts = options.includePeerReceipts === true;
  // A peer run may attach its deliverable before it calls message_user with the selected
  // result. The selected outcome makes that run's file/image blocks an explicit user delivery;
  // without it they remain internal. This is deliberately independent of list ordering because
  // sidebar queries load newest messages first.
  const peerRunIdsWithUserOutcome = new Set(
    messages
      .filter(
        (message) =>
          !!message.runId && peerRunIds.has(message.runId) && isUserOutcomeMessage(message),
      )
      .map((message) => message.runId!),
  );

  return messages.filter((message) => {
    if (isPeerReceiptBlocks(message.blocks)) return includePeerReceipts;
    const isPeerRunMessage = !!message.runId && peerRunIds.has(message.runId);
    if (!isPeerRunMessage) return true;
    // Delegated run: keep only what the bot explicitly sent to the user. Callers that want
    // ask-only previews (sidebar) opt out of the bot's own reply text.
    if (options.includeDelegatedReplyText === false) {
      return message.blocks.some((block) => block.kind === "ask");
    }
    return (
      isUserDirectedMessage(message) ||
      (peerRunIdsWithUserOutcome.has(message.runId!) &&
        isUserOutcomeArtifactDelivery(message.blocks))
    );
  });
}
