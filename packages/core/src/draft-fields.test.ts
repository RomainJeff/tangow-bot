import type { AskDraftEdits, AskDraftRecipient } from "@tangow/contracts";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { RecipientSlot } from "./draft-fields.js";
import { askDraftFields } from "./draft-fields.js";
import { acceptDraftProposal } from "./draft-proposal.js";
import type { DraftBinding } from "./outbound-draft.js";
import { draftMessage, draftSentResult, editDraftRequest, readDraft } from "./outbound-draft.js";

const strings = { type: "array", items: { type: "string" } };
// Field names and types from Composio's Gmail and Outlook toolkits (2026-10).
const gmailSchema = {
  type: "object",
  properties: {
    recipient_email: { type: "string" },
    extra_recipients: strings,
    cc: strings,
    bcc: strings,
    subject: { type: "string" },
    body: { type: "string" },
    is_html: { type: "boolean" },
  },
};
const outlookSchema = {
  type: "object",
  properties: {
    to: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
    cc_emails: strings,
    bcc_emails: strings,
  },
};
const graphSchema = {
  type: "object",
  properties: {
    toRecipients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          emailAddress: { type: "object", properties: { address: { type: "string" } } },
        },
      },
    },
    ccRecipients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          emailAddress: { type: "object", properties: { address: { type: "string" } } },
        },
      },
    },
    subject: { type: "string" },
    content: { type: "string" },
  },
};

type Slot = RecipientSlot & { addresses: string[] };
const slot = (
  role: AskDraftRecipient["role"],
  key: string,
  shape: "one" | "list" | "array",
  ...addresses: string[]
): Slot => ({ role, path: [key], shape, addresses });
const graphSlot = (role: AskDraftRecipient["role"], key: string, ...addresses: string[]): Slot => ({
  role,
  path: [key],
  shape: "objects",
  address: ["emailAddress", "address"],
  addresses,
});
const located = (key: string, value: string) => ({ path: [key], value });

type Send = {
  args: Record<string, unknown>;
  schema?: Record<string, unknown>;
  recipients: Slot[];
  body: string;
};

const sends = {
  "Gmail without its schema": {
    args: { recipient_email: "a@example.com", subject: "Hi", body: "Hello" },
    recipients: [slot("to", "recipient_email", "one", "a@example.com")],
    body: "body",
  },
  "Gmail with its schema": {
    args: { recipient_email: "a@example.com", subject: "Hi", body: "Hello" },
    schema: gmailSchema,
    recipients: [
      slot("to", "recipient_email", "one", "a@example.com"),
      slot("to", "extra_recipients", "array"),
      slot("cc", "cc", "array"),
      slot("bcc", "bcc", "array"),
    ],
    body: "body",
  },
  "Outlook with its schema": {
    args: { to: "a@example.com", subject: "Hi", body: "Hello", cc_emails: [] },
    schema: outlookSchema,
    recipients: [
      slot("to", "to", "one", "a@example.com"),
      slot("cc", "cc_emails", "array"),
      slot("bcc", "bcc_emails", "array"),
    ],
    body: "body",
  },
  "a comma-separated list": {
    args: { to: "a@example.com, b@example.com", subject: "Hi", body: "Hello" },
    recipients: [slot("to", "to", "list", "a@example.com", "b@example.com")],
    body: "body",
  },
  "Graph-style objects": {
    args: {
      toRecipients: [{ emailAddress: { address: "a@example.com" } }],
      subject: "Hi",
      content: "Hello",
    },
    schema: graphSchema,
    recipients: [graphSlot("to", "toRecipients", "a@example.com"), graphSlot("cc", "ccRecipients")],
    body: "content",
  },
} satisfies Record<string, Send>;

function drafted(send: Send): DraftBinding {
  const subject = send.args.subject;
  const binding = acceptDraftProposal(
    send.args,
    {
      card: "mail",
      recipients: send.recipients,
      ...(typeof subject === "string" ? { subject: located("subject", subject) } : {}),
      body: located(send.body, String(send.args[send.body])),
      unshown: [],
    },
    send.schema,
  );
  if (!binding) throw new Error("proposal refused");
  return binding;
}

function edit(send: Send, edits: AskDraftEdits) {
  const result = editDraftRequest(send.args, drafted(send), edits);
  return "error" in result ? result : (result.request as Record<string, unknown>);
}

