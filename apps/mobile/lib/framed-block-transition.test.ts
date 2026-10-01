import { describe, expect, it } from "vitest";
import { framedBlockDidTransitionToAnswered } from "./framed-block-transition";

describe("framedBlockDidTransitionToAnswered", () => {
  it("is true only when an open card becomes answered", () => {
    expect(framedBlockDidTransitionToAnswered("open", "answered")).toBe(true);
  });

  it("is false when a card is already answered at mount (previous is null)", () => {
    expect(framedBlockDidTransitionToAnswered(null, "answered")).toBe(false);
  });

  it("is false when a card is open at mount (previous is null)", () => {
    expect(framedBlockDidTransitionToAnswered(null, "open")).toBe(false);
  });

  it("is false once a card is already answered and stays answered", () => {
    expect(framedBlockDidTransitionToAnswered("answered", "answered")).toBe(false);
  });

  it("is false for an open card that stays open", () => {
    expect(framedBlockDidTransitionToAnswered("open", "open")).toBe(false);
  });
});
