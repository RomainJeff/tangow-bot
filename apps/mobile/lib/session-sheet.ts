import type { ThreadItem } from "@rakazo/contracts";

/** A routine run's entries carry its own `routine.started`, which would draw the run inside itself. */
export function isViewedRunLine(item: ThreadItem, viewedRunId: string | undefined): boolean {
  return item.kind === "routine" && item.runId === viewedRunId;
}
