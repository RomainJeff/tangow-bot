/**
 * Pure geometry and colour helpers for the Stop button's contour: the ring IS the disc's border, with two glows in the bot's
 * identity colour chasing each other around it. The component draws the ring
 * as a fixed set of arc segments and rotates the whole thing with Reanimated,
 * so only the *static* per-segment opacity needs computing here.
 */

/**
 * Opacity for each of `count` evenly spaced segments around the ring,
 * following the design's conic sweep — transparent at 0 turns, the bot's
 * colour at .25, transparent at .5, colour again at .75, transparent at 1.
 * That is a triangle wave with two peaks per lap (two chasing glows).
 */
export function stopContourSweepOpacities(count: number): number[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, index) => {
    const turn = index / count;
    // Fold the turn into a single quarter-lap [0, .25] measured from the
    // nearest peak (.25 or .75); 0 there is a peak, .25 is a trough.
    const distanceFromPeak = Math.abs((((turn % 0.5) + 0.5) % 0.5) - 0.25);
    return 1 - distanceFromPeak / 0.25;
  });
}

/**
 * Appends an alpha channel to a `#RGB` or `#RRGGBB` colour, for the ring's
 * `foreground` fallback (group threads, or no bot colour known). Returns the
 * input unchanged if it is not a plain hex colour.
 */
export function hexWithAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return hex;
  const digits = match[1]!;
  const expanded =
    digits.length === 3
      ? digits
          .split("")
          .map((c) => c + c)
          .join("")
      : digits;
  const alphaHex = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${expanded}${alphaHex}`;
}
