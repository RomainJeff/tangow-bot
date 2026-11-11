import type { AskDraft } from "@tangow/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDraftEdit, draftEditTarget, openDraftEdit, syncDraftEdit } from "./draft-edit";

const draft: AskDraft = {
  app: { name: "Mail", logo: null },
  recipients: [{ role: "to", address: "marie@example.com" }],
  body: "Thursday instead?",
};

afterEach(() => {
  closeDraftEdit("card-1");
});

describe("edit message sheet", () => {
  it("opens on the card's draft and closes once its own thread stops waiting on that card", () => {
    const router = { push: vi.fn() };
    openDraftEdit(router, { threadKey: "bot-a", messageId: "card-1", draft });
    expect(router.push).toHaveBeenCalledWith("/edit-draft");
    expect(draftEditTarget()?.messageId).toBe("card-1");
    syncDraftEdit("bot-a", "card-1");
    expect(draftEditTarget()?.messageId).toBe("card-1");
    syncDraftEdit("bot-b", "card-9");
    expect(draftEditTarget()?.messageId).toBe("card-1");
    syncDraftEdit("bot-a", null);
    expect(draftEditTarget()).toBeNull();
  });
});
