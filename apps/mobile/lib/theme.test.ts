import { darkShadows, lightShadows } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";
import { botColors, shadowsForAppearance } from "./theme.js";

describe("mobile theme tokens", () => {
  it("re-exports botColors for identity accents", () => {
    expect(botColors.length).toBeGreaterThan(0);
    expect(botColors[0]).toBe("#00C46A");
  });
});

describe("mobile elevation", () => {
  it("uses the web's box-shadow tokens as they are, one set per appearance", () => {
    expect(shadowsForAppearance("light")).toBe(lightShadows);
    expect(shadowsForAppearance("dark")).toBe(darkShadows);
  });
});
