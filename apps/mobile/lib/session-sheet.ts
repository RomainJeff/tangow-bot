import type { ThreadItem } from "@rakazo/contracts";

export function isViewedRunLine(item: ThreadItem, viewedRunId: string | undefined): boolean {
  return item.kind === "routine" && item.runId === viewedRunId;
}
