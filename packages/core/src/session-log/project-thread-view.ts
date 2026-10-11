import type {
  EntryId,
  MessageBlock,
  ProductEvent,
  SessionEntry,
  SessionEntryOf,
  SessionEntryType,
  ThreadItem,
} from "@rakazo/contracts";
import { CARD_STATE_TYPES, isLinkPreviewCard, SessionEntrySchema } from "@rakazo/contracts";
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
  firstOfGroup: boolean;
  lastOfGroup: boolean;
  reactions: ItemReactions;
  routine?: RoutineLineRole;
  marker?: { at: string; withTime: boolean };
  messageId?: EntryId;
  previewMessageId?: EntryId;
};

export type ThreadView = {
  rows: ThreadRow[];
  waiting: WaitingCard | null;
  rowOf: ReadonlyMap<string, EntryId>;
};

export type ProgressLayer = ReadonlyMap<
  string,
  { botId: string; ts: string; blocks: MessageBlock[] }
>;

export type ThreadViewOptions = {
  rendersNothing?: (item: ThreadItem) => boolean;
  progress?: ProgressLayer;
};

const SHOWN_NOTES: ReadonlySet<string> = new Set(["skill.learnt", "system.note"]);

/** A run draws nothing: its reply is its bubbles, its tool activity their steps. */
export function drawsNothing(
  item: ThreadItem,
  drawsBlocks: (blocks: readonly MessageBlock[]) => boolean,
): boolean {
  switch (item.kind) {
    case "message":
      return !drawsBlocks(item.blocks);
    case "run":
      return true;
    case "effect":
      return !item.card;
    case "note":
      return !SHOWN_NOTES.has(item.type);
    default:
      return false;
  }
}

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
    const previewMessageId =
      projected.previewHosts.get(item.id) ?? inlinePreviewHost(item, messageId);
    rows.push({
      item,
      firstOfGroup: groups[index]?.isFirstOfGroup ?? true,
      lastOfGroup: groups[index]?.isLastOfGroup ?? true,
      reactions: reactions.get(item.id) ?? [],
      ...(role ? { routine: role } : {}),
      ...(shows ? { marker: { at, withTime: !routine } } : {}),
      ...(messageId ? { messageId } : {}),
      ...(previewMessageId ? { previewMessageId } : {}),
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

/** A card stored in the message's own blocks, not added by a `link.preview` entry. */
function inlinePreviewHost(item: ThreadItem, messageId: EntryId | undefined) {
  const inline =
    item.kind === "message" &&
    item.blocks.some((block) => block.kind === "link_preview" && isLinkPreviewCard(block));
  return inline ? messageId : undefined;
}

function onChain(entries: readonly SessionEntry[]): SessionEntry[] {
  let kept: SessionEntry[] = [];
  for (const entry of byId(entries)) {
    if (entry.type === "rewind") {
      // A parent the server held back (a hidden peer run's entry) is found through its held child,
      // the first entry of the cut turn. With no held child, the page is already the chain.
      const parentAt = kept.findIndex((candidate) => candidate.id === entry.parentId);
      const cutAt =
        parentAt === -1
          ? kept.findIndex((candidate) => candidate.parentId === entry.parentId)
          : parentAt + 1;
      if (cutAt !== -1) kept = kept.slice(0, cutAt);
    } else if (entry.type === "clear") {
      kept = [];
    }
    kept.push(entry);
  }
  return kept;
}

export function mergeEntries(
  held: readonly SessionEntry[],
  incoming: readonly SessionEntry[],
): SessionEntry[] {
  return byId([...held, ...incoming]);
}

export type ThreadEntries = {
  entries: SessionEntry[];
  olderCursor: EntryId | null;
  cursor?: number;
  layer: ProgressLayer;
};

export function threadEntriesOf<S extends { progress: readonly ProductEvent[] }>(
  snapshot: S,
): Omit<S, "progress"> & { layer: ProgressLayer } {
  const { progress, ...held } = snapshot;
  return { ...held, layer: progress.reduce<ProgressLayer>(reduceProgressLayer, new Map()) };
}

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

function joinsHeld(page: readonly SessionEntry[], held: readonly SessionEntry[]): boolean {
  const oldest = page[0];
  return !oldest || oldest.parentId === null || held.some((entry) => entry.id === oldest.parentId);
}

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

export function appendedEntries(event: ProductEvent): readonly SessionEntry[] {
  if (event.type !== "session.entry.appended") return [];
  let entries = appendedOf.get(event);
  if (!entries) {
    entries = SessionEntries.safeParse(event.payload.entries).data ?? [];
    appendedOf.set(event, entries);
  }
  return entries;
}

const BOT_WORDS_TYPES = [
  "assistant.text",
  "bot.text",
  "assistant.ask",
  "assistant.choice",
  "effect.requested",
] as const;
type BotWords = SessionEntryOf<(typeof BOT_WORDS_TYPES)[number]>;
const BOT_WORDS: ReadonlySet<string> = new Set(BOT_WORDS_TYPES);

/** What a bot said to the person in this event: a reply, a question, or a card to act on. */
export function botWordsOf(event: ProductEvent): BotWords[] {
  return appendedEntries(event).filter((entry): entry is BotWords => BOT_WORDS.has(entry.type));
}

export function blocksOfBotWords(entry: BotWords): readonly MessageBlock[] {
  return entry.type === "assistant.text" || entry.type === "bot.text" ? entry.payload.blocks : [];
}

export function textOfBotWords(entry: BotWords): string {
  switch (entry.type) {
    case "assistant.ask":
      return entry.payload.block.text;
    case "assistant.choice":
      return entry.payload.block.question;
    case "effect.requested":
      return entry.payload.card?.text ?? "";
    default:
      return blocksOfBotWords(entry)
        .map((block) => (block.kind === "text" ? block.text : ""))
        .filter(Boolean)
        .join("\n");
  }
}

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
