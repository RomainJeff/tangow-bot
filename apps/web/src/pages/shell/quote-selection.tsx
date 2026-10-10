import { useLingui } from "@lingui/react/macro";
import type { ThreadMessage } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { TextQuote } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { quoteButtonPlacement, quoteDraftForSelection } from "../../lib/quote-selection";

const rowOf = (node: Node) =>
  (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
    "[data-message-id]",
  ) ?? null;

/**
 * Offers Quote over a text selection inside one transcript message. Keyboard
 * and assistive-tech selections never reach a mouseup, so the offer follows
 * selectionchange; a mouse drag only shows it once released.
 */
export function QuoteSelection({
  messageById,
  onQuote,
}: {
  messageById: ReadonlyMap<string, ThreadMessage>;
  onQuote: (message: ThreadMessage, quote: string) => void;
}) {
  const [draft, setDraft] = useState<{
    message: ThreadMessage;
    text: string;
    range: Range;
  } | null>(null);
  const selectingWithMouse = useRef(false);

  const evaluate = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setDraft(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const next = quoteDraftForSelection(
      {
        startRow: rowOf(range.startContainer),
        endRow: rowOf(range.endContainer),
        text: selection.toString(),
      },
      messageById,
    );
    setDraft(next ? { ...next, range } : null);
  }, [messageById]);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      selectingWithMouse.current = true;
      if ((event.target as Element | null)?.closest?.("[data-quote-selection]")) return;
      setDraft(null);
    };
    const onMouseUp = () => {
      selectingWithMouse.current = false;
      evaluate();
    };
    const onSelectionChange = () => {
      if (!selectingWithMouse.current) evaluate();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDraft(null);
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [evaluate]);

  if (!draft) return null;
  return (
    <QuoteButton
      range={draft.range}
      onQuote={() => {
        onQuote(draft.message, draft.text);
        window.getSelection()?.removeAllRanges();
        setDraft(null);
      }}
    />
  );
}

function QuoteButton({ range, onQuote }: { range: Range; onQuote: () => void }) {
  const { t } = useLingui();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      const button = buttonRef.current;
      if (!button || range.collapsed || !document.contains(range.commonAncestorContainer)) {
        setPlacement(null);
        return;
      }
      setPlacement(
        quoteButtonPlacement(
          range.getBoundingClientRect(),
          { width: button.offsetWidth, height: button.offsetHeight },
          window.innerWidth,
        ),
      );
    };
    update();
    window.addEventListener("resize", update);
    // Scroll doesn't bubble: the capture phase catches the transcript's own scroller.
    window.addEventListener("scroll", update, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [range]);

  return createPortal(
    <Button
      ref={buttonRef}
      variant="quickReply"
      size="quickReply"
      data-quote-selection
      data-testid="quote-selection"
      // Keeps the highlight alive until the click commits the quote.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onQuote}
      style={placement ?? { visibility: "hidden" }}
      className="fixed z-50 bg-surface shadow-floating transition-colors"
    >
      <TextQuote aria-hidden strokeWidth={1.7} />
      {t`Quote`}
    </Button>,
    document.body,
  );
}
