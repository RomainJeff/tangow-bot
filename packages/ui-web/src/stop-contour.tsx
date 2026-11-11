import { botAccentOn } from "@tangow/ui-tokens";
import type { ComponentPropsWithoutRef, CSSProperties } from "react";
import { cn } from "./lib/utils.js";

export interface StopContourProps extends ComponentPropsWithoutRef<"span"> {
  /**
   * The responding bot's identity colour, as a plain CSS colour string — data
   * from the bot, not a design token (same precedent as `BotAvatar`'s `color`
   * prop). Omit it in a group, or when no bot is known: the contour falls
   * back to a dim `foreground`, as it does in a theme where the colour would
   * not read (the near-black bot on dark, white on light).
   */
  color?: string;
}

/**
 * The Stop button's own edge: two glows of the bot's colour chase each other
 * around a 2 px ring, one lap per `--duration-flow`, and the disc sits just
 * inside it. No head, no accessible name of its own — fills a round button
 * (34/36 px) that already carries the "Stop" label. Reduced motion: the ring
 * holds still, fully lit.
 */
const DIM_FOREGROUND = "color-mix(in srgb, var(--foreground) 45%, transparent)";

export function StopContour({ color, className, style, ...props }: StopContourProps) {
  return (
    <span
      aria-hidden="true"
      data-slot="stop-contour"
      className={cn("relative grid size-full place-items-center rounded-full", className)}
      style={
        {
          ...style,
          "--contour-light": botAccentOn(color, "light") ?? DIM_FOREGROUND,
          "--contour-dark": botAccentOn(color, "dark") ?? DIM_FOREGROUND,
        } as CSSProperties
      }
      {...props}
    >
      <span className="rk-stop-contour absolute inset-0 rounded-full" />
      <span className="absolute inset-0.5 rounded-full bg-primary" />
      <span className="relative size-2.5 rounded-xs bg-primary-foreground" />
    </span>
  );
}
