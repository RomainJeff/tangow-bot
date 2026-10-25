/** Where a tool effect stands for a resumed run: whether it may run, ran, or might have. */
export type EffectPhase = "not_started" | "started" | "completed" | "uncertain" | "denied";

/** `external_effects.status` to its phase. A started effect becomes uncertain on the next claim. */
const PHASE_OF_STATUS: Readonly<Record<string, EffectPhase>> = {
  intended: "not_started",
  approved: "not_started",
  executing: "started",
  completed: "completed",
  uncertain: "uncertain",
  denied: "denied",
};

/** An unknown status reads as uncertain: a resumed run never replays what it cannot place. */
export function effectPhase(status: string): EffectPhase {
  return PHASE_OF_STATUS[status] ?? "uncertain";
}
