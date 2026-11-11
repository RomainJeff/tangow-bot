import type { AskDraftEdits, MessageBlock } from "@tangow/contracts";
import { draftChanges } from "./draft-card-view.js";
import { draftFieldsError } from "./draft-fields.js";
import type { ThreadView } from "./session-log/project-thread-view.js";
import type { WaitingCard } from "./session-log/project-ui.js";

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;
type WaitingView = Pick<ThreadView, "rows" | "waiting">;

/** The card the thread waits on: an effect's card, or a message's unanswered ask. */
export function waitingAskBlock(view: WaitingView): AskBlock | undefined {
  const waiting = view.waiting;
  if (!waiting) return undefined;
  const item = view.rows.find((row) => row.item.id === waiting.itemId)?.item;
  if (item?.kind === "effect") return item.card;
  if (item?.kind !== "message") return undefined;
  return item.blocks.find(
    (block): block is AskBlock => block.kind === "ask" && block.status !== "answered",
  );
}

/**
 * Where an answer to the card shown as `itemId` goes, or null when the thread does not wait on it.
 * A draft that did not leave is asked again under a new entry: the answer names the latest one.
 */
export function waitingAnswerTarget(
  waiting: WaitingCard | null | undefined,
  itemId: string,
): { runId: string; entryId: WaitingCard["entryId"] } | null {
  if (waiting?.itemId !== itemId) return null;
  return { runId: waiting.runId, entryId: waiting.entryId };
}

/**
 * The waiting mail draft a message sent now replaces, when the person edited it: the bot reads
 * it as they left it. `editOf` reads what is kept on the device for a card: its edits, or its
 * text alone.
 */
export function editedWaitingDraft(
  view: WaitingView,
  editOf: (itemId: string) => AskDraftEdits | string | undefined,
): { itemId: string; draft: AskDraftEdits & { messageId: string; text: string } } | undefined {
  const waiting = view.waiting;
  const draft = waitingAskBlock(view)?.draft;
  if (!waiting || !draft) return undefined;
  const edit = editOf(waiting.itemId);
  const changes = draftChanges(draft, typeof edit === "string" ? { text: edit } : edit);
  // The message replaces the draft however its lines were left: a line Send would refuse stays out.
  if (draftFieldsError(draft.fields, { recipients: changes.recipients })) delete changes.recipients;
  if (draftFieldsError(draft.fields, { subject: changes.subject })) delete changes.subject;
  if (!Object.keys(changes).length) return undefined;
  return {
    itemId: waiting.itemId,
    draft: { ...changes, messageId: waiting.entryId, text: changes.text ?? draft.body },
  };
}
