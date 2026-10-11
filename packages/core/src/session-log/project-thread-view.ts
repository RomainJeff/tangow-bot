import type {
  EntryId,
  MessageBlock,
  ProductEvent,
  SessionEntry,
  SessionEntryType,
  ThreadItem,
} from "@rakazo/contracts";
import { CARD_STATE_TYPES, SessionEntrySchema } from "@rakazo/contracts";
import { isRunTerminalEvent, progressMessageId, reduceLiveMessageBlocks } from "../events.js";
import { computeItemGroups } from "../message-grouping.js";
import type { ItemReactions } from "../message-reactions.js";
import { foldItemReactions } from "../message-reactions.js";
import type { RoutineLineRole } from "../routine-groups.js";
import { foldRoutineItems } from "../routine-groups.js";
import { showsTimeMarker } from "../thread-time-markers.js";
import type { WaitingCard } from "./project-ui.js";
import { projectThread } from "./project-ui.js";

export type ThreadRow = {
  item: ThreadItem;
  /** Rule R: the row opens a visible group, so its author, avatar and time show. */
  firstOfGroup: boolean;
  lastOfGroup: boolean;
  /** Emoji-only replies folded under the row, in the order they first appeared. */
  reactions: ItemReactions;
  /** Set on a routine item. */
  routine?: RoutineLineRole;
  /** A time marker before the row; `withTime` false between two routine lines, the day only. */
  marker?: { at: string; withTime: boolean };
  /** The id a reply or a reaction to the row names: the published message the row starts with. */
  messageId?: EntryId;
};

export type ThreadView = {
  rows: ThreadRow[];
  waiting: WaitingCard | null;
  /** The id of the row item that shows each entry, for a jump or a reply preview to find it. */
  rowOf: ReadonlyMap<string, EntryId>;
};

/** The streamed text of each open run since its last entry, by run id. */
export type ProgressLayer = ReadonlyMap<
  string,
  { botId: string; ts: string; blocks: MessageBlock[] }
>;

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
  entries: readonly SessionEntry[],
  options: ThreadViewOptions = {},
): ThreadView {
  const projected = projectThread(onChain(entries));
  const drawn = applyProgressLayer(projected.items, options.progress ?? new Map()).filter(
    (item) => !options.rendersNothing?.(item),
  );
  const { items, reactions, parentOf } = foldItemReactions(drawn, projected.shownBy);
  const groups = computeItemGroups(items);
  const roles = foldRoutineItems(items);
  const hostOf = new Map<string, EntryId>(parentOf);
  const rows: ThreadRow[] = [];
  let previous: { ts: string; routine: boolean } | undefined;
  for (const [index, item] of items.entries()) {
    const role = roles.get(item.id);
    if (role?.kind === "hidden") continue;
    for (const run of role?.kind === "group" ? role.runs : role ? [role.run] : []) {
      hostOf.set(run.item.id, item.id);
      if (run.sentTo) hostOf.set(run.sentTo.id, item.id);
    }
    const routine = role !== undefined;
    const at = role?.kind === "group" ? (role.runs[0]?.item.ts ?? item.ts) : item.ts;
    const shows =
      routine && previous?.routine
        ? new Date(previous.ts).toDateString() !== new Date(at).toDateString()
        : showsTimeMarker(previous?.ts, at);
    const messageId = projected.messageIds.get(item.id);
    rows.push({
      item,
      firstOfGroup: groups[index]?.isFirstOfGroup ?? true,
      lastOfGroup: groups[index]?.isLastOfGroup ?? true,
      reactions: reactions.get(item.id) ?? [],
      ...(role ? { routine: role } : {}),
      ...(shows ? { marker: { at, withTime: !routine } } : {}),
      ...(messageId ? { messageId } : {}),
    });
    previous = { ts: item.ts, routine };
  }
  const shown = new Set<string>(rows.map((row) => row.item.id));
  const rowOf = new Map<string, EntryId>();
  for (const [entryId, itemId] of projected.shownBy) {
    const rowId = hostOf.get(itemId) ?? itemId;
    if (shown.has(rowId)) rowOf.set(entryId, rowId);
  }
  return { rows, waiting: projected.waiting, rowOf };
}

/**
 * The entries a reader of the chain would get: each id once in seq order, with what a `rewind`
 * cut and what came before a `clear` left out. A page the server walked is already this; a jump
 * page detached from the rest still shows.
 */
function onChain(entries: readonly SessionEntry[]): SessionEntry[] {
  let kept: SessionEntry[] = [];
  for (const entry of byId(entries)) {
    if (entry.type === "rewind") {
      const parent = kept.find((candidate) => candidate.id === entry.parentId);
      kept = parent ? kept.filter((candidate) => candidate.seq <= parent.seq) : [];
    } else if (entry.type === "clear") {
      kept = [];
    }
    kept.push(entry);
  }
  return kept;
}

/** `held` with `incoming` merged in, by seq, each id once. A replayed event or overlapping page adds nothing. */
export function mergeEntries(
  held: readonly SessionEntry[],
  incoming: readonly SessionEntry[],
): SessionEntry[] {
  return byId([...held, ...incoming]);
}

/** What a client holds of a thread's log, web and mobile alike. */
export type ThreadEntries = {
  /** The tail and the older pages loaded since, any order. */
  entries: SessionEntry[];
  olderCursor: EntryId | null;
  /** The seq of the newest event applied. */
  cursor?: number;
  layer: ProgressLayer;
};

