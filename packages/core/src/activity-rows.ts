import type {
  BotActivityItem,
  BotActivityOutput,
  MessageBlock,
  RunActivityRow,
  RunRecap,
  RunsCursor,
} from "@rakazo/contracts";
import { parseKnownMessageBlocks } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "./run-state.js";

type CreationItem = Exclude<BotActivityItem, { kind: "routine_run" }>;
type RoutineRunBlock = Extract<MessageBlock, { kind: "routine_run" }>;

/** An entry as the list draws it, once consecutive successes of one routine fold together. */
export type ActivityItem =
  | { kind: "run"; row: RunActivityRow }
  | { kind: "folded"; routineId: string; name: string | null; runs: RunActivityRow[] }
  | CreationItem;

/** `at` is the time the day was read from, for its label. */
export type ActivityDay = { day: string | null; at: string; items: ActivityItem[] };

const ACTIVE: ReadonlySet<string> = new Set(ACTIVE_RUN_STATUSES);

function isActiveRun(entry: BotActivityItem): boolean {
  return entry.kind === "routine_run" && ACTIVE.has(entry.run.status);
}

/** One key per entry, whatever its kind, so a page read twice never lists it twice. */
function activityKey(entry: BotActivityItem): string {
  switch (entry.kind) {
    case "routine_run":
      return `run:${entry.run.runId}`;
    case "routine_created":
      return `routine:${entry.routineId}`;
    case "bot_created":
      return `bot:${entry.botId}`;
  }
}

/**
 * Active runs first, then everything else in the order given (newest first, as the server pages
 * it). Two or more finished-with-success runs of one routine in a row fold into one item; a
 * failed, cancelled or active run, or a creation, is never folded and ends the sequence.
 */
export function foldActivity(entries: readonly BotActivityItem[]): ActivityItem[] {
  const ordered = [...entries.filter(isActiveRun), ...entries.filter((e) => !isActiveRun(e))];
  const items: ActivityItem[] = [];
  let sequence: RunActivityRow[] = [];
  const flush = () => {
    const [first] = sequence;
    if (first?.routineId && sequence.length >= 2) {
      items.push({
        kind: "folded",
        routineId: first.routineId,
        name: first.routineName,
        runs: sequence,
      });
    } else {
      for (const row of sequence) items.push({ kind: "run", row });
    }
    sequence = [];
  };
  for (const entry of ordered) {
    if (entry.kind !== "routine_run") {
      flush();
      items.push(entry);
      continue;
    }
    const row = entry.run;
    const foldable = row.status === "completed" && row.routineId !== null;
    if (!foldable || sequence[0]?.routineId !== row.routineId) flush();
    if (foldable) sequence.push(row);
    else items.push({ kind: "run", row });
  }
  flush();
  return items;
}

function runStart(row: RunActivityRow): string {
  return row.startedAt ?? row.completedAt ?? row.updatedAt;
}

function itemTime(item: ActivityItem): string {
  switch (item.kind) {
    case "run":
      return runStart(item.row);
    case "folded":
      return item.runs[0] ? runStart(item.runs[0]) : "";
    case "routine_created":
    case "bot_created":
      return item.createdAt;
  }
}

/**
 * Groups items under the calendar day, in `timeZone`, they started on, which follows the list's
 * order. Active runs lead under a `null` day because they have not finished. A folded item sits
 * under the day of its newest run.
 */
export function dayMarkers(items: readonly ActivityItem[], timeZone: string): ActivityDay[] {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const days: ActivityDay[] = [];
  const seen = new Set<string | null>();
  for (const item of items) {
    const at = itemTime(item);
    const active = item.kind === "run" && ACTIVE.has(item.row.status);
    const day = active ? null : format.format(new Date(at));
    const last = days.at(-1);
    // Start times only approximate the creation order the list pages by: never repeat a day label.
    if (last && (last.day === day || seen.has(day))) last.items.push(item);
    else {
      seen.add(day);
      days.push({ day, at, items: [item] });
    }
  }
  return days;
}

export type ActivityRead =
  | { kind: "loading" }
  | { kind: "failed" }
  | {
      kind: "ready";
      entries: BotActivityItem[];
      next: RunsCursor | null;
      /** Pages read so far; a refresh keeps the earlier ones once the person asked for them. */
      pages: number;
      earlier: "idle" | "loading" | "failed";
    };

