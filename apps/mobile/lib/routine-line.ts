import type { RoutineLineRun } from "@rakazo/core";

export type RoutineLineState = "queued" | "running" | "completed" | "failed" | "cancelled";

/** A routine run's line: a subscribed or failed latest run opens on its report. */
export function routineLine(run: RoutineLineRun, queued: boolean) {
  const { finished, notify } = run.item;
  const state: RoutineLineState = finished?.status ?? (queued ? "queued" : "running");
  const report = finished?.result.trim() || undefined;
  const subscribed = notify === true;
  return {
    state,
    report,
    subscribed,
    opensOnItsOwn: Boolean(report && run.latest && (subscribed || state === "failed")),
  };
}
