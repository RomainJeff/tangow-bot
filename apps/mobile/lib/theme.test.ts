import { darkShadows, lightShadows } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";
import {
  botColors,
  darkElevation,
  elevationForAppearance,
  elevationFromCssShadow,
  lightElevation,
  tokens,
} from "./theme.js";

describe("mobile theme tokens", () => {
  it("exposes the shared product palette used by custom surfaces", () => {
    expect(tokens.background).toBe("#0C0C0E");
    expect(tokens.foreground).toBe("#F2F2F0");
    expect(tokens.primary).toBe("#F2F2F0");
  });

  it("re-exports botColors for identity accents", () => {
    expect(botColors.length).toBeGreaterThan(0);
    expect(botColors[0]).toBe("#00C46A");
  });
});

describe("mobile elevation", () => {
  it("gives every screen at most one row/card/composer/floating shadow", () => {
    for (const palette of [lightElevation, darkElevation]) {
      expect(Object.keys(palette).sort()).toEqual(["card", "composer", "floating", "row"]);
    }
  });

  it('drops the selected-row shadow in dark, matching darkShadows.row = "none"', () => {
    expect(darkElevation.row.shadowOpacity).toBe(0);
    expect(darkElevation.row.elevation).toBe(0);
    expect(lightElevation.row.shadowOpacity).toBeGreaterThan(0);
  });

  it("keeps every shadow vertical (RN has no CSS x-offset use here)", () => {
    for (const palette of [lightElevation, darkElevation]) {
      for (const style of Object.values(palette)) {
        expect(style.shadowOffset.width).toBe(0);
      }
    }
  });

  it("resolves light vs dark by appearance", () => {
    expect(elevationForAppearance("light")).toBe(lightElevation);
    expect(elevationForAppearance("dark")).toBe(darkElevation);
  });

  it("uses a stronger shadow color in dark, since only black reads on a near-black background", () => {
    expect(lightElevation.card.shadowColor).toBe("#111114");
    expect(darkElevation.card.shadowColor).toBe("#000000");
    expect(darkElevation.card.shadowOpacity).toBeGreaterThan(lightElevation.card.shadowOpacity);
  });

  it("derives every elevation from the real lightShadows/darkShadows strings, not a transcription", () => {
    for (const key of Object.keys(lightShadows) as (keyof typeof lightShadows)[]) {
      expect(lightElevation[key]).toEqual(elevationFromCssShadow(lightShadows[key]));
      expect(darkElevation[key]).toEqual(elevationFromCssShadow(darkShadows[key]));
    }
  });
});

describe("elevationFromCssShadow", () => {
  it("reads a single-layer shadow's offset, blur and rgba color", () => {
    const style = elevationFromCssShadow("0 1px 2px rgba(17, 17, 20, 0.06)");
    expect(style.shadowOffset).toEqual({ width: 0, height: 1 });
    expect(style.shadowRadius).toBe(1);
    expect(style.shadowOpacity).toBeCloseTo(0.06);
    expect(style.shadowColor).toBe("#111114");
    expect(style.elevation).toBe(1);
  });

  it("reads only the LAST layer of a multi-layer shadow (the ring is a border, not this shadow)", () => {
    const style = elevationFromCssShadow(lightShadows.card);
    // lightShadows.card = "0 0 0 1px rgba(17, 17, 20, 0.08), 0 12px 30px -16px rgba(17, 17, 20, 0.4)"
    expect(style.shadowOffset).toEqual({ width: 0, height: 12 });
    expect(style.shadowRadius).toBe(15);
    expect(style.shadowOpacity).toBeCloseTo(0.4);
    expect(style.elevation).toBe(8);
  });

  it('treats "none" as no shadow at all', () => {
    const style = elevationFromCssShadow(darkShadows.row);
    expect(style.shadowOpacity).toBe(0);
    expect(style.shadowRadius).toBe(0);
    expect(style.elevation).toBe(0);
  });

  it("converts a black rgba layer to an opaque hex color plus its own opacity", () => {
    const style = elevationFromCssShadow(darkShadows.card);
    expect(style.shadowColor).toBe("#000000");
    expect(style.shadowOpacity).toBeCloseTo(0.8);
  });
});
