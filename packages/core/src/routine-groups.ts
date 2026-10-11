import type { ThreadItem } from "@rakazo/contracts";

type RoutineItem = Extract<ThreadItem, { kind: "routine" }>;
type SentItem = Extract<ThreadItem, { kind: "botMessage"; direction: "sent" }>;

/** One routine run as its line shows it: the run, the bot message it sent right after, if any. */
export type RoutineLineRun = { item: RoutineItem; sentTo?: SentItem; latest: boolean };

/** How a routine item renders once quiet runs of one routine fold: alone, or as the fold's line. */
export type RoutineLineRole =
  | { kind: "run"; run: RoutineLineRun }
  | { kind: "group"; runs: RoutineLineRun[] };

/**
 * Folds routine runs over a thread's items: the role of each routine item, and `hidden` for a
 * folded run and for the bot message a run sent right after, from its own routine session.
 * Consecutive quiet runs (completed or cancelled) of one routine fold into one line, except the
 * newest, which keeps its own line. Anything else, including a failed or running run of the same
 * routine, ends the sequence and is never folded across, so the thread is never reordered.
 */
export function foldRoutineItems(
  items: readonly ThreadItem[],
): ReadonlyMap<string, RoutineLineRole | { kind: "hidden" }> {
  const roles = new Map<string, RoutineLineRole | { kind: "hidden" }>();
  const keyOf = (item: RoutineItem) => JSON.stringify([item.botId, item.routineId]);
  const lastRunOf = new Map<string, string>();
  for (const item of items) if (item.kind === "routine") lastRunOf.set(keyOf(item), item.id);

  let sequence: RoutineLineRun[] = [];
  function close() {
    if (sequence.length === 0) return;
    const newest = sequence.at(-1)!;
    const folded = sequence.slice(0, -1);
    if (folded.length < 2) {
      for (const run of sequence) roles.set(run.item.id, { kind: "run", run });
    } else {
      for (const run of folded.slice(0, -1)) roles.set(run.item.id, { kind: "hidden" });
      roles.set(folded.at(-1)!.item.id, { kind: "group", runs: folded });
      roles.set(newest.item.id, { kind: "run", run: newest });
    }
    sequence = [];
  }

  let currentKey: string | undefined;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind !== "routine") {
      close();
      currentKey = undefined;
      continue;
    }
    const key = keyOf(item);
    if (currentKey !== undefined && key !== currentKey) close();
    currentKey = key;
    const next = items[index + 1];
    const sentTo =
      next?.kind === "botMessage" &&
      next.direction === "sent" &&
      next.botId === item.botId &&
      next.origin?.sessionId === item.sessionId
        ? next
        : undefined;
    const run: RoutineLineRun = {
      item,
      ...(sentTo ? { sentTo } : {}),
      latest: lastRunOf.get(key) === item.id,
    };
    const status = item.finished?.status;
    if (status === "completed" || status === "cancelled") {
      sequence.push(run);
    } else {
      close();
      roles.set(item.id, { kind: "run", run });
      currentKey = undefined;
    }
    if (sentTo) {
      roles.set(sentTo.id, { kind: "hidden" });
      index += 1;
    }
  }
  close();
  return roles;
}