/** A snapshot as held: the progress events it replays folded into the layer. */
export function threadEntriesOf<S extends { progress: readonly ProductEvent[] }>(
  snapshot: S,
): Omit<S, "progress"> & { layer: ProgressLayer } {
  const { progress, ...held } = snapshot;
  return { ...held, layer: progress.reduce<ProgressLayer>(reduceProgressLayer, new Map()) };
}

/**
 * The state after a `session.entry.appended` or `thread.progress` event. The layer appends deltas,
 * so an event the cursor already covers changes nothing.
 */
export function applyEntryEvent<S extends ThreadEntries>(state: S, event: ProductEvent): S {
  if (state.cursor !== undefined && event.seq <= state.cursor) return state;
  const appended = appendedEntries(event);
  return {
    ...state,
    cursor: event.seq,
    entries: appended.length > 0 ? mergeEntries(state.entries, appended) : state.entries,
    layer: reduceProgressLayer(state.layer, event),
  };
}

/**
 * `next`, a refresh of the thread `prev` holds. With `preserveHistory` it keeps the held entries
 * older than its page and the cursor past them, when its page joins them.
 */
export function withRefreshedEntries<S extends ThreadEntries>(
  prev: ThreadEntries,
  next: S,
  preserveHistory: boolean,
): S {
  if (!preserveHistory || !joinsHeld(next.entries, prev.entries)) return next;
  const firstSeq = next.entries[0]?.seq ?? Number.NEGATIVE_INFINITY;
  return {
    ...next,
    entries: mergeEntries(
      prev.entries.filter((entry) => entry.seq < firstSeq),
      next.entries,
    ),
    olderCursor: prev.olderCursor,
  };
}

/**
 * Whether a page, oldest first, joins the entries held: it starts the chain or its oldest entry
 * follows one held. A page that does not, such as the newest page refreshed under a jump window,
 * would leave a silent gap if merged.
 */
function joinsHeld(page: readonly SessionEntry[], held: readonly SessionEntry[]): boolean {
  const oldest = page[0];
  return !oldest || oldest.parentId === null || held.some((entry) => entry.id === oldest.parentId);
}

/** An older page merged before the held entries; once nothing older is left, a stale page adds nothing. */
export function withOlderEntries<S extends ThreadEntries>(
  prev: S,
  page: { entries: readonly SessionEntry[]; olderCursor: EntryId | null },
): S {
  if (prev.olderCursor === null) return prev;
  return {
    ...prev,
    entries: mergeEntries(prev.entries, page.entries),
    olderCursor: page.olderCursor,
  };
}

function byId(entries: readonly SessionEntry[]): SessionEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()].sort(
    (a, b) => a.seq - b.seq,
  );
}

const SessionEntries = SessionEntrySchema.array();
const appendedOf = new WeakMap<ProductEvent, readonly SessionEntry[]>();

/** The entries a `session.entry.appended` event carries, or none for any other event. */
export function appendedEntries(event: ProductEvent): readonly SessionEntry[] {
  if (event.type !== "session.entry.appended") return [];
  let entries = appendedOf.get(event);
  if (!entries) {
    entries = SessionEntries.safeParse(event.payload.entries).data ?? [];
    appendedOf.set(event, entries);
  }
  return entries;
}

/**
 * The layer after one event: `thread.progress` adds to its run, any entry of a run and the run's
 * terminal event clear it.
 */
export function reduceProgressLayer(layer: ProgressLayer, event: ProductEvent): ProgressLayer {
  if (event.type === "thread.progress") {
    if (!event.runId) return layer;
    const blocks = reduceLiveMessageBlocks(layer.get(event.runId)?.blocks ?? [], event.payload);
    return new Map(layer).set(event.runId, { botId: event.botId, ts: event.createdAt, blocks });
  }
  const ended =
    event.type === "session.entry.appended"
      ? appendedEntries(event).flatMap((entry) => (entry.runId ? [entry.runId] : []))
      : isRunTerminalEvent(event) && event.runId
        ? [event.runId]
        : [];
  if (!ended.some((runId) => layer.has(runId))) return layer;
  const next = new Map(layer);
  for (const runId of ended) next.delete(runId);
  return next;
}

/** The items with one live bot message per open run that has streamed text, after them. */
export function applyProgressLayer(
  items: readonly ThreadItem[],
  layer: ProgressLayer,
): ThreadItem[] {
  const live = [...layer].flatMap(([runId, run]): ThreadItem[] =>
    run.blocks.length === 0
      ? []
      : [
          {
            kind: "message",
            role: "bot",
            id: progressMessageId(runId) as EntryId,
            ts: run.ts,
            botId: run.botId,
            runId,
            blocks: run.blocks,
            live: true,
          },
        ],
  );
  return [...items, ...live];
}

/**
 * What a hidden peer run keeps on a page: its receipts, its cards, the words it addressed to the
 * person, and the entries that settle a card or annotate a message, which show nothing alone.
 */
const PEER_RUN_KEPT_TYPES = new Set<SessionEntryType>([
  "assistant.ask",
  "assistant.choice",
  "effect.requested",
  "effect.edited",
  "effect.resolved",
  ...CARD_STATE_TYPES,
  "bot.message.sent",
  "bot.message.received",
]);

/**
 * A page with a hidden peer run's work left out: its receipts, its cards and the words it addressed
 * to the person stay.
 */
export function visibleEntries(
  entries: readonly SessionEntry[],
  options: { hiddenPeerRunIds: ReadonlySet<string> },
): SessionEntry[] {
  return entries.filter(
    (entry) =>
      !entry.runId ||
      !options.hiddenPeerRunIds.has(entry.runId) ||
      PEER_RUN_KEPT_TYPES.has(entry.type) ||
      (entry.type === "assistant.text" && entry.payload.toPerson === true),
  );
}
