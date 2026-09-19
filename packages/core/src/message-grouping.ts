import type { ThreadMessage } from "@rakazo/contracts";
import { showsTimeMarker } from "./thread-time-markers.js";

/** Consecutive messages from the same bot within this window collapse under one header
 * (Slack-style): the avatar, name, and time show once and later rows just carry content. */
export const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Whether a message is pure narration: bot prose with no rich card. This is the single
 * source of truth for "narration" used to decide whether a message can safely sit under a
 * shared header — a card (ask, choice, chart, ...) always gets its own header so it reads
 * as a distinct event.
 */
export function isNarrationMessage(message: Pick<ThreadMessage, "role" | "blocks">): boolean {
  return (
    message.role === "bot" &&
    message.blocks.length > 0 &&
    message.blocks.every(
      (block) => block.kind === "text" || block.kind === "progress" || block.kind === "steps",
    )
  );
}

/**
 * Whether `message` continues `previous`'s group, so the UI suppresses the repeated
 * avatar/name/time header. A group breaks on any of:
 * - no previous message;
 * - either message isn't from a bot;
 * - a different bot (or no bot id) sent `message`;
 * - `message` replies to a parent message (a reply always starts a new group);
 * - either message is not pure narration (a rich card on either side breaks the group);
 * - a time marker would show between them (day change or >= 4h gap);
 * - the gap between them is negative, non-finite, or exceeds `windowMs`.
 */
export function continuesMessageGroup(
  previous:
    | Pick<ThreadMessage, "role" | "botId" | "createdAt" | "blocks" | "replyToMessageId">
    | undefined,
  message: Pick<ThreadMessage, "role" | "botId" | "createdAt" | "blocks" | "replyToMessageId">,
  windowMs: number = MESSAGE_GROUP_WINDOW_MS,
): boolean {
  if (previous == null) return false;
  if (message.role !== "bot" || previous.role !== "bot") return false;
  if (!message.botId || message.botId !== previous.botId) return false;
  if (message.replyToMessageId != null) return false;
  if (!isNarrationMessage(previous) || !isNarrationMessage(message)) return false;
  if (showsTimeMarker(previous.createdAt, message.createdAt)) return false;

  const deltaMs = new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime();
  return Number.isFinite(deltaMs) && deltaMs >= 0 && deltaMs <= windowMs;
}

/**
 * Projects `continuesMessageGroup` over a whole transcript. `options.isTransparent` is injected
 * by the caller (rather than inferred here) so this stays pure and offline-testable: a
 * transparent message (an aside, or a message that renders nothing) always gets its own `false`
 * flag and is skipped when tracking the last row, so it never breaks a group between the
 * narration messages around it.
 */
export function computeGroupContinuations(
  messages: ThreadMessage[],
  options: { isTransparent: (message: ThreadMessage) => boolean; windowMs?: number },
): boolean[] {
  const continuations: boolean[] = [];
  let lastRow: ThreadMessage | undefined;

  for (const message of messages) {
    if (options.isTransparent(message)) {
      continuations.push(false);
      continue;
    }
    continuations.push(continuesMessageGroup(lastRow, message, options.windowMs));
    lastRow = message;
  }

  return continuations;
}
