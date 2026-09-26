import { darkShadows, lightShadows } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";
import { botColors, shadowsForAppearance, tokens } from "./theme.js";

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
  it("uses the web's box-shadow tokens as they are, one set per appearance", () => {
    expect(shadowsForAppearance("light")).toBe(lightShadows);
    expect(shadowsForAppearance("dark")).toBe(darkShadows);
    expect(Object.keys(lightShadows).sort()).toEqual([
      "card",
      "composerFocus",
      "composerRest",
      "floating",
      "row",
    ]);
  });
});
