"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useRef, useState } from "react";
import { usePrefersReducedMotion } from "./lib/reduced-motion.js";
import { cn } from "./lib/utils.js";

export interface ActionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Screen-reader-only heading — the sheet itself shows no visible title. */
  title: string;
  children: ReactNode;
  className?: string;
}

/** Past this many px of downward drag, releasing closes the sheet. */
export const DRAG_CLOSE_THRESHOLD_PX = 80;
/** A fast downward flick closes even short of the threshold. */
const FLICK_VELOCITY_PX_PER_MS = 0.5;
const FLICK_MIN_DELTA_PX = 24;

/**
 * B6: past 80px of downward drag, releasing closes the sheet; short of that,
 * it snaps back — unless the release was a fast flick (a real drag can cover
 * little distance yet still clearly mean "dismiss").
 */
export function shouldCloseActionSheetDrag(deltaPx: number, elapsedMs: number): boolean {
  const delta = Math.max(0, deltaPx);
  const velocity = delta / Math.max(1, elapsedMs);
  const pastThreshold = delta > DRAG_CLOSE_THRESHOLD_PX;
  const flicked = delta > FLICK_MIN_DELTA_PX && velocity > FLICK_VELOCITY_PX_PER_MS;
  return pastThreshold || flicked;
}

/**
 * A bottom-anchored action sheet — quick reactions and a message's actions on
 * touch (`transcript.tsx`'s long press), built on the same Base UI `Dialog`
 * as `components/ui/dialog.tsx` rather than a new dependency. Escape,
 * a backdrop click, and focus trapping all come from `Dialog.Root` itself,
 * same as the centered dialog; this primitive only adds the bottom-sheet
 * anchoring, the slide-up entrance, and the drag-to-dismiss gesture.
 */
export function ActionSheet({ open, onOpenChange, title, children, className }: ActionSheetProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [dragPx, setDragPx] = useState(0);
  const drag = useRef<{ startY: number; startedAt: number; active: boolean } | null>(null);

  function onHandlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    drag.current = { startY: event.clientY, startedAt: performance.now(), active: true };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onHandlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state?.active) return;
    setDragPx(Math.max(0, event.clientY - state.startY));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    drag.current = null;
    if (!state?.active) return;
    const delta = event.clientY - state.startY;
    const elapsedMs = performance.now() - state.startedAt;
    setDragPx(0);
    if (shouldCloseActionSheetDrag(delta, elapsedMs)) onOpenChange(false);
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          data-slot="action-sheet-backdrop"
          className="fixed inset-0 z-50 bg-overlay duration-(--duration-hover) data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
        <DialogPrimitive.Popup
          data-slot="action-sheet"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85vh] w-full max-w-thread flex-col rounded-t-block bg-popover text-popover-foreground shadow-floating outline-none",
            "duration-(--duration-arrive) ease-quiet data-open:animate-in data-closed:animate-out data-closed:fade-out-0",
            reducedMotion
              ? "data-open:fade-in-0"
              : "data-open:slide-in-from-bottom data-open:fade-in-0 data-closed:slide-out-to-bottom",
            className,
          )}
          style={dragPx ? { transform: `translateY(${dragPx}px)`, transition: "none" } : undefined}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <div
            data-slot="action-sheet-handle"
            className="flex shrink-0 touch-none justify-center py-2.5"
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <span aria-hidden="true" className="h-1 w-9 rounded-full bg-border" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-4">{children}</div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
