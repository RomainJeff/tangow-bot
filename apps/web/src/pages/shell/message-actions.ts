import type { LinkPreviewCard } from "@tangow/contracts";
import { isLinkPreviewCard } from "@tangow/contracts";
import { messageHostsLinkPreview } from "@tangow/core";
import { copyableMessageText } from "../../lib/message-text";
import { rpc } from "../../lib/rpc";
import type { MessageItem } from "../../lib/thread-items";

/**
 * Shared by the hover pill (`message-hover-actions.tsx`) and the touch long-press
 * sheet (`message-actions-sheet.tsx`) so the two surfaces can never drift on
 * what a message allows.
 */

/** Speak/Stop shows only once the voice provider is ready and the message has
 * plain text to read (never for progress-only or attachment-only messages). */
export function canSpeakMessage(message: MessageItem, voiceReady: boolean): boolean {
  return voiceReady && message.blocks.some((block) => block.kind === "text");
}

/** Edit and resend is a person's own message only. */
export function canEditAndResendMessage(message: MessageItem): boolean {
  return message.role === "user";
}

/** Copies a message's plain text, silently doing nothing when there is none
 * to copy or the clipboard API is unavailable. */
export function copyMessageToClipboard(message: MessageItem): void {
  const text = copyableMessageText(message);
  if (!text || !navigator.clipboard) return;
  void navigator.clipboard.writeText(text).catch(() => undefined);
}

/**
 * The preview card a message carries, if any: a removal marker is not one, and neither is a card
 * on a message that is itself a card (`messageHostsLinkPreview`, the rule iOS and the server use).
 */
export function messageLinkPreview(message: MessageItem): LinkPreviewCard | undefined {
  if (!messageHostsLinkPreview(message)) return undefined;
  for (const block of message.blocks) {
    if (block.kind === "link_preview" && isLinkPreviewCard(block)) return block;
  }
  return undefined;
}

/** Remove preview is offered only while the message has a card to remove. */
export function canRemoveLinkPreview(message: MessageItem): boolean {
  return messageLinkPreview(message) !== undefined;
}

/**
 * Asks the server to drop the card, by the message its preview entry targets (a row folds a run's
 * entries, so its own id is not that message's). The thread's own update event removes it from
 * every open surface, so nothing is shown here, and a failure leaves the card where it was.
 */
export function removeLinkPreview(messageId: string): void {
  void rpc.messages.removeLinkPreview({ messageId }).catch(() => undefined);
}
