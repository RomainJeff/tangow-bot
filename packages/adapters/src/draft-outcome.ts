import type { EntryId, SessionEntry } from "@tangow/contracts";
import { pendingPauseOfEffect, readDraft } from "@tangow/core";
import { resolveDuplicateEffectGate } from "./approval-effect.js";

export type EndedDraftEffect = {
  id: string;
  kind: string;
  status: string;
  request: unknown;
  result: unknown;
  draft: unknown;
};

/**
 * The draft states a card ends in for good: a Not sent draft is shown again, still pending. An
 * unsent one is a send the run ended on, which may have left.
 */
const ENDED_STATES = new Set(["sent", "discarded", "replaced", "unsent"]);

/**
 * What the model reads as the result of each call a draft card paused, once the card ended: as the
 * same call reads it when the model issues it again. The result names the pause it replaces. A
 * call whose pause was already replaced by an outcome is not listed, so the log gets each outcome
 * once.
 */
export function endedDraftOutcomes(
  effects: readonly EndedDraftEffect[],
  entries: readonly SessionEntry[],
): Array<{ callId: string; pauseId: EntryId; result: unknown }> {
  return effects.flatMap((effect) => {
    const draft = readDraft(effect.status, effect.draft);
    if (!draft || !ENDED_STATES.has(draft.state)) return [];
    const pause = pendingPauseOfEffect(entries, effect.id);
    const gate = resolveDuplicateEffectGate(effect, effect.kind);
    return pause && gate.action === "return" ? [{ ...pause, result: gate.result }] : [];
  });
}
