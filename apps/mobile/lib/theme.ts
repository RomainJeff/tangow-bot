import type { ResolvedAppearance, ShadowKey } from "@rakazo/ui-tokens";
import { darkShadows, lightShadows } from "@rakazo/ui-tokens";

/** Product palette for Expo. Prefer these over hardcoded Rakazo hexes.
 * System chrome (nav bars, fills, labels) stays in `./native` via PlatformColor. */
export { botColors, tokens } from "@rakazo/ui-tokens";

/** A native shadow, RN-shaped (no CSS `box-shadow` string). */
export type ElevationStyle = {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  /** Android's shadow model; ignored on iOS. */
  elevation: number;
};

export type ElevationTokens = Record<ShadowKey, ElevationStyle>;

const NONE: ElevationStyle = {
  shadowColor: "#000000",
  shadowOffset: { width: 0, height: 0 },
  shadowOpacity: 0,
  shadowRadius: 0,
  elevation: 0,
};

/** Splits a CSS `box-shadow` value into its comma-separated layers, without
 * being fooled by the commas inside each layer's `rgba(...)`. */
function shadowLayers(value: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      layers.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) layers.push(current.trim());
  return layers;
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (channel: number) => Math.round(channel).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/** `blur / 2` follows the common approximation for a CSS `box-shadow`'s blur
 * radius; Android's single-number elevation has no direct equivalent, so it
 * scales off the same blur instead of a second hand-picked constant. */
function androidElevationFromBlur(blur: number): number {
  if (blur <= 0) return 0;
  return Math.max(1, Math.round(blur / 4));
}

/**
 * Turns one layer of a design-contract `box-shadow` string (`"0 12px 30px
 * -16px rgba(17, 17, 20, 0.4)"`) into RN's shadow props. RN has a single
 * shadow, so this reads the LAST layer — the soft blur — of a token that
 * layers a blur under a `0 0 0 1px` ring (design contract §1.5): `card`'s
 * ring is not reproduced here, `FramedBlock`/`Surface` draw it as a real
 * `border-border` hairline instead, which also reads as the visible cue in
 * dark mode where the blur itself all but disappears against a near-black
 * background.
 */
export function elevationFromCssShadow(value: string): ElevationStyle {
  const layer = shadowLayers(value).pop();
  if (!layer || layer === "none") return NONE;
  const colorMatch = /rgba?\([^)]*\)/.exec(layer);
  if (!colorMatch) return NONE;
  const rgbaMatch =
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(colorMatch[0]);
  if (!rgbaMatch) return NONE;
  const [, r, g, b, a] = rgbaMatch;
  const lengths = layer
    .replace(colorMatch[0], "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => Number.parseFloat(token));
  const [offsetX = 0, offsetY = 0, blur = 0] = lengths;
  return {
    shadowColor: rgbToHex(Number(r), Number(g), Number(b)),
    shadowOffset: { width: offsetX, height: offsetY },
    shadowOpacity: a === undefined ? 1 : Number(a),
    shadowRadius: blur / 2,
    elevation: androidElevationFromBlur(blur),
  };
}

function elevationFromShadows(shadows: Record<ShadowKey, string>): ElevationTokens {
  const entries = (Object.keys(shadows) as ShadowKey[]).map(
    (key) => [key, elevationFromCssShadow(shadows[key])] as const,
  );
  return Object.fromEntries(entries) as ElevationTokens;
}

export const lightElevation: ElevationTokens = elevationFromShadows(lightShadows);
export const darkElevation: ElevationTokens = elevationFromShadows(darkShadows);

export function elevationForAppearance(appearance: ResolvedAppearance): ElevationTokens {
  return appearance === "light" ? lightElevation : darkElevation;
}
