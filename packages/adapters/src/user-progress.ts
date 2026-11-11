import type { MessageBlock } from "@tangow/contracts";
import { isToolActivityBlock } from "@tangow/core";

/**
 * Pull narration text out of the in-progress turn segments so it can be posted
 * as a durable mid-turn message. Tool/step blocks stay for the final publish.
 */

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
  return { text: parts.join(""), remaining };
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

/** What a runtime says when a model stops after a tool step without answering. */
export const TOOL_FINAL_RESPONSE_FALLBACK =
  "I completed the tool step but could not produce a final response. Please ask me to continue.";
