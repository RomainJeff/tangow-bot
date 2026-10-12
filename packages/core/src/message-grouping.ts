import type { MessageBlock, ThreadItem, ThreadMessage } from "@rakazo/contracts";
import { showsTimeMarker } from "./thread-time-markers.js";

/** Consecutive messages from the same bot within this window collapse under one header
 * (Slack-style): the avatar, name, and time show once and later rows just carry content. */
export const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

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

export type NarrationSegment<T> =
  | { kind: "content"; blocks: T[] }
  | { kind: "steps"; block: Extract<MessageBlock, { kind: "steps" }> };

/**
 * A steps block ends the words before it even when hidden: a run's stretch holds every turn of
 * its words, and each turn reads as its own bubble.
 */
export function narrationSegments<T>(
  blocks: readonly MessageBlock[],
  content: (block: MessageBlock) => T | undefined,
  showSteps = true,
): NarrationSegment<T>[] {
  const segments: NarrationSegment<T>[] = [];
  let open: T[] | undefined;
  for (const block of blocks) {
    if (block.kind === "steps") {
      open = undefined;
      if (showSteps) segments.push({ kind: "steps", block });
      continue;
    }
    const drawn = content(block);
    if (drawn === undefined) continue;
    if (open) open.push(drawn);
    else {
      open = [drawn];
      segments.push({ kind: "content", blocks: open });
    }
  }
  return segments;
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

export function computeMessageGroups(
  messages: readonly GroupableMessage[],
  windowMs: number = MESSAGE_GROUP_WINDOW_MS,
): { isFirstOfGroup: boolean; isLastOfGroup: boolean }[] {
  const continues = messages.map((message, index) =>
    continuesGroup(messages[index - 1], message, windowMs),
  );
  return messages.map((_, index) => ({
    isFirstOfGroup: !continues[index],
    isLastOfGroup: !continues[index + 1],
  }));
}

export function computeItemGroups(
  items: readonly ThreadItem[],
): { isFirstOfGroup: boolean; isLastOfGroup: boolean }[] {
  return computeMessageGroups(
    items.map((item): GroupableMessage => {
      if (item.kind !== "message") return { role: "bot", blocks: [], createdAt: item.ts };
      return item.role === "user"
        ? {
            role: "user",
            blocks: item.blocks,
            createdAt: item.ts,
            replyToMessageId: item.replyTo?.entryId,
          }
        : { role: "bot", blocks: item.blocks, createdAt: item.ts, botId: item.botId };
    }),
  );
}
