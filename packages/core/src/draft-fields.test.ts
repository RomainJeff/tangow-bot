import type { AskDraftEdits, AskDraftRecipient } from "@rakazo/contracts";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { askDraftFields } from "./draft-fields.js";
import type { DraftBinding } from "./outbound-draft.js";
import { draftSentResult, editDraftRequest, readDraft } from "./outbound-draft.js";
import type { OutboundAction } from "./outbound-message.js";
import { readOutboundCall } from "./outbound-message.js";

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

const sends = {
  "Gmail through a batch, no schema": {
    toolName: "GMAIL_SEND_EMAIL",
    args: { recipient_email: "a@example.com", subject: "Hi", body: "Hello" },
  },
  "Gmail called directly": {
    toolName: "GMAIL_SEND_EMAIL",
    args: { recipient_email: "a@example.com", subject: "Hi", body: "Hello" },
    schema: gmailSchema,
  },
  "Outlook called directly": {
    toolName: "OUTLOOK_SEND_EMAIL",
    args: { to: "a@example.com", subject: "Hi", body: "Hello", cc_emails: [] },
    schema: outlookSchema,
  },
  "a comma-separated list": {
    toolName: "mcp__acme__sendEmail",
    args: { to: "a@example.com, b@example.com", subject: "Hi", body: "Hello" },
  },
  "Graph-style objects": {
    toolName: "mcp__acme-mail__sendMessage",
    args: {
      toRecipients: [{ emailAddress: { address: "a@example.com" } }],
      subject: "Hi",
      content: "Hello",
    },
    schema: graphSchema,
  },
} satisfies Record<string, OutboundAction>;

/** The draft a send makes and the record the server keeps of it, as at creation. */
function drafted(action: OutboundAction) {
  const read = readOutboundCall([action]);
  if (read.kind !== "draft") throw new Error(`not a draft: ${read.kind}`);
  const { draft } = read;
  const binding: DraftBinding = {
    path: draft.textPath,
    proposed: draft.body,
    ...(draft.fields
      ? {
          fields: {
            ...draft.fields,
            proposed: { recipients: draft.recipients, subject: draft.subject },
          },
        }
      : {}),
  };
  return { draft, binding };
}

function edit(action: OutboundAction, edits: AskDraftEdits) {
  const { binding } = drafted(action);
  const result = editDraftRequest(action.args, binding, edits);
  return "error" in result ? result : (result.request as Record<string, unknown>);
}

const recipients = (...entries: Array<[AskDraftRecipient["role"], string]>) =>
  entries.map(([role, address]) => ({ role, address }));

describe("the lines a draft offers", () => {
  it.each([
    ["Gmail through a batch, no schema", { to: 1, subject: true }],
    ["Gmail called directly", { to: null, cc: null, bcc: null, subject: true }],
    ["Outlook called directly", { to: 1, cc: null, bcc: null, subject: true }],
    ["a comma-separated list", { to: null, subject: true }],
    ["Graph-style objects", { to: null, cc: null, subject: true }],
  ] as const)("%s", (name, fields) => {
    const { draft } = drafted(sends[name]);
    expect(draft.fields && askDraftFields(draft.fields)).toEqual(fields);
  });

  it("offers no subject a send does not carry, even when its schema has one", () => {
    const { draft } = drafted({
      toolName: "GMAIL_SEND_EMAIL",
      args: { recipient_email: "a@example.com", body: "Hello" },
      schema: gmailSchema,
    });
    expect(draft.fields && askDraftFields(draft.fields).subject).toBe(undefined);
  });

  it("never offers a second single-address alias beside the one the call used", () => {
    const { draft } = drafted({
      toolName: "GMAIL_SEND_EMAIL",
      args: { recipient_email: "a@example.com", body: "Hello" },
      schema: {
        type: "object",
        properties: { recipient_email: { type: "string" }, to: { type: "string" } },
      },
    });
    expect(draft.fields && askDraftFields(draft.fields)).toEqual({ to: 1 });
  });

  it("lets only the text change when a recipient argument cannot be written back", () => {
    const { draft } = drafted({
      toolName: "mcp__acme__sendEmail",
      args: {
        to: [{ emailAddress: { address: "a@example.com" } }, { address: "b@example.com" }],
        body: "Hello",
      },
    });
    expect(draft.fields).toBe(undefined);
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
    expect(edit(sends["Gmail called directly"], edits)).toEqual({
      recipient_email: "x@example.com",
      extra_recipients: ["y@example.com"],
      cc: ["z@example.com"],
      subject: "New subject",
      body: "Hello",
    });
    expect(
      edit(sends["Outlook called directly"], { ...edits, recipients: edits.recipients.slice(1) }),
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
      toolName: "GMAIL_SEND_EMAIL",
      args: { recipient_email: "a@example.com", cc: ["c@example.com"], body: "Hello" },
      schema: gmailSchema,
    };
    expect(edit(gmail, { recipients: recipients(["to", "a@example.com"]) })).toEqual({
      recipient_email: "a@example.com",
      cc: [],
      body: "Hello",
    });
    const single = {
      toolName: "OUTLOOK_SEND_EMAIL",
      args: { to: "a@example.com", cc: "c@example.com", body: "Hello" },
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
    expect(edit(sends["Gmail through a batch, no schema"], { recipients: list })).toEqual({
      error,
    });
  });

  it("refuses more recipients than the card shows whole", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      role: "to" as const,
      address: `person${i}@example.com`,
    }));
    expect(edit(sends["Gmail called directly"], { recipients: many })).toEqual({
      error: "Too many recipients.",
    });
  });

  it("refuses an empty text or a subject too long", () => {
    const send = sends["Gmail called directly"];
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
      (send) => send !== sends["Gmail through a batch, no schema"],
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...shaped),
        fc.array(address, { minLength: 1, maxLength: 4 }),
        fc.array(address, { maxLength: 3 }),
        fc.string({ maxLength: 40 }).filter((subject) => subject.trim() === subject),
        (send, to, cc, subject) => {
          const { draft, binding } = drafted(send);
          const fields = askDraftFields(draft.fields!);
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
          const reread = readOutboundCall([
            { ...send, args: result.request as Record<string, unknown> },
          ]);
          if (reread.kind !== "draft") throw new Error(`edited send reads as ${reread.kind}`);
          expect(reread.draft.recipients).toEqual(list);
          expect(reread.draft.subject ?? "").toBe(subject.trim() ? subject : "");
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
    const send = sends["Gmail called directly"];
    const { binding } = drafted(send);
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
      note: "The user sent this message from the draft card. Do not send it again.",
    });
    expect(draftSentResult(undefined, send.args, binding).editedByUser).toEqual([]);
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
