import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./lib/utils.js";

export type SurfaceVariant = "default" | "outlined";

export interface SurfaceProps extends ComponentPropsWithoutRef<"div"> {
  /** `outlined` trades the paper's edge for a 1 pt `outline` ring — the
   * thread's only outlined card, for a delegated task's result (subagent). */
  variant?: SurfaceVariant;
  as?: "div" | "section" | "article" | "aside" | "figure";
}

/**
 * The bot's paper: what the bot produces sits on the same plane as its bubble,
 * never lifted — elevation belongs to `FramedBlock`, the composer and the hover pill.
 */
export function Surface({ variant = "default", as = "div", className, ...props }: SurfaceProps) {
  const Tag = as;
  return (
    <Tag
      data-slot="surface"
      data-variant={variant}
      className={cn(
        "rounded-bubble bg-chat-bot",
        variant === "outlined" ? "ring-1 ring-outline" : "shadow-bubble",
        className,
      )}
      {...props}
    />
  );
}
