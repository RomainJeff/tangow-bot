import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./lib/utils.js";

export type SurfaceRadius = "card" | "block";

export interface SurfaceProps extends ComponentPropsWithoutRef<"div"> {
  /** `card` (14) for a plain card, `block` (18) to match a framed block. */
  radius?: SurfaceRadius;
  as?: "div" | "section" | "article" | "aside" | "figure";
}

/**
 * The unframed card of the thread: one fill, one hairline, never a shadow —
 * elevation belongs to `FramedBlock`, the composer and the hover pill.
 */
export function Surface({ radius = "card", as = "div", className, ...props }: SurfaceProps) {
  const Tag = as;
  return (
    <Tag
      data-slot="surface"
      data-radius={radius}
      className={cn(
        "border border-border bg-surface",
        radius === "block" ? "rounded-block" : "rounded-card",
        className,
      )}
      {...props}
    />
  );
}
