import type { Routine } from "@rakazo/contracts";

/**
 * A routine that is on and whose latest finished run failed. It is a state, not a "seen" marker:
 * it holds until a run of the routine ends another way, or the routine is paused or deleted.
 */
export function routineFailing(routine: Pick<Routine, "active" | "lastRunStatus">): boolean {
  return routine.active && routine.lastRunStatus === "failed";
}
