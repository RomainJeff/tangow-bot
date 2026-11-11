import type { AskDraftFields, AskDraftRecipient } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import { changeLine, foldedRoles, heldBack, takeAddresses } from "./draft-lines.js";

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

const fields: AskDraftFields = { to: null, cc: null, bcc: null, subject: true };
const marie: AskDraftRecipient = { role: "to", address: "marie@example.com" };
const paul: AskDraftRecipient = { role: "cc", address: "paul@example.com" };

describe("changeLine", () => {
  it("keeps To, Cc, Bcc in order", () => {
    const recipients: AskDraftRecipient[] = [{ role: "bcc", address: "ed@example.com" }, marie];
    expect(changeLine(recipients, new Set(), "cc", ["paul@example.com"]).recipients).toEqual([
      marie,
      paul,
      { role: "bcc", address: "ed@example.com" },
    ]);
  });

  it("keeps a Cc the draft came with open once the person removes its last address", () => {
    const removed = changeLine([marie, paul], new Set(), "cc", []);
    expect(removed.recipients).toEqual([marie]);
    expect(foldedRoles(fields, removed.recipients, {}, removed.opened)).toEqual(["bcc"]);
  });
});

describe("foldedRoles", () => {
  it("folds an empty Cc or Bcc the draft takes until it is opened, typed in or filled", () => {
    expect(foldedRoles(fields, [marie], {}, new Set())).toEqual(["cc", "bcc"]);
    expect(foldedRoles(fields, [marie], { bcc: "ed" }, new Set(["cc"]))).toEqual([]);
    expect(foldedRoles(fields, [marie, paul], {}, new Set())).toEqual(["bcc"]);
    expect(foldedRoles({ to: 1 }, [marie], {}, new Set())).toEqual([]);
    expect(foldedRoles(undefined, [marie], {}, new Set())).toEqual([]);
  });
});
