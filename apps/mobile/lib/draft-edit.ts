import type { AskDraft } from "@rakazo/contracts";
import type { ThreadView } from "@rakazo/core";
import type { SpawnBotEdits } from "./spawn-bot-edit";

/** What a card's owner changed before Send: a Create bot card's fields, or a mail draft's text. */
export type CardEdits = SpawnBotEdits | { text: string };

/** The draft the Edit message sheet edits, put here by the card on screen. */
export type DraftEditTarget = { messageId: string; draft: AskDraft };

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

/** Keeps the sheet open only while its card is still the one the person can answer. */
export function syncDraftEdit(answerableItemId: string | null | undefined): void {
  if (sheet && sheet.messageId !== answerableItemId) closeDraftEdit(sheet.messageId);
}

/**
 * The waiting mail draft a message sent now replaces, when the person edited it: the bot reads
 * the text as they left it.
 */
export function replacedDraft(
  view: Pick<ThreadView, "rows" | "waiting">,
): { itemId: string; draft: { messageId: string; text: string } } | undefined {
  const waiting = view.waiting;
  if (!waiting) return undefined;
  const item = view.rows.find((row) => row.item.id === waiting.itemId)?.item;
  const block =
    item?.kind === "effect"
      ? item.card
      : item?.kind === "message"
        ? item.blocks.find((each) => each.kind === "ask" && each.status !== "answered")
        : undefined;
  const text = edits.get(waiting.itemId);
  if (block?.kind !== "ask" || !block.draft || text === undefined || text === block.draft.body) {
    return undefined;
  }
  return { itemId: waiting.itemId, draft: { messageId: waiting.entryId, text } };
}
