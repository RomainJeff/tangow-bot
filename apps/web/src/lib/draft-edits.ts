import type { AskDraftEdits } from "@rakazo/contracts";

/**
 * What the person changed on each mail draft card, by card: it stays on this device until the card
 * is sent or replaced, outlives the card scrolling away, and a reload drops it.
 */
export const draftEdits = new Map<string, AskDraftEdits>();
