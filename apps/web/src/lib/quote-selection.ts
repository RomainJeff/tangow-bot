import type { ThreadMessage } from "@rakazo/contracts";
import { REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";

/**
 * Resolves a text selection to the message it quotes. A quote stays scoped to
 * one message row — spanning selections, rows that didn't opt in via
 * `data-quotable`, and empty text get no affordance. The excerpt is capped at
 * capture so an oversized selection never fails the send.
 */
export function quoteDraftForSelection(
  selection: {
    startRow: Pick<HTMLElement, "dataset"> | null;
    endRow: Pick<HTMLElement, "dataset"> | null;
    text: string;
  },
  messageById: ReadonlyMap<string, ThreadMessage>,
): { message: ThreadMessage; text: string } | null {
  const { startRow, endRow } = selection;
  const message =
    startRow && startRow === endRow && startRow.dataset.quotable !== undefined
      ? messageById.get(startRow.dataset.messageId ?? "")
      : undefined;
  const text = selection.text.trim().slice(0, REPLY_QUOTE_MAX_LENGTH);
  if (!message || !text) return null;
  return { message, text };
}

/** Air between the Quote button and the selection or the viewport edge. */
const QUOTE_BUTTON_GAP_PX = 8;

/**
 * Where the Quote button's top-left corner goes, in viewport pixels: centred
 * above the selection, below it when there is no room above, and never past
 * either side of the viewport.
 */
export function quoteButtonPlacement(
  selection: Pick<DOMRect, "top" | "bottom" | "left" | "right">,
  button: { width: number; height: number },
  viewportWidth: number,
): { top: number; left: number } {
  const aboveTop = selection.top - QUOTE_BUTTON_GAP_PX - button.height;
  const centredLeft = (selection.left + selection.right - button.width) / 2;
  return {
    top: aboveTop >= 0 ? aboveTop : selection.bottom + QUOTE_BUTTON_GAP_PX,
    left: Math.min(
      Math.max(centredLeft, QUOTE_BUTTON_GAP_PX),
      viewportWidth - button.width - QUOTE_BUTTON_GAP_PX,
    ),
  };
}
