import type { FieldSaveState } from "@tangow/core";

const announced = new WeakSet<object>();

/**
 * Whether a screen reader should hear this save's outcome now. The store hands
 * every view of one field the same state object until it changes, so two metas
 * showing one save (the hero and the appearance sheet) speak it once.
 */
export function claimSaveAnnouncement(state: FieldSaveState<unknown>): boolean {
  if (state.kind !== "saved" && state.kind !== "failed") return false;
  if (announced.has(state)) return false;
  announced.add(state);
  return true;
}