export type ActivityEvent =
  | { type: "first"; page: BotActivityOutput }
  | { type: "first-failed" }
  | { type: "earlier-started" }
  | { type: "earlier"; page: BotActivityOutput }
  | { type: "earlier-failed" }
  | { type: "retry" };

/** `held` then `fresh`, each entry once: the server's latest copy of an entry wins. */
function mergeEntries(held: BotActivityItem[], fresh: BotActivityItem[]): BotActivityItem[] {
  const latest = new Set(fresh.map(activityKey));
  return [...held.filter((entry) => !latest.has(activityKey(entry))), ...fresh];
}

/** A bot's activity, read a page at a time: the first page again on every refresh, earlier ones on demand. */
export function reduceActivity(read: ActivityRead, event: ActivityEvent): ActivityRead {
  switch (event.type) {
    case "first": {
      const fresh = new Set(event.page.items.map(activityKey));
      // Every active run comes back on the first page: one missing from it has ended, and its
      // finished copy belongs somewhere in the pages already held, so they are dropped.
      const ended =
        read.kind === "ready" &&
        read.entries.some((entry) => isActiveRun(entry) && !fresh.has(activityKey(entry)));
      return read.kind === "ready" && read.pages > 1 && !ended
        ? {
            ...read,
            entries: [
              ...event.page.items,
              ...read.entries.filter((entry) => !fresh.has(activityKey(entry))),
            ],
            earlier: "idle",
          }
        : {
            kind: "ready",
            entries: event.page.items,
            next: event.page.nextCursor,
            pages: 1,
            earlier: "idle",
          };
    }
    case "first-failed":
      return read.kind === "ready" ? read : { kind: "failed" };
    case "earlier-started":
      return read.kind === "ready" && read.next && read.earlier !== "loading"
        ? { ...read, earlier: "loading" }
        : read;
    case "earlier":
      return read.kind === "ready"
        ? {
            kind: "ready",
            entries: mergeEntries(read.entries, event.page.items),
            next: event.page.nextCursor,
            pages: read.pages + 1,
            earlier: "idle",
          }
        : read;
    case "earlier-failed":
      return read.kind === "ready" ? { ...read, earlier: "failed" } : read;
    case "retry":
      return { kind: "loading" };
  }
}

/** What one message of a run says in its thread: a routine card's report, or its text. */
function messageReport(blocks: readonly MessageBlock[]): string {
  const card = blocks.find((block): block is RoutineRunBlock => block.kind === "routine_run");
  if (card) {
    // A failed card's digest is the raw error, which Activity never shows: the line says why.
    return card.state === "failed" ? "" : card.digest?.trim() || card.headline?.trim() || "";
  }
  return blocks
    .flatMap((block) => (block.kind === "text" ? [block.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A run's recap from the stored bot messages it left in its thread, oldest first: their text joined, and
 * the message to open it at (the first that says something, else the first one).
 */
export function runRecap(messages: readonly { id: string; blocks: unknown }[]): RunRecap {
  const said = messages
    .map((message) => ({
      id: message.id,
      // Stored blocks may come from a newer or older build: an unknown one is skipped, not fatal.
      text: messageReport(parseKnownMessageBlocks(message.blocks).map(({ block }) => block)),
    }))
    .filter((message) => message.text);
  return {
    text: said.length > 0 ? said.map((message) => message.text).join("\n\n") : null,
    messageId: said[0]?.id ?? messages[0]?.id ?? null,
  };
}

/** A run's recap as read on demand, the first time its line opens. */
export type RecapRead =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; recap: RunRecap };

export type RecapBody =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "text"; text: string }
  | { kind: "no_report" }
  | { kind: "none" };

/**
 * What an open run line shows under it, and where "Open in chat" lands. A failed run's reason is
 * already on its line, so a failed run without text shows nothing more. The way into the chat
 * never waits on the read: until the recap names its message, it is where the run began.
 */
export function recapView(
  read: RecapRead | null,
  run: { failed: boolean; sourceMessageId: string | null },
): { body: RecapBody; jumpTo: string | null } {
  if (!read || read.kind === "loading") {
    return { body: { kind: "loading" }, jumpTo: run.sourceMessageId };
  }
  if (read.kind === "failed") return { body: { kind: "failed" }, jumpTo: run.sourceMessageId };
  const { text, messageId } = read.recap;
  return {
    body: text ? { kind: "text", text } : run.failed ? { kind: "none" } : { kind: "no_report" },
    jumpTo: messageId ?? run.sourceMessageId,
  };
}
