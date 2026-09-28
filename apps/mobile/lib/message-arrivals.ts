import { useRef } from "react";

/**
 * Only NEW messages animate (design-motion spec, transverse rules): nothing
 * present at thread open, nothing "Load earlier" brings in, nothing in the
 * jump view. This module is the pure core of that rule — `useMessageArrivals`
 * is the thin hook a screen calls; the fold itself takes no React state so it
 * is trivial to unit test.
 */

export interface ArrivalMessage {
  id: string;
  /** The run a streaming placeholder (`progress:<run>`) belongs to. When the
   * server's final message lands with a fresh id but the same `runId`, it is
   * not a new arrival — its content was already on screen, growing. */
  runId?: string;
  createdAt?: string;
}

export interface ArrivalTracker {
  readonly knownIds: ReadonlySet<string>;
  readonly knownRunIds: ReadonlySet<string>;
}

export function emptyArrivalTracker(): ArrivalTracker {
  return { knownIds: new Set(), knownRunIds: new Set() };
}

export interface FoldArrivalsOptions {
  /** Thread mount, "Load earlier", or jumping to a pinned message: every id
   * in this pass is learned, but none is reported as newly arrived. */
  seed?: boolean;
}

export interface FoldArrivalsResult {
  newIds: ReadonlySet<string>;
  tracker: ArrivalTracker;
}

/** Folds one pass of the thread's messages into the tracker. */
export function foldMessageArrivals(
  tracker: ArrivalTracker,
  messages: readonly ArrivalMessage[],
  options: FoldArrivalsOptions = {},
): FoldArrivalsResult {
  const knownIds = new Set(tracker.knownIds);
  const knownRunIds = new Set(tracker.knownRunIds);
  const newIds = new Set<string>();
  for (const message of messages) {
    const alreadyKnown =
      knownIds.has(message.id) || (message.runId ? knownRunIds.has(message.runId) : false);
    if (!alreadyKnown && !options.seed) newIds.add(message.id);
    knownIds.add(message.id);
    if (message.runId) knownRunIds.add(message.runId);
  }
  return { newIds, tracker: { knownIds, knownRunIds } };
}

const STAGGER_MS = 70;
const STAGGER_CAP = 4;
const STAGGER_WINDOW_MS = 1000;

/**
 * 7b's burst rule: bubbles that arrive within the same second stagger 70 ms
 * apart, capped at 4 — a 5th bubble in the same burst gets the same delay as
 * the 4th rather than a longer one. Arrivals more than a second apart from
 * the start of their bucket start a fresh bucket at delay 0.
 */
export function messageArrivalStaggerMs(
  arrivals: readonly { id: string; createdAt: string }[],
): ReadonlyMap<string, number> {
  const sorted = [...arrivals].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const delays = new Map<string, number>();
  let bucketStart: number | null = null;
  let indexInBucket = 0;
  for (const item of sorted) {
    const t = Date.parse(item.createdAt);
    if (bucketStart === null || t - bucketStart > STAGGER_WINDOW_MS) {
      bucketStart = t;
      indexInBucket = 0;
    }
    delays.set(item.id, Math.min(indexInBucket, STAGGER_CAP - 1) * STAGGER_MS);
    indexInBucket += 1;
  }
  return delays;
}

/**
 * Tracks arrivals for one thread across renders. `seed` should be true while
 * a "Load earlier" fetch is landing, or while the jump/pinned view is showing
 * (its own ScrollView never consults this hook's result, but keeping the
 * tracker seeded there means returning to the live list doesn't treat the
 * jump window's messages as new). Resets automatically when `threadKey`
 * changes.
 */
export function useMessageArrivals(
  threadKey: string | undefined,
  messages: readonly ArrivalMessage[],
  options: FoldArrivalsOptions = {},
): ReadonlySet<string> {
  const stateRef = useRef<{ threadKey: string | undefined; tracker: ArrivalTracker }>({
    threadKey,
    tracker: emptyArrivalTracker(),
  });

  if (stateRef.current.threadKey !== threadKey) {
    // A different thread: seed with whatever is already on screen so nothing
    // present at open animates (MA-1).
    const { tracker } = foldMessageArrivals(emptyArrivalTracker(), messages, { seed: true });
    stateRef.current = { threadKey, tracker };
    return EMPTY_SET;
  }

  const { newIds, tracker } = foldMessageArrivals(stateRef.current.tracker, messages, options);
  stateRef.current = { threadKey, tracker };
  return newIds;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
