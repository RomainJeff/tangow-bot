import type { AskDraft, AskDraftFields, AskDraftRecipient } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import { finishLines, sheetChanged } from "./draft-sheet";

const fields: AskDraftFields = { to: null, cc: null, bcc: null, subject: true };
const marie: AskDraftRecipient = { role: "to", address: "marie@example.com" };
const draft: AskDraft = {
  app: { name: "Mail", logo: null },
  recipients: [marie],
  fields,
  subject: "Thursday",
  body: "Thursday instead?",
};

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

describe("sheetChanged", () => {
  it("asks before Cancel only when something differs from what the sheet opened on", () => {
    const opening = { subject: "Friday" };
    expect(sheetChanged(draft, opening, { subject: "Friday", text: draft.body }, {})).toBe(false);
    expect(
      sheetChanged(draft, {}, { recipients: [{ role: "to", address: "MARIE@example.com" }] }, {}),
    ).toBe(false);
    expect(sheetChanged(draft, opening, { subject: "Saturday" }, {})).toBe(true);
    expect(sheetChanged(draft, opening, opening, { cc: "pa" })).toBe(true);
  });
});
