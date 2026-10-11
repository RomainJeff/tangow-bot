import type { MessageBlock, ThreadItem } from "@rakazo/contracts";

type RoutineRunBlock = Extract<MessageBlock, { kind: "routine_run" }>;
type SentBlock = Extract<MessageBlock, { kind: "bot_message_sent" }>;

export interface RoutineGroupMessage {
  id: string;
  role: string;
  botId?: string;
  createdAt?: string;
  blocks: readonly MessageBlock[];
}

/** One routine run as a group shows it: the run, and the bot message it sent right after. */
export interface RoutineGroupRun {
  messageId: string;
  createdAt?: string;
  run: RoutineRunBlock;
  sentTo?: SentBlock;
  /** The routine's most recent run in the thread: the only one that opens on its own. */
  latest?: boolean;
}

/**
 * How a message renders once routine runs are folded:
 * - `run`: a routine run on its own line, with the message it sent;
 * - `group`: the line standing for several consecutive runs (the latest one);
 * - `hidden`: drawn by another line (a grouped run, or a run's handoff).
 */
export type RoutineRowRole =
  | { kind: "run"; run: RoutineGroupRun }
  | { kind: "group"; runs: RoutineGroupRun[] }
  | { kind: "hidden" };

function routineRun(message: RoutineGroupMessage): RoutineRunBlock | undefined {
  return message.blocks.find((block): block is RoutineRunBlock => block.kind === "routine_run");
}

function handoffOf(
  run: RoutineGroupMessage,
  next: RoutineGroupMessage | undefined,
): SentBlock | undefined {
  if (!next || next.botId !== run.botId) return undefined;
  if (next.blocks.length === 0 || next.blocks.some((block) => block.kind !== "bot_message_sent")) {
    return undefined;
  }
  return next.blocks[0] as SentBlock;
}

/** A run that needs a look (failed, still going) always keeps its own line, and — like a
 * message from outside the routine — cuts whatever sequence of quiet runs came before it. */
function staysVisible(run: RoutineRunBlock): boolean {
  return run.state !== "completed" && run.state !== "cancelled";
}

/** One routine of one bot: runs only fold with runs of the same routine. */
function routineKey(message: RoutineGroupMessage, run: RoutineRunBlock): string {
  return `${message.botId ?? ""}:${run.routineId ?? run.routineName}`;
}

/**
 * Folds routine runs (messages in chronological order). Each run keeps the
 * message it then sent to another bot. Consecutive *quiet* runs (completed or
 * cancelled) of the same routine, with nothing else between them, fold into
 * one line, except the newest of the run, which keeps its own line so the
 * latest result is one tap away. Anything else — a person's message, a bot's
 * reply, another routine's run, or a failed/running run of the *same*
 * routine — ends the sequence just like a message would: it is never folded
 * itself, and nothing on either side of it is folded across it, so the thread
 * is never reordered (spec A2b). Only messages that change role are listed.
 */
export function foldRoutineRuns(
  messages: readonly RoutineGroupMessage[],
): ReadonlyMap<string, RoutineRowRole> {
  const roles = new Map<string, RoutineRowRole>();
  const lastRunOf = new Map<string, string>();
  for (const message of messages) {
    const run = routineRun(message);
    if (run) lastRunOf.set(routineKey(message, run), message.id);
  }

  // Only ever holds quiet (completed/cancelled) runs of the current routine:
  // a failed or running run is handled on the spot, never queued here.
  let sequence: RoutineGroupRun[] = [];

  function close() {
    if (sequence.length === 0) return;
    // The newest quiet run stays out of the fold, on its own line.
    const newest = sequence.at(-1)!;
    const folded = sequence.slice(0, -1);
    if (folded.length < 2) {
      for (const item of sequence) roles.set(item.messageId, { kind: "run", run: item });
    } else {
      for (const item of folded.slice(0, -1)) roles.set(item.messageId, { kind: "hidden" });
      roles.set(folded.at(-1)!.messageId, { kind: "group", runs: folded });
      roles.set(newest.messageId, { kind: "run", run: newest });
    }
    sequence = [];
  }

  let currentKey: string | undefined;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const run = routineRun(message);
    if (!run) {
      close();
      currentKey = undefined;
      continue;
    }
    const key = routineKey(message, run);
    if (currentKey !== undefined && key !== currentKey) close();
    currentKey = key;
    const next = messages[index + 1];
    const sentTo = handoffOf(message, next);
    const item: RoutineGroupRun = {
      messageId: message.id,
      createdAt: message.createdAt,
      run,
      sentTo,
      latest: lastRunOf.get(key) === message.id,
    };
    if (staysVisible(run)) {
      // A failed or running run cuts the sequence like a message would: close
      // whatever quiet run came before it, show it on its own line, then let
      // the next run of this routine start a fresh sequence of its own.
      close();
      roles.set(item.messageId, { kind: "run", run: item });
      currentKey = undefined;
    } else {
      sequence.push(item);
    }
    if (sentTo && next) {
      roles.set(next.id, { kind: "hidden" });
      index += 1;
    }
  }
  close();
  return roles;
}

type RoutineItem = Extract<ThreadItem, { kind: "routine" }>;
type SentItem = Extract<ThreadItem, { kind: "botMessage"; direction: "sent" }>;

/** One routine run as its line shows it: the run, the bot message it sent right after, if any. */
export type RoutineLineRun = { item: RoutineItem; sentTo?: SentItem; latest: boolean };

/** How a routine item renders once quiet runs of one routine fold: alone, or as the fold's line. */
export type RoutineLineRole =
  | { kind: "run"; run: RoutineLineRun }
  | { kind: "group"; runs: RoutineLineRun[] };

/**
 * `foldRoutineRuns` over a thread's items: the role of each routine item, and `hidden` for a
 * folded run and for the bot message a run sent right after, from its own routine session.
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
