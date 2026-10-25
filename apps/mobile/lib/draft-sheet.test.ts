import type { AskDraftFields, AskDraftRecipient } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { finishLines, foldedRoles, withRole } from "./draft-sheet";

const fields: AskDraftFields = { to: null, cc: null, bcc: null, subject: true };
const marie: AskDraftRecipient = { role: "to", address: "marie@example.com" };

describe("withRole", () => {
  it("replaces one role's addresses and keeps To, Cc, Bcc in order", () => {
    const recipients: AskDraftRecipient[] = [{ role: "bcc", address: "ed@example.com" }, marie];
    expect(withRole(recipients, "cc", ["paul@example.com"])).toEqual([
      marie,
      { role: "cc", address: "paul@example.com" },
      { role: "bcc", address: "ed@example.com" },
    ]);
  });
});

describe("foldedRoles", () => {
  it("folds an empty Cc or Bcc the draft takes until it is opened, typed in or filled", () => {
    expect(foldedRoles(fields, [marie], {}, new Set())).toEqual(["cc", "bcc"]);
    expect(foldedRoles(fields, [marie], { bcc: "ed" }, new Set(["cc"]))).toEqual([]);
    expect(foldedRoles({ to: 1 }, [marie], {}, new Set())).toEqual([]);
  });
});

describe("finishLines", () => {
  it("joins every row's finished typing on Done", () => {
    expect(finishLines(fields, [marie], { cc: "paul@example.com" })).toEqual({
      recipients: [marie, { role: "cc", address: "paul@example.com" }],
      typed: {},
      held: false,
    });
  });

  it("holds Done back on a word that is not an address, or past a row's room", () => {
    expect(finishLines(fields, [marie], { cc: "paul" })).toEqual({
      recipients: [marie],
      typed: { cc: "paul " },
      held: true,
    });
    expect(finishLines({ to: 1 }, [marie], { to: "bo@example.com" }).held).toBe(true);
  });
});
