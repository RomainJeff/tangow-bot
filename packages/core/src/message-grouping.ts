import type { ThreadMessage } from "@rakazo/contracts";
import { showsTimeMarker } from "./thread-time-markers.js";

/** Consecutive messages from the same bot within this window collapse under one header
 * (Slack-style): the avatar, name, and time show once and later rows just carry content. */
export const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * The shape `computeMessageGroups` (and `computeGroupContinuations`) needs from a message.
 * `createdAt` is optional here, unlike on `ThreadMessage`, because mobile's `MobileMessage`
 * only has one once a streaming delta finishes: a message without it never continues a group
 * and is never continued into (see `continuesGroup`).
 */
export type GroupableMessage = Pick<ThreadMessage, "role" | "blocks" | "replyToMessageId"> & {
  botId?: ThreadMessage["botId"];
  createdAt?: ThreadMessage["createdAt"];
};

/**
 * Whether a message is pure narration: bot prose with no rich card. This is the single
 * source of truth for "narration" used to decide whether a message can safely sit under a
 * shared header — a card (ask, choice, chart, ...) always gets its own header so it reads
 * as a distinct event. A link preview or a skill line is not such a card: it hangs off the
 * prose and arrives after it, so it must not change how the message groups.
 */
export function isNarrationMessage(message: Pick<ThreadMessage, "role" | "blocks">): boolean {
  return (
    message.role === "bot" &&
    message.blocks.length > 0 &&
    message.blocks.every(
      (block) =>
        block.kind === "text" ||
        block.kind === "progress" ||
        block.kind === "steps" ||
        block.kind === "link_preview" ||
        block.kind === "skill_source",
    )
  );
}

/**
 * Whether a message is pure user narration: text only, no attachment/image/file block.
 * Mentions live inline in the text, so they never affect this. The user-side counterpart of
 * `isNarrationMessage`, and the gate for user-to-user grouping (rule R, step 3).
 */
export function isUserNarrationMessage(message: Pick<ThreadMessage, "role" | "blocks">): boolean {
  return (
    message.role === "user" &&
    message.blocks.length > 0 &&
    message.blocks.every((block) => block.kind === "text" || block.kind === "link_preview")
  );
}

/** Shared window/time-marker gate for both the bot and the user continuity checks. */
function withinGroupWindow(
  previousCreatedAt: string,
  createdAt: string,
  windowMs: number,
): boolean {
  if (showsTimeMarker(previousCreatedAt, createdAt)) return false;
  const deltaMs = new Date(createdAt).getTime() - new Date(previousCreatedAt).getTime();
  return Number.isFinite(deltaMs) && deltaMs >= 0 && deltaMs <= windowMs;
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
  return withinGroupWindow(previous.createdAt, message.createdAt, windowMs);
}

/**
 * Whether `message` continues `previous`'s group under the full rule R: bot continuity
 * (`continuesMessageGroup`'s semantics) or user continuity (two consecutive text-only user
 * messages, same window/time-marker/reply conditions). A message without `createdAt`, on
 * either side, never continues and is never continued into.
 */
function continuesGroup(
  previous: GroupableMessage | undefined,
  message: GroupableMessage,
  windowMs: number,
): boolean {
  if (previous == null) return false;
  if (previous.createdAt == null || message.createdAt == null) return false;
  if (message.replyToMessageId != null) return false;

  const bothBotNarration =
    message.role === "bot" &&
    previous.role === "bot" &&
    message.botId != null &&
    message.botId === previous.botId &&
    isNarrationMessage(previous) &&
    isNarrationMessage(message);
  const bothUserNarration = isUserNarrationMessage(previous) && isUserNarrationMessage(message);
  if (!bothBotNarration && !bothUserNarration) return false;

  return withinGroupWindow(previous.createdAt, message.createdAt, windowMs);
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

/**
 * The single source of truth for rule R (see `docs/design-system.md` § Grouping): for every
 * input message, whether it opens and/or closes a visible group. Both web and mobile call this
 * once on the canonical chronological message list and index the result by message id — no
 * renderer recomputes grouping from its own (possibly reversed) index.
 *
 * `options.isTransparent` marks messages that render nothing at all (a legacy block this
 * version draws nothing for): they always get `{ isFirstOfGroup: false, isLastOfGroup: false }`
 * and are skipped when looking for the previous/next visible message, so they can never break a
 * group. Asides (handoffs, peer receipts, `meta`) are NOT transparent — they are non-narration
 * messages, so they naturally form a group of one (`isNarrationMessage` / `isUserNarrationMessage`
 * are both false for them) and the group they interrupt reopens after them.
 */
export function computeMessageGroups<M extends GroupableMessage>(
  messages: readonly M[],
  options: { isTransparent: (message: M) => boolean; windowMs?: number },
): { isFirstOfGroup: boolean; isLastOfGroup: boolean }[] {
  const windowMs = options.windowMs ?? MESSAGE_GROUP_WINDOW_MS;
  const results: { isFirstOfGroup: boolean; isLastOfGroup: boolean }[] = messages.map(() => ({
    isFirstOfGroup: false,
    isLastOfGroup: false,
  }));

  // Visible (non-transparent) indices in order, and whether each one continues the previous
  // visible message's group — tracked so the second pass can look ahead without recomputing.
  const visibleIndices: number[] = [];
  const continuesPrevious: boolean[] = new Array(messages.length).fill(false);
  let lastVisible: M | undefined;

  messages.forEach((message, index) => {
    if (options.isTransparent(message)) return;
    const continues = continuesGroup(lastVisible, message, windowMs);
    continuesPrevious[index] = continues;
    results[index]!.isFirstOfGroup = !continues;
    visibleIndices.push(index);
    lastVisible = message;
  });

  visibleIndices.forEach((index, position) => {
    const nextIndex = visibleIndices[position + 1];
    results[index]!.isLastOfGroup = nextIndex === undefined ? true : !continuesPrevious[nextIndex];
  });

  return results;
}
