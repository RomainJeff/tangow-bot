import type {
  EntryId,
  MessageBlock,
  ProductEvent,
  SessionEntryType,
  ThreadEntry,
  ThreadEntryOf,
  ThreadItem,
} from "@rakazo/contracts";
import { CARD_STATE_TYPES, isLinkPreviewCard, ThreadEntrySchema } from "@rakazo/contracts";
import { isRunTerminalEvent, progressMessageId, reduceLiveMessageBlocks } from "../events.js";
import { computeItemGroups } from "../message-grouping.js";
import type { ItemReactions } from "../message-reactions.js";
import { foldItemReactions } from "../message-reactions.js";
import type { RoutineRole } from "../routine-roles.js";
import { routineRoles } from "../routine-roles.js";
import { isSameLocalDay, showsTimeMarker } from "../thread-time-markers.js";
import type { WaitingCard } from "./project-ui.js";
import { projectThread } from "./project-ui.js";

export type ThreadRow = {
  item: ThreadItem;
  firstOfGroup: boolean;
  lastOfGroup: boolean;
  reactions: ItemReactions;
  routine?: RoutineRole;
  chained?: true;
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

/**
 * The report a routine run ended on, when the run's own view has no closing message to show it: a
 * routine card run keeps its final words only on its line, which its own view leaves out. A chart
 * or a file it posted on the way is not a closing message.
 */
export function unshownRunReport(
  entries: readonly ThreadEntry[],
  runId: string,
): string | undefined {
  let report: string | undefined;
  for (const entry of entries) {
    if (entry.runId !== runId) continue;
    if (
      entry.type === "assistant.text" &&
      !entry.payload.midTurn &&
      entry.payload.blocks.some((block) => block.kind === "text" && block.text.trim())
    )
      return undefined;
    if (entry.type === "routine.finished") report = entry.payload.result.trim() || undefined;
  }
  return report;
}

export function projectThreadView(
  entries: readonly ThreadEntry[],
  options: ThreadViewOptions = {},
): ThreadView {
  const projected = projectThread(onChain(entries));
  const drawn = applyProgressLayer(projected.items, options.progress ?? new Map()).filter(
    (item) => !options.rendersNothing?.(item),
  );
  const folded = foldItemReactions(drawn, projected.shownBy);
  const { roles, hidden } = routineRoles(folded.items);
  const items =
    hidden.size === 0 ? folded.items : folded.items.filter((item) => !hidden.has(item.id));
  const groups = computeItemGroups(items);
  const hostOf = new Map<string, EntryId>(folded.parentOf);
  const rows: ThreadRow[] = [];
  let previous: { ts: string; line: boolean } | undefined;
  for (const [index, item] of items.entries()) {
    const routine = roles.get(item.id);
    const line = routine?.kind === "failures";
    if (line) for (const id of routine.folded) hostOf.set(id, item.id);
    const lineAbove = line && previous?.line ? previous : undefined;
    const shows = lineAbove
      ? !isSameLocalDay(lineAbove.ts, item.ts)
      : showsTimeMarker(previous?.ts, item.ts);
    const messageId = projected.messageIds.get(item.id);
    const previewMessageId =
      projected.previewHosts.get(item.id) ?? inlinePreviewHost(item, messageId);
    rows.push({
      item,
      firstOfGroup: groups[index]?.isFirstOfGroup ?? true,
      lastOfGroup: groups[index]?.isLastOfGroup ?? true,
      reactions: folded.reactions.get(item.id) ?? [],
      ...(routine ? { routine } : {}),
      ...(shows
        ? { marker: { at: item.ts, withTime: !line } }
        : lineAbove
          ? { chained: true }
          : {}),
      ...(messageId ? { messageId } : {}),
      ...(previewMessageId ? { previewMessageId } : {}),
    });
    previous = { ts: item.ts, line };
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

function onChain(entries: readonly ThreadEntry[]): ThreadEntry[] {
  let kept: ThreadEntry[] = [];
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
  held: readonly ThreadEntry[],
  incoming: readonly ThreadEntry[],
): ThreadEntry[] {
  return byId([...held, ...incoming]);
}

export type ThreadEntries = {
  entries: ThreadEntry[];
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

function joinsHeld(page: readonly ThreadEntry[], held: readonly ThreadEntry[]): boolean {
  const oldest = page[0];
  return !oldest || oldest.parentId === null || held.some((entry) => entry.id === oldest.parentId);
}

export function withOlderEntries<S extends ThreadEntries>(
  prev: S,
  page: { entries: readonly ThreadEntry[]; olderCursor: EntryId | null },
): S {
  if (prev.olderCursor === null) return prev;
  return {
    ...prev,
    entries: mergeEntries(prev.entries, page.entries),
    olderCursor: page.olderCursor,
  };
}

function byId(entries: readonly ThreadEntry[]): ThreadEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()].sort(
    (a, b) => a.seq - b.seq,
  );
}

const appendedOf = new WeakMap<ProductEvent, readonly ThreadEntry[]>();

export function appendedEntries(event: ProductEvent): readonly ThreadEntry[] {
  if (event.type !== "session.entry.appended") return [];
  let entries = appendedOf.get(event);
  if (!entries) {
    entries = ThreadEntrySchema.array().safeParse(event.payload.entries).data ?? [];
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
type BotWords = ThreadEntryOf<(typeof BOT_WORDS_TYPES)[number]>;
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
  entries: readonly ThreadEntry[],
  options: { hiddenPeerRunIds: ReadonlySet<string> },
): ThreadEntry[] {
  return entries.filter(
    (entry) =>
      !entry.runId ||
      !options.hiddenPeerRunIds.has(entry.runId) ||
      PEER_RUN_KEPT_TYPES.has(entry.type) ||
      (entry.type === "assistant.text" && entry.payload.toPerson === true),
  );
}
