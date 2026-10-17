export const BOT_LINK_UNDERLINE = 0.35;
export const USER_LINK_UNDERLINE = 0.45;

/** `ink` (a `#RRGGBB` token) at `opacity`, as `#RRGGBBAA`. */
export function veil(ink: string, opacity: number): string {
  const alpha = Math.round(opacity * 255)
    .toString(16)
    .padStart(2, "0");
  return `${ink}${alpha}`;
}

/** A link in a bubble keeps the bubble's ink; only its underline is a veil of it. */
export function linkUnderline(ink: string, opacity = BOT_LINK_UNDERLINE): string {
  return veil(ink, opacity);
}
