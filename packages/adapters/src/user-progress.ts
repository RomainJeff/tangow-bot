import {
  type MessageBlock,
  USER_MESSAGE_CLIENT_NONCE_PREFIX,
  USER_PROGRESS_CLIENT_NONCE_PREFIX,
} from "@rakazo/contracts";
import { isToolActivityBlock, joinTurnText } from "@rakazo/core";

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
  "The user sent this message while you were still working. Respond to what is new in it. If it revisits a point you already settled or explained earlier in this conversation, acknowledge it in one short line and move on — never re-explain or restate what you already said. Do not silently ignore it either.";

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
  return { text: parts.reduce(joinTurnText, ""), remaining };
}

/**
 * Normalize a bubble for repeat detection: lowercase, collapse whitespace, and drop leading and
 * trailing punctuation/quotes. This catches a bubble re-sent with only cosmetic differences
 * (case, spacing, a different closing period, wrapping quotes) — the near-exact repeat that a
 * strict trim-equality check let through. It deliberately does NOT try to match paraphrases with
 * different wording; that is handled by the model's instructions, not here, to avoid false
 * positives that would swallow a legitimately new message.
 */
const REPEAT_EDGE_PUNCTUATION =
  /^[\s.,;:!?…"'«»“”‘’`()[\]{}\-—–*_#>]+|[\s.,;:!?…"'«»“”‘’`()[\]{}\-—–*_#>]+$/gu;
export function normalizeForRepeatCheck(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase().replace(REPEAT_EDGE_PUNCTUATION, "").trim();
}

/**
 * True when `text` is, up to cosmetic differences, a message the user was already shown in this
 * run. Shared by the `message_user` tool (which then refuses to post the bubble again) and the
 * final-reply guard below, so both paths agree on what counts as a repeat. The `alreadySent` list
 * is seeded from the run's prior bot bubbles, so this also catches a bubble re-sent after a
 * pause/resume (an ask answered, a steering message), not only within one continuous stretch.
 */
export function repeatsSentUserText(text: string, alreadySent: readonly string[]): boolean {
  const normalized = normalizeForRepeatCheck(text);
  if (!normalized) return false;
  return alreadySent.some((sent) => normalizeForRepeatCheck(sent) === normalized);
}

/**
 * At the end of a run, should the narration it set aside be published? Only when the run gave no
 * answer of its own and did not hand its work to another bot. A run allowed to stay silent (its
 * own routine, an FYI wake) drops it, except in a messaging app: there is no live view there, so
 * the narration may be the only reply the person gets.
 */
export function publishesHeldNarrationAtEnd(run: {
  answered: boolean;
  handedOff: boolean;
  messagingChannel: boolean;
  mayStaySilent: boolean;
}): boolean {
  if (run.answered || run.handedOff) return false;
  return run.messagingChannel || !run.mayStaySilent;
}

/**
 * A run that may stay silent drops the narration it set aside, except the words written with its
 * last tool call when the run then simply stopped: those are its closing words (a routine's report
 * written alongside a `remember` call), not a preamble like "I'll check the calendar…".
 */
export function publishesClosingNarrationAtEnd(run: {
  answered: boolean;
  handedOff: boolean;
  closingNarration: boolean;
}): boolean {
  return run.closingNarration && !run.answered && !run.handedOff;
}

/**
 * What the runtime posts when a run did tool work but never wrote a reply. It is a notice, not
 * something the bot said, so it does not count as the run having answered.
 */
export const TOOL_FINAL_RESPONSE_FALLBACK =
  "I completed the tool step but could not produce a final response. Please ask me to continue.";

/**
 * Runs each task after the previous one settles, in call order. The runtime executes one step's
 * tool calls in parallel, so without this several `message_user` calls race their inserts and
 * the bubbles land in the thread in whatever order the writes finish.
 */
export function createCallOrderQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task);
    tail = next.catch(() => undefined);
    return next;
  };
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
  // This path drops the final reply SILENTLY, with no error channel back to the model, so it
  // stays on strict (exact-after-trim) equality: only a byte-for-byte repeat is dropped. The
  // broadened, cosmetic-difference match is reserved for `message_user`, which does hand the
  // model an error it can act on — so a false positive there is recoverable, here it is not.
  const remaining = blocks.filter(
    (block) =>
      !(
        block.kind === "text" &&
        block.text.trim().length > 0 &&
        alreadySent.some((sent) => sent.trim() === block.text.trim())
      ),
  );
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
