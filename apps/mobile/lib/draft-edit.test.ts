import type { AskDraft, EntryId } from "@rakazo/contracts";
import type { ThreadView } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDraftEdit,
  draftEditTarget,
  dropDraftEdit,
  keepDraftEdit,
  openDraftEdit,
  replacedDraft,
  syncDraftEdit,
} from "./draft-edit";

const draft: AskDraft = {
  app: { name: "Mail", logo: null },
  recipients: [{ role: "to", address: "marie@example.com" }],
  body: "Thursday instead?",
};

function waitingOn(card: unknown): Pick<ThreadView, "rows" | "waiting"> {
  return {
    rows: [{ item: { kind: "effect", id: "card-1", card } }] as unknown as ThreadView["rows"],
    waiting: { itemId: "card-1" as EntryId, entryId: "asked-again-2" as EntryId, runId: "run-1" },
  };
}

const pendingDraft = { kind: "ask", text: "Send?", status: "pending", draft };

afterEach(() => {
  dropDraftEdit("card-1");
  closeDraftEdit("card-1");
});

describe("replacedDraft", () => {
  it("hands the edited text of the waiting draft to the latest entry that asked", () => {
    keepDraftEdit("card-1", "Friday instead?");
    expect(replacedDraft(waitingOn(pendingDraft))).toEqual({
      itemId: "card-1",
      draft: { messageId: "asked-again-2", text: "Friday instead?" },
    });
  });

  it("replaces nothing when the text is the bot's own or the waiting card is not a draft", () => {
    keepDraftEdit("card-1", "Thursday instead?");
    expect(replacedDraft(waitingOn(pendingDraft))).toBeUndefined();
    keepDraftEdit("card-1", "Friday instead?");
    expect(replacedDraft(waitingOn({ kind: "ask", text: "Run it?", status: "pending" }))).toBe(
      undefined,
    );
    expect(replacedDraft({ ...waitingOn(pendingDraft), waiting: null })).toBeUndefined();
    expect(replacedDraft(waitingOn(pendingDraft))?.draft.text).toBe("Friday instead?");
  });
});

describe("edit message sheet", () => {
  it("opens on the card's draft and closes once that card can no longer be answered", () => {
    const router = { push: vi.fn() };
    openDraftEdit(router, { messageId: "card-1", draft });
    expect(router.push).toHaveBeenCalledWith("/edit-draft");
    expect(draftEditTarget()).toEqual({ messageId: "card-1", draft });
    syncDraftEdit("card-1");
    expect(draftEditTarget()?.messageId).toBe("card-1");
    syncDraftEdit(null);
    expect(draftEditTarget()).toBeNull();
  });
});
