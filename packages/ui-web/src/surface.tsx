import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./lib/utils.js";

export type SurfaceRadius = "card" | "block";
export type SurfaceVariant = "default" | "outlined";

export interface SurfaceProps extends ComponentPropsWithoutRef<"div"> {
  /** `card` (14) for a plain card, `block` (18) to match a framed block. */
  radius?: SurfaceRadius;
  /** `outlined` trades the `border` hairline for a 1 pt `outline` edge — the
   * thread's only outlined card, for a delegated task's result (subagent).
   * Default unchanged. */
  variant?: SurfaceVariant;
  as?: "div" | "section" | "article" | "aside" | "figure";
}

/**
 * The unframed card of the thread: one fill, one hairline, never a shadow —
 * elevation belongs to `FramedBlock`, the composer and the hover pill.
 */
export function Surface({
  radius = "card",
  variant = "default",
  as = "div",
  className,
  ...props
}: SurfaceProps) {
  const Tag = as;
  return (
    <Tag
      data-slot="surface"
      data-radius={radius}
      data-variant={variant}
      className={cn(
        "border bg-surface",
        variant === "outlined" ? "border-outline" : "border-border",
        radius === "block" ? "rounded-block" : "rounded-card",
        className,
      )}
      {...props}
    />
  );
}
