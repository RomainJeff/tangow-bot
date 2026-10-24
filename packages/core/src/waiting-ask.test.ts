import type { AskDraft, EntryId } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { ThreadView } from "./session-log/project-thread-view.js";
import { editedWaitingDraft, waitingAnswerTarget } from "./waiting-ask.js";

const draft: AskDraft = {
  app: { name: "Mail", logo: null },
  recipients: [{ role: "to", address: "marie@example.com" }],
  body: "Thursday instead?",
};

// A draft that did not leave was asked again: the card keeps its row, the run waits on a new entry.
const askedAgain = {
  itemId: "card-1" as EntryId,
  entryId: "asked-again-2" as EntryId,
  runId: "run-1",
};

function waitingOn(card: unknown): Pick<ThreadView, "rows" | "waiting"> {
  return {
    rows: [{ item: { kind: "effect", id: "card-1", card } }] as unknown as ThreadView["rows"],
    waiting: askedAgain,
  };
}

const pendingDraft = { kind: "ask", text: "Send?", status: "pending", draft };

describe("waitingAnswerTarget", () => {
  it("answers the card's latest entry, and nothing for a card the thread does not wait on", () => {
    expect(waitingAnswerTarget(askedAgain, "card-1")).toEqual({
      runId: "run-1",
      entryId: "asked-again-2",
    });
    expect(waitingAnswerTarget(askedAgain, "card-0")).toBeNull();
    expect(waitingAnswerTarget(null, "card-1")).toBeNull();
  });
});

describe("editedWaitingDraft", () => {
  it("hands the edited text of the waiting draft to the latest entry that asked", () => {
    expect(editedWaitingDraft(waitingOn(pendingDraft), () => "Friday instead?")).toEqual({
      itemId: "card-1",
      draft: { messageId: "asked-again-2", text: "Friday instead?" },
    });
  });

  it("hands edited recipients and subject with the text the card shows", () => {
    const recipients = [{ role: "to" as const, address: "paul@example.com" }];
    expect(
      editedWaitingDraft(waitingOn(pendingDraft), () => ({ recipients, subject: "Friday" })),
    ).toEqual({
      itemId: "card-1",
      draft: {
        messageId: "asked-again-2",
        text: "Thursday instead?",
        recipients,
        subject: "Friday",
      },
    });
    expect(
      editedWaitingDraft(waitingOn(pendingDraft), () => ({ recipients: draft.recipients })),
    ).toBeUndefined();
  });

  it("replaces nothing for the bot's own text, an untouched card or a card that is not a draft", () => {
    expect(editedWaitingDraft(waitingOn(pendingDraft), () => "Thursday instead?")).toBeUndefined();
    expect(editedWaitingDraft(waitingOn(pendingDraft), () => undefined)).toBeUndefined();
    const approval = { kind: "ask", text: "Run it?", status: "pending" };
    expect(editedWaitingDraft(waitingOn(approval), () => "Friday instead?")).toBeUndefined();
    expect(editedWaitingDraft(waitingOn(pendingDraft), () => "Friday instead?")?.draft.text).toBe(
      "Friday instead?",
    );
  });
});
