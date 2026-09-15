import {
  type MessageBlock,
  USER_MESSAGE_CLIENT_NONCE_PREFIX,
  USER_PROGRESS_CLIENT_NONCE_PREFIX,
} from "@rakazo/contracts";
import { isToolActivityBlock } from "@rakazo/core";

/** Keep mid-turn progress beats short; prefer a few high-signal updates. */
export const USER_PROGRESS_MESSAGE_MAX_LENGTH = 500;

export function clampUserProgressMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= USER_PROGRESS_MESSAGE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, USER_PROGRESS_MESSAGE_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * True when the raw text a caller tried to post as a mid-turn progress update
 * would not fit and got cut off by clampUserProgressMessage. Callers should
 * surface this back to the model (it gets no other signal that its message
 * was mangled) rather than reporting a silent success.
 */
export function isProgressMessageTruncated(text: string): boolean {
  return text.trim().length > USER_PROGRESS_MESSAGE_MAX_LENGTH;
}

/**
 * Pull narration text out of the in-progress turn segments so it can be posted
 * as a durable mid-turn message. Tool/step blocks stay for the final publish.
 */

/** clientNonce prefixes for mid-turn messages (reconciler uses these).
 * Canonical definitions live in @rakazo/contracts; re-exported for existing importers. */
export { USER_MESSAGE_CLIENT_NONCE_PREFIX, USER_PROGRESS_CLIENT_NONCE_PREFIX };

function midTurnClientNonce(prefix: string, runId: string, index: number): string {
  // Include entropy so a resumed executor turn cannot reuse an earlier nonce
  // (threadId + clientNonce is unique).
  return `${prefix}${runId}:${index}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

/** Nonce for narration the executor publishes on its own initiative. */
export function userProgressClientNonce(runId: string, index = 0): string {
  return midTurnClientNonce(USER_PROGRESS_CLIENT_NONCE_PREFIX, runId, index);
}

/** Nonce for `message_user` output — text the bot deliberately addressed to the user. */
export function userMessageClientNonce(runId: string, index = 0): string {
  return midTurnClientNonce(USER_MESSAGE_CLIENT_NONCE_PREFIX, runId, index);
}

/**
 * True for either mid-turn kind (narration or `message_user`). Callers that rebuild the
 * mid-turn transcript (executor resume, job reconciler) want both; the peer-visibility gate
 * does not — it uses `isUserDirectedMessage` in @rakazo/core instead.
 */
export function isUserProgressClientNonce(clientNonce: string | null | undefined): boolean {
  return Boolean(
    clientNonce?.startsWith(USER_PROGRESS_CLIENT_NONCE_PREFIX) ||
      clientNonce?.startsWith(USER_MESSAGE_CLIENT_NONCE_PREFIX),
  );
}

/**
 * Steering = a user message that arrived while the bot was already working. The reply must
 * take it into account visibly; a silent "read" is exactly what users perceive as being ignored.
 */
export const STEERING_USER_MESSAGE_PREAMBLE =
  "The user sent this message while you were still working. Address it explicitly in your reply before you finish this turn; do not merely acknowledge it.";

/** Compose the text shown to the model for a steering (mid-run) user message. */
export function buildSteeringMessageText(
  text: string,
  filesInstruction?: string,
  unavailableInstruction?: string,
): string {
  return [STEERING_USER_MESSAGE_PREAMBLE, text, filesInstruction, unavailableInstruction]
    .filter(Boolean)
    .join("\n\n");
}

export function extractNarrationText(
  segments: readonly MessageBlock[],
  currentText: string,
): { text: string; remaining: MessageBlock[] } {
  const parts: string[] = [];
  const remaining: MessageBlock[] = [];
  for (const block of segments) {
    if (block.kind === "text") {
      if (block.text) parts.push(block.text);
      continue;
    }
    remaining.push(block);
  }
  if (currentText) parts.push(currentText);
  return { text: parts.join(""), remaining };
}

/**
 * After mid-turn progress messages were already posted, skip a hollow final
 * message that would only carry hidden tool-activity blocks (or nothing).
 *
 * `alreadySent` carries the mid-turn text the user has already been shown. A model that
 * answers with `message_user` and then repeats the same words as its final reply would post
 * that answer to the thread twice in a row; the mid-turn message already delivered it, so
 * the repeat is dropped and a final message left with nothing of its own is not posted.
 */
export function finalBlocksAfterMidTurnProgress(
  blocks: MessageBlock[],
  publishedMidTurn: boolean,
  alreadySent: readonly string[] = [],
): MessageBlock[] {
  if (!publishedMidTurn || blocks.length === 0) return blocks;
  const sent = new Set(alreadySent.map((text) => text.trim()).filter(Boolean));
  const remaining =
    sent.size === 0
      ? blocks
      : blocks.filter((block) => !(block.kind === "text" && sent.has(block.text.trim())));
  if (remaining.length === 0) return [];
  if (remaining.every((block) => isToolActivityBlock(block))) return [];
  return remaining;
}

/** Outcome to return for a bot_message run after mid-turn progress posts. */
export function botMessageOutcomeFromMidTurn(
  finalText: string,
  midTurnTexts: readonly string[],
): { text: string; intent: "result" | "status" } | null {
  const trimmed = finalText.trim();
  if (trimmed) return { text: trimmed, intent: "result" };
  const midTurn = midTurnTexts.map((part) => part.trim()).filter(Boolean);
  if (midTurn.length === 0) return null;
  return { text: midTurn.join("\n\n"), intent: "status" };
}
