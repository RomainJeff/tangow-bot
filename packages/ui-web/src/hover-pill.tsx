import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./lib/utils.js";

export type HoverPillProps = ComponentPropsWithoutRef<"div">;

/**
 * Message actions, absent until the row is hovered or focused. Anchors to the
 * `end` edge of a `group relative` row (`MessageRow` already is one). Children
 * are `roundIconSm` buttons, each with its own `aria-label`.
 *
 * Hidden at rest and revealed only by hover or keyboard focus on the row. A
 * touch device never hovers, so the pill simply never appears there — the
 * thread stays clean instead of carrying a permanent pill on every message.
 * Native touch surfaces expose these actions through their own gestures.
 *
 * `z-10` keeps it above the message body it is a previous sibling of: without
 * it the body paints on top and, though the pill still shows (the body is
 * transparent there), the body swallows the clicks and the buttons go dead.
 */
export function HoverPill({ className, ...props }: HoverPillProps) {
  return (
    <div
      data-slot="hover-pill"
      className={cn(
        "pointer-events-none absolute -top-3 end-3 z-10 flex items-center gap-0.5 rounded-full bg-surface p-0.75 opacity-0 shadow-floating transition-opacity duration-(--duration-hover) ease-quiet",
        "group-hover:pointer-events-auto group-hover:opacity-100",
        "group-focus-within:pointer-events-auto group-focus-within:opacity-100",
        className,
      )}
      {...props}
    />
  );
}
