import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./lib/utils.js";

export type HoverPillProps = ComponentPropsWithoutRef<"div">;

/**
 * Message actions, absent until the row is hovered or focused from the
 * keyboard. Anchors to the top `end` corner of a `group relative` row
 * (`MessageRow` already is one), unless the row sets `data-pill="beside"`
 * with `--pill-x` / `--pill-y`, which move it next to the bubble it acts on.
 * Children are `roundIconSm` buttons, each with its own `aria-label`.
 *
 * Hidden at rest and revealed only by hover or keyboard focus on the row. A
 * touch device never hovers, so the pill simply never appears there — the
 * thread stays clean instead of carrying a permanent pill on every message.
 * Native touch surfaces expose these actions through their own gestures.
 *
 * Keyboard focus reveals it, a click does not: a button that keeps focus after
 * being clicked (a disclosure, Reply) would otherwise pin the pill until the
 * next click elsewhere.
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
        "rk-glass-control pointer-events-none absolute -top-3 end-3 z-10 flex items-center gap-0.5 rounded-full p-0.75 opacity-0 transition-opacity duration-(--duration-hover) ease-quiet",
        // The blur only while shown: every message row carries a hidden pill.
        "backdrop-filter-none group-hover:backdrop-filter-(--glass-control-backdrop)",
        "group-hover:pointer-events-auto group-hover:opacity-100",
        "group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 group-has-[:focus-visible]:backdrop-filter-(--glass-control-backdrop)",
        "group-data-[pill=beside]:end-auto group-data-[pill=beside]:top-(--pill-y) group-data-[pill=beside]:start-(--pill-x)",
        className,
      )}
      {...props}
    />
  );
}
