import type { SessionEntry } from "@rakazo/contracts";
import { pausedCallOfEffect, readDraft } from "@rakazo/core";
import { resolveDuplicateEffectGate } from "./approval-effect.js";

export type EndedDraftEffect = {
  id: string;
  kind: string;
  status: string;
  request: unknown;
  result: unknown;
  draft: unknown;
};

/** The draft states a card ends in for good: a Not sent draft is shown again, still pending. */
const ENDED_STATES = new Set(["sent", "discarded", "replaced"]);

/**
 * What the model reads as the result of each call a draft card paused, once the card ended: sent,
 * discarded or replaced, as the same call reads it when the model issues it again. A call whose
 * pause was already replaced by the outcome is not listed, so the log gets each outcome once.
 */
export function endedDraftOutcomes(
  effects: readonly EndedDraftEffect[],
  entries: readonly SessionEntry[],
): Array<{ callId: string; result: unknown }> {
  return effects.flatMap((effect) => {
    const draft = readDraft(effect.status, effect.draft);
    if (!draft || !ENDED_STATES.has(draft.state)) return [];
    const callId = pausedCallOfEffect(entries, effect.id);
    const gate = resolveDuplicateEffectGate(effect, effect.kind);
    return callId !== undefined && gate.action === "return"
      ? [{ callId, result: gate.result }]
      : [];
  });
}
