import type { MessageBlock } from "@rakazo/contracts";

export type WorkReturnOutcome = "result" | "failed" | "unknown";

export type WorkReturn = {
  workId: string | null;
  executorBotId: string | null;
  outcome: WorkReturnOutcome;
};

/**
 * Reads the specialist's `work_return` card posted to its coordinator thread.
 * Legacy cards recorded before outcomes were stamped render as "unknown",
 * never as a success.
 */
export function parseWorkReturn(block: MessageBlock): WorkReturn | null {
  if (block.kind !== "card") return null;
  const value = (key: string) => block.lines.find((line) => line.k === key)?.v ?? null;
  if (value("purpose") !== "work_return") return null;
  const outcome = value("outcome");
  return {
    workId: value("workId"),
    executorBotId: value("executorBotId"),
    outcome: outcome === "result" || outcome === "failed" ? outcome : "unknown",
  };
}
