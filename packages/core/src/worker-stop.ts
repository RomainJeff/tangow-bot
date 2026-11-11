import type { WorkerState } from "@tangow/contracts";

/**
 * What the controller recorded while stopping an attempt's guest, in the order it can happen.
 * `process_ended` comes from the launcher only, never from the guest; `unconfirmed` means the VM
 * was not confirmed gone within the stop budget.
 */
export const STOP_PHASES = ["requested", "process_ended", "unconfirmed"] as const;
export type StopPhase = (typeof STOP_PHASES)[number];

export type StopState = "none" | StopPhase | "destroyed";

/** The full stop view. The VM is destroyed exactly when the worker lifecycle released it. */
export function stopState(attempt: {
  stopPhase: StopPhase | null;
  workerState: WorkerState | null;
}): StopState {
  if (attempt.workerState === "released") return "destroyed";
  return attempt.stopPhase ?? "none";
}
