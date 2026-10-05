import type { ThreadMessage } from "@rakazo/contracts";
import { copyableMessageText } from "../../lib/message-text";

/**
 * Shared by the hover pill (`message-hover-actions.tsx`) and the touch long-press
 * sheet (`message-actions-sheet.tsx`) so the two surfaces can never drift on
 * what a message allows.
 */

/** Speak/Stop shows only once the voice provider is ready and the message has
 * plain text to read (never for progress-only or attachment-only messages). */
export function canSpeakMessage(message: ThreadMessage, voiceReady: boolean): boolean {
  return voiceReady && message.blocks.some((block) => block.kind === "text");
}

/** Edit and resend is a person's own message only. */
export function canEditAndResendMessage(message: ThreadMessage): boolean {
  return message.role === "user";
}

/** Copies a message's plain text, silently doing nothing when there is none
 * to copy or the clipboard API is unavailable. */
export function copyMessageToClipboard(message: ThreadMessage): void {
  const text = copyableMessageText(message);
  if (!text || !navigator.clipboard) return;
  void navigator.clipboard.writeText(text).catch(() => undefined);
}
