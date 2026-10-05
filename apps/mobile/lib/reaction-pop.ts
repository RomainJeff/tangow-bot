import { useRef } from "react";

/**
 * 7d's pill pop: a reaction pill pops when it appears or its count goes up,
 * whoever reacted — never on mount alone. The fold is pure and keyed by
 * `${messageId}:${emoji}` so a screen can look up "did this pill just pop"
 * for any pill it renders this pass.
 */

export type ReactionCounts = ReadonlyMap<string, number>;

export interface ReactionPopTracker {
  readonly counts: ReadonlyMap<string, ReactionCounts>;
}

export function emptyReactionPopTracker(): ReactionPopTracker {
  return { counts: new Map() };
}

export interface FoldReactionPopsOptions {
  /** Thread mount or thread switch: learn the current counts, pop nothing. */
  seed?: boolean;
}

export interface FoldReactionPopsResult {
  popped: ReadonlySet<string>;
  tracker: ReactionPopTracker;
}

export function reactionPopKey(messageId: string, emoji: string): string {
  return `${messageId}:${emoji}`;
}

export function foldReactionPops(
  tracker: ReactionPopTracker,
  reactions: ReadonlyMap<string, ReactionCounts>,
  options: FoldReactionPopsOptions = {},
): FoldReactionPopsResult {
  const popped = new Set<string>();
  const nextCounts = new Map(tracker.counts);
  for (const [messageId, emojiCounts] of reactions) {
    const previous = tracker.counts.get(messageId);
    for (const [emoji, count] of emojiCounts) {
      const previousCount = previous?.get(emoji) ?? 0;
      if (!options.seed && count > previousCount) {
        popped.add(reactionPopKey(messageId, emoji));
      }
    }
    nextCounts.set(messageId, new Map(emojiCounts));
  }
  return { popped, tracker: { counts: nextCounts } };
}

/** Tracks reaction pops for one thread across renders, mirroring
 * `useMessageArrivals`. Resets when `threadKey` changes. */
export function useReactionPops(
  threadKey: string | undefined,
  reactions: ReadonlyMap<string, ReactionCounts>,
): ReadonlySet<string> {
  const stateRef = useRef<{ threadKey: string | undefined; tracker: ReactionPopTracker }>({
    threadKey,
    tracker: emptyReactionPopTracker(),
  });

  if (stateRef.current.threadKey !== threadKey) {
    const { tracker } = foldReactionPops(emptyReactionPopTracker(), reactions, { seed: true });
    stateRef.current = { threadKey, tracker };
    return EMPTY_SET;
  }

  const { popped, tracker } = foldReactionPops(stateRef.current.tracker, reactions);
  stateRef.current = { threadKey, tracker };
  return popped;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
