import type { MessageBlock } from "@rakazo/contracts";
import type { spawnBotEdits } from "@rakazo/core";

type SpawnBotFields = NonNullable<Extract<MessageBlock, { kind: "ask" }>["spawnBot"]>;
export type SpawnBotEdits = NonNullable<ReturnType<typeof spawnBotEdits>>;

/** What the edit sheet shows, and how it answers the card it was opened from. */
export type SpawnBotEditTarget = {
  messageId: string;
  spawnBot: SpawnBotFields;
  /** Answers "allow" on the card, with `edits` when the user changed a field. */
  submit: (edits: SpawnBotEdits | undefined) => Promise<void>;
};

// The sheet's content never travels in route params: a route with params can be opened by a
// deep link with forged content. Only the card that is on screen can put a target here.
let current: SpawnBotEditTarget | null = null;
const listeners = new Set<() => void>();

function set(next: SpawnBotEditTarget | null): void {
  if (current === next) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

/** Presents the edit sheet (`app/edit-bot-proposal.tsx`) for a pending spawn_bot card. */
export function openSpawnBotEdit(
  router: { push: (href: "/edit-bot-proposal") => void },
  target: SpawnBotEditTarget,
): void {
  set(target);
  router.push("/edit-bot-proposal");
}

export function spawnBotEditTarget(): SpawnBotEditTarget | null {
  return current;
}

export function subscribeSpawnBotEdit(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drops the target of `messageId` (sheet dismissed, or the card was answered). */
export function closeSpawnBotEdit(messageId: string): void {
  if (current?.messageId === messageId) set(null);
}

/**
 * Keeps the target only while its card is still the one the user can answer. Called on every
 * thread snapshot, so a card answered elsewhere, a run that moved on, or an answer that
 * conflicted closes the sheet.
 */
export function syncSpawnBotEdit(answerableMessageId: string | null | undefined): void {
  if (current && current.messageId !== answerableMessageId) set(null);
}
