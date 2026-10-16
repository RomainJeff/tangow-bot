export const BOT_LINK_UNDERLINE = 0.35;
export const USER_LINK_UNDERLINE = 0.45;

/** A link in a bubble keeps the bubble's ink; only its underline is a veil of it. `ink` is a `#RRGGBB` token. */
export function linkUnderline(ink: string, opacity = BOT_LINK_UNDERLINE): string {
  const alpha = Math.round(opacity * 255)
    .toString(16)
    .padStart(2, "0");
  return `${ink}${alpha}`;
}
