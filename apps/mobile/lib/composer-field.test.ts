import { sizes } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";
import { composerFieldStuckTall } from "./composer-field";

describe("composerFieldStuckTall", () => {
  it("flags an empty draft whose field is still several lines high", () => {
    expect(composerFieldStuckTall("", 5 * 22 + 22)).toBe(true);
    expect(composerFieldStuckTall("", sizes.composerTarget + 22)).toBe(true);
  });

  it("leaves a field that is back on one line alone", () => {
    expect(composerFieldStuckTall("", sizes.composerTarget)).toBe(false);
    expect(composerFieldStuckTall("", sizes.composerTarget + 0.5)).toBe(false);
  });

  it("ignores a field that has not been measured yet", () => {
    expect(composerFieldStuckTall("", null)).toBe(false);
  });

  it("never flags a draft with text, however tall the field is", () => {
    expect(composerFieldStuckTall("one\ntwo\nthree", 132)).toBe(false);
  });
});
