import type { AskDraft } from "@rakazo/contracts";
import type { SpawnBotEdits } from "./spawn-bot-edit";

/** What a card's owner changed before Send: a Create bot card's fields, or a mail draft's text. */
export type CardEdits = SpawnBotEdits | { text: string };

/** The draft the Edit message sheet edits, put here by the card on screen, and its thread. */
export type DraftEditTarget = { threadKey: string; messageId: string; draft: AskDraft };

// The text typed on each draft card, by card: it stays on this device until the card is sent or
// replaced, and a relaunch drops it. The sheet's content never travels in route params, so a deep
// link has nothing to show.
const edits = new Map<string, string>();
let sheet: DraftEditTarget | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeDraftEdit(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The card's text as the person left it, or undefined when they have not touched it. */
export function draftEdit(messageId: string): string | undefined {
  return edits.get(messageId);
}

export function keepDraftEdit(messageId: string, text: string): void {
  edits.set(messageId, text);
  emit();
}

export function dropDraftEdit(messageId: string): void {
  if (edits.delete(messageId)) emit();
}

/** Presents the Edit message sheet (`app/edit-draft.tsx`) for a waiting draft card. */
export function openDraftEdit(
  router: { push: (href: "/edit-draft") => void },
  target: DraftEditTarget,
): void {
  sheet = target;
  emit();
  router.push("/edit-draft");
}

export function draftEditTarget(): DraftEditTarget | null {
  return sheet;
}

/** Drops the sheet of `messageId`: it was dismissed, or its card was answered. */
export function closeDraftEdit(messageId: string): void {
  if (sheet?.messageId !== messageId) return;
  sheet = null;
  emit();
}

/**
 * Keeps the sheet open only while its card is still the one its thread waits on. A thread that
 * stays mounted under another one keeps syncing, so only the sheet's own thread may close it.
 */
export function syncDraftEdit(
  threadKey: string,
  answerableItemId: string | null | undefined,
): void {
  if (sheet?.threadKey === threadKey && sheet.messageId !== answerableItemId) {
    closeDraftEdit(sheet.messageId);
  }
}
