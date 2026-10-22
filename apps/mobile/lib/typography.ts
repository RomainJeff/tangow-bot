import type { TypographyKey } from "@rakazo/ui-tokens";
import { typography } from "@rakazo/ui-tokens";

/** A `Text` style built from a `typography` token, RN-shaped (no CSS units). */
export type NativeTextStyle = {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  fontWeight: "400" | "500" | "600" | "700";
};

/** `"-0.008em"` -> `-0.008`; `"0"` -> `0`. */
function trackingEm(tracking: string): number {
  const parsed = Number.parseFloat(tracking);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Builds a native `Text` style from a shared typography token. A few surfaces
 * carry a documented mobile-only delta (design contract §1.2, §3.7 — message
 * `body` is 17/22 instead of the shared 16/24, the thread `title` is
 * 17/22 instead of 15/20): pass `size`/`leading`/`weight` to override
 * just those numbers while the rest of the token (tracking) still applies.
 */
export function nativeTextStyle(
  key: TypographyKey,
  overrides?: { size?: number; leading?: number; weight?: number },
): NativeTextStyle {
  const token = typography[key];
  const size = overrides?.size ?? token.size;
  const leading = overrides?.leading ?? token.leading;
  const weight = overrides?.weight ?? token.weight;
  const letterSpacing = Math.round(trackingEm(token.tracking) * size * 1000) / 1000;
  return {
    fontSize: size,
    lineHeight: Math.round(size * leading),
    letterSpacing,
    fontWeight: String(weight) as NativeTextStyle["fontWeight"],
  };
}
