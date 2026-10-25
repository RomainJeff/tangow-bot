import { describe, expect, it } from "vitest";
import { heldBack, takeAddresses } from "./draft-lines.js";

describe("takeAddresses", () => {
  it("joins an address once a separator finishes it, and keeps the word still being typed", () => {
    expect(takeAddresses([], "marie@example.com, paul@exa", null, false)).toEqual({
      addresses: ["marie@example.com"],
      typed: "paul@exa",
    });
    expect(takeAddresses(["marie@example.com"], "paul@example.com", null, true)).toEqual({
      addresses: ["marie@example.com", "paul@example.com"],
      typed: "",
    });
  });

  it("drops a duplicate whatever its case, and sends a non-address back to the field", () => {
    expect(takeAddresses(["marie@example.com"], "MARIE@example.com marie ", null, false)).toEqual({
      addresses: ["marie@example.com"],
      typed: "marie ",
    });
  });

  it("stops at the line's room and hands the overflow back", () => {
    expect(takeAddresses([], "a@example.com b@example.com", 1, true)).toEqual({
      addresses: ["a@example.com"],
      typed: "b@example.com ",
    });
  });
});

describe("heldBack", () => {
  it("marks a finished word that could not join, not a word still being typed", () => {
    expect(heldBack("marie ")).toBe(true);
    expect(heldBack("marie")).toBe(false);
    expect(heldBack("")).toBe(false);
  });
});
