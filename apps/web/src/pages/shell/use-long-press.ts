import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { ContextMenuPosition } from "../BotContextMenu";

const LONG_PRESS_MS = 500;
/** More movement than this during the hold is a scroll, not a press. */
const MOVE_TOLERANCE_PX = 10;

/** Opens the element's menu at `point`; false when it has none, so the native menu stays. */
export type MenuOpener = (target: HTMLElement, point: ContextMenuPosition) => boolean;

/**
 * A touch hold opens the same menu as `contextmenu`, which iOS Safari never fires.
 * The handlers own `onContextMenu` too, so on Android, where a hold fires both, the menu opens once.
 */
export function useLongPress() {
  const press = useRef<{ pointerId: number; x: number; y: number; timer: number } | null>(null);
  // Set once a hold opened a menu: the click the lifting finger still fires must not act.
  const opened = useRef(false);

  const cancel = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  return useCallback(
    (open: MenuOpener) => ({
      onPointerDown(event: ReactPointerEvent<HTMLElement>) {
        cancel();
        opened.current = false;
        if (event.pointerType !== "touch") return;
        const target = event.currentTarget;
        const point = { x: event.clientX, y: event.clientY };
        press.current = {
          pointerId: event.pointerId,
          ...point,
          timer: window.setTimeout(() => {
            press.current = null;
            opened.current = open(target, point);
          }, LONG_PRESS_MS),
        };
      },
      onPointerMove(event: ReactPointerEvent<HTMLElement>) {
        const start = press.current;
        if (
          start?.pointerId === event.pointerId &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX
        ) {
          cancel();
        }
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onContextMenu(event: ReactMouseEvent<HTMLElement>) {
        if (opened.current) {
          event.preventDefault();
          return;
        }
        const holding = press.current !== null;
        cancel();
        if (!open(event.currentTarget, { x: event.clientX, y: event.clientY })) return;
        event.preventDefault();
        opened.current = holding;
      },
      onClickCapture(event: ReactMouseEvent<HTMLElement>) {
        if (!opened.current) return;
        opened.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    }),
    [cancel],
  );
}
