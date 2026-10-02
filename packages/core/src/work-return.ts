import type { WorkReturnOutcome as KnownOutcome, MessageBlock } from "@rakazo/contracts";
import { isWorkReturnOutcome } from "@rakazo/contracts";

export type WorkReturnOutcome = KnownOutcome | "unknown";

/**
 * Where a task stands, as its line in the task tree and its return card say it: one vocabulary
 * for both, so a surface keeps a single table of marks and labels.
 */
export type TaskLineState =
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "cancelled"
  | "no_result"
  | "closed";

const OUTCOME_STATE: Record<KnownOutcome, TaskLineState> = {
  result: "done",
  failed: "failed",
  cancelled: "cancelled",
  no_result: "no_result",
};

/** How a return reads as a state; a legacy return with no recorded outcome reads as none. */
export function workReturnState(outcome: KnownOutcome): TaskLineState;
export function workReturnState(outcome: WorkReturnOutcome): TaskLineState | null;
export function workReturnState(outcome: WorkReturnOutcome): TaskLineState | null {
  return outcome === "unknown" ? null : OUTCOME_STATE[outcome];
}

/** The semantic color a state is drawn in, on every surface; running and waiting stay ink. */
export type TaskStateTone = "success" | "destructive" | "muted";

export function taskStateTone(state: TaskLineState): TaskStateTone | null {
  switch (state) {
    case "done":
      return "success";
    case "failed":
      return "destructive";
    case "cancelled":
    case "no_result":
    case "closed":
      return "muted";
    case "running":
    case "waiting":
      return null;
  }
}

export type WorkReturn = {
  workId: string | null;
  executorBotId: string | null;
  /** The specialist's name when the card recorded it; a bot list may no longer know it. */
  executorBotName?: string;
  outcome: WorkReturnOutcome;
};

/**
 * Reads the specialist's `work_return` card posted to its coordinator thread.
 * Legacy cards recorded before outcomes were stamped read as "unknown",
 * never as a success.
 */
export function parseWorkReturn(block: MessageBlock): WorkReturn | null {
  if (block.kind !== "card") return null;
  const value = (key: string) => block.lines.find((line) => line.k === key)?.v ?? null;
  if (value("purpose") !== "work_return") return null;
  const outcome = value("outcome");
  const executorBotName = value("executorBotName");
  return {
    workId: value("workId"),
    executorBotId: value("executorBotId"),
    ...(executorBotName ? { executorBotName } : {}),
    outcome: isWorkReturnOutcome(outcome) ? outcome : "unknown",
  };
}
