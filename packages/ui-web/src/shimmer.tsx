import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./lib/utils.js";

export type ShimmerProps = ComponentPropsWithoutRef<"span">;

/**
 * A light sweep travelling across a text label, for the one line that is still
 * being written. Hand-ported from beautifului.dev
 * (github.com/TurboKach/ai-native-react-components, MIT (c) 2026 Turbo).
 */
export function Shimmer({ className, ...props }: ShimmerProps) {
  return <span data-slot="shimmer" className={cn("rk-shimmer", className)} {...props} />;
}
