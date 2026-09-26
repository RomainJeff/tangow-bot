/** Product palette for Expo. Prefer these over hardcoded Rakazo hexes.
 * System chrome (nav bars, fills, labels) stays in `./native` via PlatformColor. */
/**
 * Elevation for Expo: the design contract's CSS `box-shadow` strings as they
 * are, passed to RN's `boxShadow`. It draws every layer — the `0 0 0 1px`
 * ring, the negative spread that tucks a blur under its surface — which RN's
 * single `shadow*` shadow could not, and it is not clipped by `overflow`.
 */
export { botColors, shadowsForAppearance, tokens } from "@rakazo/ui-tokens";
