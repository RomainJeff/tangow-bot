/**
 * The text typed on each mail draft card, by card: it stays on this device until the card is sent
 * or replaced, outlives the card scrolling away, and a reload drops it.
 */
export const draftEdits = new Map<string, string>();
