import { describe, expect, it } from "vitest";
import type { DraftCard, DraftLocal } from "./draft-card-view.js";
import {
  draftCardView,
  draftPrimaryAction,
  draftSentLine,
  draftSentTo,
} from "./draft-card-view.js";

const draft: DraftCard["draft"] = {
  app: { name: "Mail", logo: null, account: "ana@example.com" },
  recipients: [{ role: "to", address: "bo@example.com" }],
  subject: "Thursday",
  body: "Thursday instead?",
};
const waiting: DraftCard = { status: "pending", draft };
const idle: DraftLocal = {
  edited: false,
  focused: false,
  pending: null,
  canAnswer: true,
  owner: true,
};

describe("draftCardView", () => {
  it("shows a waiting draft with nothing at rest, then Editing, then Edited", () => {
    expect(draftCardView(waiting, idle)).toEqual({
      kind: "open",
      readOnly: false,
      sending: false,
      status: null,
    });
    expect(draftCardView(waiting, { ...idle, focused: true, edited: true })).toEqual({
      kind: "open",
      readOnly: false,
      sending: false,
      status: "editing",
    });
    expect(draftCardView(waiting, { ...idle, edited: true })).toEqual({
      kind: "open",
      readOnly: false,
      sending: false,
      status: "edited",
    });
  });

  it("freezes the card from the Send tap until the server reports it sent", () => {
    expect(draftCardView(waiting, { ...idle, edited: true, pending: "send" })).toEqual({
      kind: "open",
      readOnly: false,
      sending: true,
      status: null,
    });
    const approved: DraftCard = { status: "answered", answer: "allow", draft };
    expect(draftCardView(approved, { ...idle, canAnswer: false })).toEqual({
      kind: "open",
      readOnly: false,
      sending: true,
      status: null,
    });
    const sent: DraftCard = {
      ...approved,
      draft: { ...draft, sent: { at: "2026-10-24T10:44:00.000Z", edited: true } },
    };
    expect(draftCardView(sent, { ...idle, canAnswer: false })).toEqual({
      kind: "sent",
      at: "2026-10-24T10:44:00.000Z",
    });
  });

  it("keeps a draft that did not leave open, Not sent with its reason, until retried", () => {
    const failure = { reason: "Mail is disconnected.", disconnected: true as const };
    const notSent: DraftCard = { status: "pending", draft: { ...draft, failure } };
    expect(draftCardView(notSent, { ...idle, edited: true })).toEqual({
      kind: "open",
      readOnly: false,
      sending: false,
      status: "not_sent",
      failure,
    });
    expect(draftCardView(notSent, { ...idle, pending: "send" })).toEqual({
      kind: "open",
      readOnly: false,
      sending: true,
      status: null,
    });
  });

  it("offers Undo while a discard waits, then settles once the server has it", () => {
    expect(draftCardView(waiting, { ...idle, pending: "discard" })).toEqual({
      kind: "discarded",
      undo: true,
    });
    expect(draftCardView(waiting, { ...idle, pending: "discarding" })).toEqual({
      kind: "discarded",
      undo: false,
    });
    const denied: DraftCard = { status: "answered", answer: "deny", draft };
    expect(draftCardView(denied, { ...idle, canAnswer: false })).toEqual({
      kind: "discarded",
      undo: false,
    });
  });

  it("settles as Replaced when the person wrote to the bot instead", () => {
    const replaced: DraftCard = { status: "answered", answer: "dismissed", draft };
    expect(draftCardView(replaced, { ...idle, canAnswer: false })).toEqual({ kind: "replaced" });
  });

  it("shows another member the draft read-only, with no state of their own", () => {
    expect(draftCardView(waiting, { ...idle, owner: false })).toEqual({
      kind: "open",
      readOnly: true,
      sending: false,
      status: null,
    });
  });

  it("says a waiting draft is no longer active once its run stops waiting on it", () => {
    expect(draftCardView(waiting, { ...idle, canAnswer: false })).toEqual({ kind: "inactive" });
  });
});

describe("draftPrimaryAction", () => {
  it("asks to reconnect a disconnected app before offering to try again", () => {
    const disconnected = { reason: "Mail is disconnected.", disconnected: true as const };
    expect(draftPrimaryAction(undefined, false)).toBe("send");
    expect(draftPrimaryAction(disconnected, false)).toBe("reconnect");
    expect(draftPrimaryAction(disconnected, true)).toBe("try_again");
    expect(draftPrimaryAction({ reason: "Mail refused it." }, false)).toBe("try_again");
  });
});

describe("draftSentTo", () => {
  it("names the To recipients, and every recipient when the mail had no To", () => {
    expect(
      draftSentTo({
        ...draft,
        recipients: [
          { role: "to", address: "bo@example.com" },
          { role: "cc", address: "cy@example.com" },
          { role: "to", address: "dee@example.com" },
        ],
      }),
    ).toBe("bo@example.com, dee@example.com");
    expect(
      draftSentTo({
        ...draft,
        recipients: [
          { role: "bcc", address: "ed@example.com" },
          { role: "cc", address: "cy@example.com" },
        ],
      }),
    ).toBe("ed@example.com, cy@example.com");
  });

  it("names a chat message's person or channel as its app did, never its id", () => {
    const chat = { ...draft, recipients: [{ role: "to" as const, address: "D0MARIE" }] };
    expect(
      draftSentTo({
        ...chat,
        conversation: { kind: "person", name: "Marie Dupont", handle: "marie" },
      }),
    ).toBe("Marie Dupont");
    expect(draftSentTo({ ...chat, conversation: { kind: "channel", name: "general" } })).toBe(
      "#general",
    );
  });
});

describe("draftSentLine", () => {
  it("keeps a mail's subject, and a message's first line when it has none", () => {
    expect(draftSentLine(draft)).toBe("Thursday");
    expect(
      draftSentLine({ ...draft, subject: undefined, body: "\n  Hey Marie,\nThursday instead?" }),
    ).toBe("Hey Marie,");
    expect(draftSentLine({ ...draft, subject: "  ", body: "Thursday instead?" })).toBe(
      "Thursday instead?",
    );
  });
});