const recipients = (...entries: Array<[AskDraftRecipient["role"], string]>) =>
  entries.map(([role, address]) => ({ role, address }));

describe("the lines a draft offers", () => {
  it.each([
    ["Gmail without its schema", { to: 1, subject: true }],
    ["Gmail with its schema", { to: null, cc: null, bcc: null, subject: true }],
    ["Outlook with its schema", { to: 1, cc: null, bcc: null, subject: true }],
    ["a comma-separated list", { to: null, subject: true }],
    ["Graph-style objects", { to: null, cc: null, subject: true }],
  ] as const)("%s", (name, fields) => {
    expect(askDraftFields(drafted(sends[name]).fields!)).toEqual(fields);
  });

  it("refuses a subject with a line break in an edit", () => {
    expect(edit(sends["Gmail with its schema"], { subject: "Hi\r\nBcc: x@example.com" })).toEqual({
      error: "A subject fits on one line.",
    });
  });
});

describe("editDraftRequest", () => {
  it("writes recipients and subject back in the shape each tool used", () => {
    const edits = {
      recipients: recipients(
        ["to", "x@example.com"],
        ["to", "y@example.com"],
        ["cc", "z@example.com"],
      ),
      subject: "New subject",
    };
    expect(edit(sends["Gmail with its schema"], edits)).toEqual({
      recipient_email: "x@example.com",
      extra_recipients: ["y@example.com"],
      cc: ["z@example.com"],
      subject: "New subject",
      body: "Hello",
    });
    expect(
      edit(sends["Outlook with its schema"], { ...edits, recipients: edits.recipients.slice(1) }),
    ).toEqual({
      to: "y@example.com",
      subject: "New subject",
      body: "Hello",
      cc_emails: ["z@example.com"],
    });
    expect(
      edit(sends["a comma-separated list"], { recipients: edits.recipients.slice(0, 2) }),
    ).toEqual({ to: "x@example.com, y@example.com", subject: "Hi", body: "Hello" });
    expect(edit(sends["Graph-style objects"], edits)).toEqual({
      toRecipients: [
        { emailAddress: { address: "x@example.com" } },
        { emailAddress: { address: "y@example.com" } },
      ],
      ccRecipients: [{ emailAddress: { address: "z@example.com" } }],
      subject: "New subject",
      content: "Hello",
    });
  });

  it("drops a copy line the user emptied, and keeps a list empty in its own shape", () => {
    const gmail = {
      args: { recipient_email: "a@example.com", cc: ["c@example.com"], body: "Hello" },
      recipients: [
        slot("to", "recipient_email", "one", "a@example.com"),
        slot("cc", "cc", "array", "c@example.com"),
      ],
      body: "body",
    };
    expect(edit(gmail, { recipients: recipients(["to", "a@example.com"]) })).toEqual({
      recipient_email: "a@example.com",
      cc: [],
      body: "Hello",
    });
    const single = {
      args: { to: "a@example.com", cc: "c@example.com", body: "Hello" },
      recipients: [
        slot("to", "to", "one", "a@example.com"),
        slot("cc", "cc", "one", "c@example.com"),
      ],
      body: "body",
    };
    expect(edit(single, { recipients: recipients(["to", "a@example.com"]) })).toEqual({
      to: "a@example.com",
      body: "Hello",
    });
  });

  it.each([
    [
      "an address that is not one",
      recipients(["to", "Marie <m@example.com>"]),
      "Marie <m@example.com> is not an email address.",
    ],
    ["an empty address", recipients(["to", ""]), "An empty address is not an email address."],
    ["no To", recipients(["cc", "c@example.com"]), "Add a To address."],
    [
      "a second To where the tool takes one",
      recipients(["to", "a@example.com"], ["to", "b@example.com"]),
      "This message takes one To address.",
    ],
    [
      "a Cc the tool has no place for",
      recipients(["to", "a@example.com"], ["cc", "c@example.com"]),
      "This message takes no Cc.",
    ],
  ])("refuses %s and writes nothing", (_, list, error) => {
    expect(edit(sends["Gmail without its schema"], { recipients: list })).toEqual({
      error,
    });
  });

  it("refuses more recipients than the card shows whole", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      role: "to" as const,
      address: `person${i}@example.com`,
    }));
    expect(edit(sends["Gmail with its schema"], { recipients: many })).toEqual({
      error: "Too many recipients.",
    });
  });

  it("refuses an empty text or a subject too long", () => {
    const send = sends["Gmail with its schema"];
    expect(edit(send, { text: " " })).toEqual({ error: "This message is empty." });
    expect(edit(send, { subject: "s".repeat(1_001) })).toEqual({
      error: "This subject is longer than 1000 characters.",
    });
  });

  it("lets a draft recorded before fields were editable change its text only", () => {
    const old = readDraft("intended", { path: ["body"], proposed: "Hello", state: "pending" });
    const request = { recipient_email: "a@example.com", subject: "Hi", body: "Hello" };
    expect(editDraftRequest(request, old!, { text: "Edited" })).toEqual({
      request: { ...request, body: "Edited" },
    });
    for (const edits of [{ recipients: recipients(["to", "b@example.com"]) }, { subject: "New" }]) {
      expect(editDraftRequest(request, old!, edits)).toEqual({
        error: "Only the message text can be edited on this draft.",
      });
    }
  });

  it("sends what the card shows: the edited call reads back as exactly the edited message", () => {
    const address = fc
      .tuple(fc.stringMatching(/^[a-z]{1,8}$/), fc.constantFrom("example.com", "example.org"))
      .map(([local, domain]) => `${local}@${domain}`);
    const shaped = Object.values(sends).filter(
      (send) => send !== sends["Gmail without its schema"],
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...shaped),
        fc.array(address, { minLength: 1, maxLength: 4 }),
        fc.array(address, { maxLength: 3 }),
        fc.string({ maxLength: 40 }).filter((subject) => subject.trim() === subject),
        (send, to, cc, subject) => {
          const binding = drafted(send);
          const fields = askDraftFields(binding.fields!);
          const list = [
            ...to
              .slice(0, fields.to ?? to.length)
              .map((each) => ({ role: "to" as const, address: each })),
            ...(fields.cc !== undefined ? cc : []).map((each) => ({
              role: "cc" as const,
              address: each,
            })),
          ];
          const result = editDraftRequest(send.args, binding, { recipients: list, subject });
          if ("error" in result) throw new Error(result.error);
          expect(draftMessage(result.request, binding)).toEqual({
            recipients: list,
            subject,
            body: "Hello",
          });
          expect(draftSentResult(undefined, result.request, binding).sent).toEqual({
            recipients: list,
            subject,
            body: "Hello",
          });
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("what the bot reads once its draft left", () => {
  it("names what left and what the user changed", () => {
    const send = sends["Gmail with its schema"];
    const binding = drafted(send);
    const result = editDraftRequest(send.args, binding, {
      recipients: recipients(["to", "a@example.com"], ["cc", "c@example.com"]),
      subject: "Hi",
      text: "Hello again",
    });
    if ("error" in result) throw new Error(result.error);
    expect(draftSentResult(undefined, result.request, binding)).toEqual({
      ok: true,
      sent: {
        recipients: recipients(["to", "a@example.com"], ["cc", "c@example.com"]),
        subject: "Hi",
        body: "Hello again",
      },
      editedByUser: ["recipients", "body"],
      note: "The user sent this message from the draft card, which shows them it was sent. Do not send it again, and do not tell them it was sent or will not be sent twice.",
    });
    expect(draftSentResult(undefined, send.args, binding).editedByUser).toEqual([]);
  });

  it("takes the subject from the card when the send recorded no subject line", () => {
    const send = {
      args: { thread_id: "t1", recipient_email: "a@example.com", message_body: "Hello" },
      recipients: [slot("to", "recipient_email", "one", "a@example.com")],
      body: "message_body",
    };
    const binding = acceptDraftProposal(send.args, {
      card: "mail",
      recipients: send.recipients,
      body: located("message_body", "Hello"),
      unshown: [["thread_id"]],
    })!;
    expect(binding.fields?.subject).toBe(undefined);
    expect(
      draftSentResult({ recipients: [], subject: "Re: Hi" }, send.args, binding).sent.subject,
    ).toBe("Re: Hi");
  });

  it("takes an older draft's recipients from its card", () => {
    const old = readDraft("approved", { path: ["body"], proposed: "Hello", state: "approved" })!;
    const card = { recipients: recipients(["to", "a@example.com"]), subject: "Hi" };
    expect(draftSentResult(card, { body: "Edited" }, old)).toMatchObject({
      sent: { recipients: card.recipients, subject: "Hi", body: "Edited" },
      editedByUser: ["body"],
    });
  });
});
