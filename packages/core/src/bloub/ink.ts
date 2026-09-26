export const AVATAR_INK = {
  lightPaper: "#FFFFFF",
  darkPaper: "#101014",
  outline: "#17181A",
  lightPaperBelow: 0.4,
  outlineAbove: 0.78,
} as const;

export function avatarLuminance(hex: string): number {
  const clean = hex.replace(/^#/, "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const r = parseInt(expanded.slice(0, 2), 16);
  const g = parseInt(expanded.slice(2, 4), 16);
  const b = parseInt(expanded.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return 0.5;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function avatarInk(color: string): { paper: string; outline: string | null } {
  const luminance = avatarLuminance(color);
  return {
    paper: luminance < AVATAR_INK.lightPaperBelow ? AVATAR_INK.lightPaper : AVATAR_INK.darkPaper,
    outline: luminance > AVATAR_INK.outlineAbove ? AVATAR_INK.outline : null,
  };
}
