import type {
  EntryId,
  MessageBlock,
  MessageReaction,
  ProductEvent,
  SessionEntry,
  ThreadItem,
} from "@rakazo/contracts";

type RoutineItem = Extract<ThreadItem, { kind: "routine" }>;
type SentItem = Extract<ThreadItem, { kind: "botMessage"; direction: "sent" }>;

/** One routine run as its line shows it: the run, the bot message it sent right after, if any. */
export type RoutineLineRun = { item: RoutineItem; sentTo?: SentItem; latest: boolean };

/** How a routine item renders once quiet runs of one routine fold: alone, or as the fold's line. */
export type RoutineLineRole = { kind: "run"; run: RoutineLineRun } | { kind: "group"; runs: RoutineLineRun[] };

export type ThreadRow = {
  item: ThreadItem;
  /** Rule R: the row opens a visible group, so its author, avatar and time show. */
  firstOfGroup: boolean;
  lastOfGroup: boolean;
  /** Emoji-only replies folded under the row, in the order they first appeared. */
  reactions: readonly (readonly [MessageReaction, number])[];
  /** Set on a routine item. */
  routine?: RoutineLineRole;
  /** A time marker before the row; `withTime` false between two routine lines, the day only. */
  marker?: { at: string; withTime: boolean };
};

/** The card the thread waits on: an ask, a choice or an approval with no answer, in a run still open. */
export type WaitingCard = { itemId: EntryId; entryId: EntryId; runId: string };

export type ThreadView = {
  rows: ThreadRow[];
  waiting: WaitingCard | null;
  /** The id of the row item that shows each entry, for a jump or a reply preview to find it. */
  rowOf: ReadonlyMap<string, EntryId>;
};

/** The streamed text of each open run since its last entry, by run id. */
export type ProgressLayer = ReadonlyMap<string, { botId: string; ts: string; blocks: MessageBlock[] }>;

export type ThreadViewOptions = {
  /** An item the surface draws nothing for. It is left out before reactions and grouping. */
  rendersNothing?: (item: ThreadItem) => boolean;
  progress?: ProgressLayer;
};

/**
 * The thread the person sees, from the entries a client holds, in any order: rewind and clear cut,
 * then `projectThreadItems`, the progress layer, reactions, groups, the routine fold and time
 * markers. Web, mobile and the API call it on the same entries.
 */
export function projectThreadView(
  _entries: readonly SessionEntry[],
  _options: ThreadViewOptions = {},
): ThreadView {
  throw new Error("not implemented");
}

/** `held` with `incoming` merged in, by seq, each id once. A replayed event or overlapping page adds nothing. */
export function mergeEntries(
  _held: readonly SessionEntry[],
  _incoming: readonly SessionEntry[],
): SessionEntry[] {
  throw new Error("not implemented");
}

/** The entries a `session.entry.appended` event carries, or none for any other event. */
export function appendedEntries(_event: ProductEvent): SessionEntry[] {
  throw new Error("not implemented");
}

/**
 * The layer after one event: `thread.progress` adds to its run, any entry of a run and the run's
 * terminal event clear it.
 */
export function reduceProgressLayer(_layer: ProgressLayer, _event: ProductEvent): ProgressLayer {
  throw new Error("not implemented");
}

/** The items with one live bot message per open run that has streamed text, after them. */
export function applyProgressLayer(
  _items: readonly ThreadItem[],
  _layer: ProgressLayer,
): ThreadItem[] {
  throw new Error("not implemented");
}

/**
 * A page with a hidden peer run's work left out: its receipts, its cards and the words it addressed
 * to the person stay.
 */
export function visibleEntries(
  _entries: readonly SessionEntry[],
  _options: { hiddenPeerRunIds: ReadonlySet<string>; includePeerRuns?: boolean },
): SessionEntry[] {
  throw new Error("not implemented");
}
