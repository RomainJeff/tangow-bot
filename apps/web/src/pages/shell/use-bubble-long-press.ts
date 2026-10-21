import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageItem } from "../../lib/thread-items";
import { isLiveItem } from "../../lib/thread-items";

/** B1: hold this long on a touch bubble to open its action sheet. */
const LONG_PRESS_MS = 450;
/** The bubble settles (scale 0.96) this far into the hold, before the sheet opens. */
const LONG_PRESS_SQUASH_MS = 150;
/** More than this many px of movement during the hold cancels it — a scroll, not a press. */
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
/** A long press starts on the bubble itself, not its controls (a link still starts one — B3). */
const LONG_PRESS_BUBBLE_SELECTOR = '[data-slot="message-row-bubble"],[data-slot="user-bubble"]';
const LONG_PRESS_EXCLUDED_SELECTOR =
  'button,[role="button"],[role="menuitem"],input,textarea,[contenteditable="true"],select';

// B1-B4: a touch long press on a message bubble opens its action sheet —
// the pill itself never appears on touch (no hover to reveal it with;
// mouse and keyboard keep the existing hover/focus pill).
export function useBubbleLongPress(scrollRef: RefObject<HTMLDivElement | null>) {
  const [pressingMessageId, setPressingMessageId] = useState<string | null>(null);
  const [sheetMessage, setSheetMessage] = useState<MessageItem | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const pressStart = useRef<{ id: string; pointerId: number; x: number; y: number } | null>(null);
  const squashTimer = useRef<number | undefined>(undefined);
  const openTimer = useRef<number | undefined>(undefined);
  // Set once the hold opens the sheet, so the click the browser still fires
  // once the finger lifts (even over a link) is swallowed instead of acting.
  const suppressClickForId = useRef<string | null>(null);

  const clearPressTimers = useCallback(() => {
    window.clearTimeout(squashTimer.current);
    window.clearTimeout(openTimer.current);
    squashTimer.current = undefined;
    openTimer.current = undefined;
  }, []);

  const cancelPress = useCallback(() => {
    clearPressTimers();
    pressStart.current = null;
    setPressingMessageId(null);
  }, [clearPressTimers]);

  const onBubblePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, message: MessageItem) => {
      // A second finger never starts, resets or cancels the first one's press.
      if (pressStart.current && pressStart.current.pointerId !== event.pointerId) {
        cancelPress();
        return;
      }
      // Each new touch starts fresh: a suppression left over from a previous
      // long press must never swallow an unrelated, later, genuine tap.
      suppressClickForId.current = null;
      if (event.pointerType !== "touch") return;
      // A message still being written has no actions yet (as on hover).
      if (isLiveItem(message)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(LONG_PRESS_EXCLUDED_SELECTOR)) return;
      if (!target?.closest(LONG_PRESS_BUBBLE_SELECTOR)) return;
      clearPressTimers();
      pressStart.current = {
        id: message.id,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
      squashTimer.current = window.setTimeout(() => {
        setPressingMessageId(message.id);
      }, LONG_PRESS_SQUASH_MS);
      openTimer.current = window.setTimeout(() => {
        pressStart.current = null;
        setPressingMessageId(null);
        suppressClickForId.current = message.id;
        setSheetMessage(message);
        setSheetOpen(true);
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    },
    [clearPressTimers, cancelPress],
  );

  const onBubblePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (pressStart.current && pressStart.current.pointerId !== event.pointerId) return;
      cancelPress();
    },
    [cancelPress],
  );

  const onBubblePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = pressStart.current;
      if (!start || start.pointerId !== event.pointerId) return;
      if (
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE_PX
      ) {
        cancelPress();
      }
    },
    [cancelPress],
  );

  // A link's click follows the pointerup that ended the long press that
  // opened the sheet for it (B3): swallow that one click so it never navigates.
  const onRowClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, messageId: string) => {
      if (suppressClickForId.current !== messageId) return;
      suppressClickForId.current = null;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  useEffect(() => cancelPress, [cancelPress]);
  // A real scroll gesture, wherever it starts, is never a long press.
  useEffect(() => {
    const scroller = scrollRef.current;
    scroller?.addEventListener("scroll", cancelPress, { passive: true });
    return () => scroller?.removeEventListener("scroll", cancelPress);
  }, [cancelPress, scrollRef]);

  return {
    pressingMessageId,
    sheetMessage,
    sheetOpen,
    setSheetOpen,
    onBubblePointerDown,
    onBubblePointerMove,
    onBubblePointerEnd,
    onRowClickCapture,
  };
}
