import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { OutboundCall } from "./outbound-message.js";
import { readOutboundCall } from "./outbound-message.js";

// The send a bot made through Composio's batch tool (trace 2026-10-23), addresses replaced.
const tracedSend = {
  toolName: "GMAIL_SEND_EMAIL",
  args: {
    recipient_email: "someone@example.com",
    subject: "Test Chief",
    body: "Hello from Chief.",
    is_html: false,
    include_signature: false,
  },
};

function read(toolName: string, args: Record<string, unknown>): OutboundCall {
  return readOutboundCall([{ toolName, args }]);
}

describe("readOutboundCall", () => {
  it("drafts the traced send with every field it carries", () => {
    expect(readOutboundCall([tracedSend])).toEqual({
      kind: "draft",
      draft: {
        connectorKind: "gmail",
        recipients: [{ role: "to", address: "someone@example.com" }],
        subject: "Test Chief",
        body: "Hello from Chief.",
        account: undefined,
        args: tracedSend.args,
        textPath: ["body"],
        // No schema reaches through the batch, so only the one To and the subject can change.
        fields: {
          recipients: [{ role: "to", path: ["recipient_email"], shape: "one" }],
          subject: ["subject"],
        },
      },
    });
  });

  it("shows every recipient by role, whatever the connector calls the field", () => {
    const gmail = read("GMAIL_SEND_EMAIL", {
      recipient_email: "a@example.com",
      extra_recipients: ["b@example.com"],
      cc: ["c@example.com"],
      bcc: ["d@example.com"],
      subject: "Hi",
      body: "Hello",
      from_email: "me@example.com",
      user_id: "me",
      attachment: null,
    });
    const outlook = read("OUTLOOK_SEND_EMAIL", {
      to: "a@example.com",
      cc_emails: ["c@example.com"],
      bcc_emails: ["d@example.com"],
      subject: "Hi",
      body: "Hello",
      from_address: "me@example.com",
      save_to_sent_items: true,
    });
    const fakeMcp = read("mcp__acme-mail__sendMessage", {
      toRecipients: [{ emailAddress: { address: "a@example.com" } }],
      ccRecipients: [{ emailAddress: { address: "c@example.com" } }],
      bccRecipients: [],
      subject: "Hi",
      content: "Hello",
    });
    expect([gmail, outlook, fakeMcp].map(summary)).toEqual([
      "draft to:a@example.com to:b@example.com cc:c@example.com bcc:d@example.com | Hi | Hello | me@example.com",
      "draft to:a@example.com cc:c@example.com bcc:d@example.com | Hi | Hello | me@example.com",
      "draft to:a@example.com cc:c@example.com | Hi | Hello | -",
    ]);
  });

  it.each([
    ["send_message", { to_address: "a@example.com", body: "Hi" }],
    ["send_message", { toAddress: "a@example.com", body: "Hi" }],
    ["send_message", { to_addresses: ["a@example.com"], body: "Hi" }],
    ["send_message", { recipient_address: "a@example.com", body: "Hi" }],
    ["send_message", { send_to: "a@example.com", body: "Hi" }],
    ["send_message", { email_address: "a@example.com", body: "Hi" }],
    ["SENDMAIL", { to: "a@example.com", body: "Hi" }],
    ["mcp__acme__sendEmail", { to: "a@example.com", body: "Hi" }],
  ])("drafts %s with %j", (toolName, args) => {
    expect(summary(read(toolName, args))).toBe("draft to:a@example.com | - | Hi | -");
  });

  it("shows one sender named twice, and the signed-in mailbox", () => {
    expect(
      summary(
        read("OUTLOOK_SEND_EMAIL", {
          to: "a@example.com",
          body: "Hi",
          from_email: "me@example.com",
          from_address: "ME@example.com",
          user_id: "me",
        }),
      ),
    ).toBe("draft to:a@example.com | - | Hi | me@example.com");
  });

  it("drafts a reply that names its recipient and shows no subject", () => {
    expect(
      summary(
        read("GMAIL_REPLY_TO_THREAD", {
          thread_id: "18c5f5d1a2b3c4d6",
          recipient_email: "a@example.com",
          message_body: "Thanks",
          cc: "",
        }),
      ),
    ).toBe("draft to:a@example.com | - | Thanks | -");
  });

  it("turns HTML and the automatic signature off in what is sent", () => {
    const result = read("GMAIL_SEND_EMAIL", {
      recipient_email: "a@example.com",
      body: "Hello",
      is_html: true,
      include_signature: true,
    });
    expect(result.kind === "draft" && result.draft.args).toEqual({
      recipient_email: "a@example.com",
      body: "Hello",
      is_html: false,
      include_signature: false,
    });
  });

  it.each([
    [
      "a forward",
      "GMAIL_FORWARD_MESSAGE",
      { message_id: "m1", recipients: ["a@example.com"], additional_text: "FYI" },
    ],
    ["a stored draft", "GMAIL_SEND_DRAFT", { draft_id: "r1" }],
    ["an Outlook stored draft", "OUTLOOK_SEND_DRAFT", { message_id: "m1" }],
    ["a reply with no recipient", "GMAIL_REPLY_TO_THREAD", { thread_id: "t1", message_body: "Ok" }],
    [
      "a reply whose only visible recipient is a copy",
      "OUTLOOK_REPLY_EMAIL",
      { message_id: "m1", body: "Ok", cc_emails: ["c@example.com"] },
    ],
    [
      "an attachment",
      "GMAIL_SEND_EMAIL",
      { to: "a@example.com", body: "Hi", attachment: { name: "a.pdf", s3key: "k" } },
    ],
    ["a display-name address", "GMAIL_SEND_EMAIL", { to: "Marie <m@example.com>", body: "Hi" }],
    [
      "a display name beside the address",
      "OUTLOOK_SEND_EMAIL",
      { to: "m@example.com", to_name: "Marie", body: "Hi" },
    ],
    [
      "a named recipient object",
      "send_message",
      { to: [{ address: "m@example.com", name: "Marie" }], content: "Hi" },
    ],
    [
      "an address under an unknown key",
      "GMAIL_SEND_EMAIL",
      { to: "a@example.com", body: "Hi", notes: "evil@example.com" },
    ],
    [
      "a second body",
      "GMAIL_SEND_EMAIL",
      { to: "a@example.com", body: "Hi", html_body: "<p>Other</p>" },
    ],
    ["two text fields", "GMAIL_SEND_EMAIL", { to: "a@example.com", body: "Hi", message: "Other" }],
    [
      "a non-boolean HTML flag",
      "GMAIL_SEND_EMAIL",
      { to: "a@example.com", body: "Hi", is_html: "yes" },
    ],
    [
      "a signature written out",
      "GMAIL_SEND_EMAIL",
      { to: "a@example.com", body: "Hi", signature: "Sent by a bot" },
    ],
    ["no text", "GMAIL_SEND_EMAIL", { to: "a@example.com", subject: "Hi" }],
    [
      "a reply to everyone the card does not show",
      "OUTLOOK_REPLY_EMAIL",
      { message_id: "m1", to: "a@example.com", body: "Ok", reply_all: true },
    ],
    [
      "a reply-all switched off",
      "OUTLOOK_REPLY_EMAIL",
      { message_id: "m1", to: "a@example.com", body: "Ok", replyAll: false },
    ],
    [
      "attachment ids",
      "OUTLOOK_SEND_EMAIL",
      { to: "a@example.com", body: "Hi", attachment_ids: [1, 2] },
    ],
    [
      "a numeric attachment id",
      "OUTLOOK_SEND_EMAIL",
      { to: "a@example.com", body: "Hi", attachment_id: 42 },
    ],
    [
      "a number under a recipient field",
      "GMAIL_SEND_EMAIL",
      { to: "a@example.com", cc: 5, body: "Hi" },
    ],
    [
      "a sender with a display name",
      "OUTLOOK_SEND_EMAIL",
      { to: "a@example.com", body: "Hi", from_email: "Boss <boss@corp.example>" },
    ],
    [
      "two different senders",
      "OUTLOOK_SEND_EMAIL",
      {
        to: "a@example.com",
        body: "Hi",
        from_email: "a@corp.example",
        from_address: "b@corp.example",
      },
    ],
    [
      "another user's mailbox",
      "GMAIL_SEND_EMAIL",
      { to: "a@example.com", body: "Hi", user_id: "someone-else" },
    ],
    [
      "a recipient hidden under a message id",
      "GMAIL_REPLY_TO_THREAD",
      { thread_id: { to: "evil@x.example" }, recipient_email: "a@example.com", message_body: "Hi" },
    ],
    [
      "an inert field hidden inside the body",
      "GMAIL_SEND_EMAIL",
      { to: "a@example.com", body: { text: "hi", thought: "SECRET" } },
    ],
    [
      "a subject given as a list",
      "GMAIL_SEND_EMAIL",
      { to: "a@example.com", body: "Hi", subject: ["Hello"] },
    ],
    [
      "a recipient that is not an address on a mail connector",
      "outlook_send",
      { to: "Marie", body: "Hi" },
    ],
  ])("gives %s the classic card", (_, toolName, args) => {
    expect(read(toolName, args)).toEqual({ kind: "classic" });
  });

  it.each([
    ["a text message", "TWILIO_SEND_SMS", { to: "+15555550100", body: "Hi" }],
    [
      "a text message with a to_address field",
      "send_sms",
      { to_address: "+15555550100", body: "Hi" },
    ],
    [
      "an e-signature request",
      "DOCUSIGN_SEND_ENVELOPE",
      { signers: [{ email: "a@example.com", name: "A" }], subject: "Please sign" },
    ],
    ["a chat message", "SLACK_SEND_MESSAGE", { channel: "C0123", text: "Hi" }],
    ["a mail read", "GMAIL_FETCH_EMAILS", { query: "from:a@example.com" }],
    ["a saved draft", "GMAIL_CREATE_EMAIL_DRAFT", { recipient_email: "a@example.com", body: "Hi" }],
  ])("leaves %s to the usual gate", (_, toolName, args) => {
    expect(read(toolName, args)).toEqual({ kind: "none" });
  });

  it.each([
    ["one huge recipient field", { to: "x".repeat(200_000), body: "Hi" }],
    [
      "a long recipient list",
      {
        to: "a@example.com",
        bcc: Array.from({ length: 300 }, (_, i) => `p${i}@example.test`),
        body: "Hi",
      },
    ],
    [
      "a long recipient list beside a field the card cannot explain",
      { to: "a@example.com", cc: ["c@example.test".repeat(300)], body: "Hi", notes: "n" },
    ],
  ])("refuses %s rather than show it cut", (_, args) => {
    expect(read("GMAIL_SEND_EMAIL", args)).toEqual({
      kind: "refuse",
      error: "Too many recipients to show the user. Send to fewer people at a time.",
    });
  });

  const nearAddress = `a@${"b.".repeat(100_000)};`;

  const nestedRecipients = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ emailAddress: { address: `p${i}@example.test` } }));

  it("refuses nested recipients too many to show, wherever they sit", () => {
    expect(
      read("OUTLOOK_SEND_EMAIL", {
        message: { toRecipients: nestedRecipients(2_000), body: "Hi" },
      }),
    ).toEqual({
      kind: "refuse",
      error: "Too many recipients to show the user. Send to fewer people at a time.",
    });
  });

  it("drafts nested recipients that fit, and sends the card the whole list", () => {
    const result = read("OUTLOOK_SEND_EMAIL", {
      payload: { toRecipients: nestedRecipients(3), body: "Hi" },
    });
    expect(result.kind === "draft" && result.draft.recipients.length).toBe(3);
  });

  it("refuses a send the classic card would cut recipients from", () => {
    expect(
      read("OUTLOOK_SEND_EMAIL", {
        payload: { toRecipients: nestedRecipients(3), body: "Hi" },
        notes: "n",
      }),
    ).toEqual({
      kind: "refuse",
      error: "Put the recipients in the to, cc and bcc arguments.",
    });
  });

  it("gives a subject too long to show the classic card", () => {
    expect(
      read("GMAIL_SEND_EMAIL", { to: "a@example.com", body: "Hi", subject: "s".repeat(200_000) }),
    ).toEqual({ kind: "classic" });
  });

  it.each([
    ["a sender", "GMAIL_SEND_EMAIL", { to: "a@example.com", body: "Hi", from_email: nearAddress }],
    ["a recipient", "GMAIL_SEND_EMAIL", { to: nearAddress, body: "Hi" }],
    ["a recipient list", "GMAIL_SEND_EMAIL", { to: "a@example.com,".repeat(20_000), body: "Hi" }],
    [
      "an unexplained field",
      "GMAIL_SEND_EMAIL",
      { to: "a@example.com", body: "Hi", notes: "@".repeat(200_000) },
    ],
  ])("reads %s of 200,000 characters in linear time", (_, toolName, args) => {
    const start = performance.now();
    read(toolName, args);
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it("does not let a long recipient list read as no send on a tool not named for mail", () => {
    expect(read("send_message", { to: "a@example.com,".repeat(20_000), body: "Hi" }).kind).toBe(
      "refuse",
    );
    expect(read("send_message", { to: `${"x".repeat(400)}@example.com`, body: "Hi" })).toEqual({
      kind: "classic",
    });
  });

  const note = (index: number) => [`note${index}`, "n".repeat(490)];

  it("refuses a send it cannot read when its fields are too many to show", () => {
    expect(
      read("GMAIL_SEND_EMAIL", {
        to: "a@example.com",
        body: "Hi",
        ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => note(index))),
        is_html: true,
        attachment: { name: "a.pdf" },
      }),
    ).toEqual({
      kind: "refuse",
      error: "Too many arguments to show the user. Send with fewer fields at a time.",
    });
  });

  it("gives a send it cannot read the classic card while its fields fit", () => {
    expect(
      read("GMAIL_SEND_EMAIL", {
        to: "a@example.com",
        body: "Hi",
        ...Object.fromEntries(Array.from({ length: 3 }, (_, index) => note(index))),
        attachment: { name: "a.pdf" },
      }),
    ).toEqual({ kind: "classic" });
  });

  const nestedDeep = (depth: number) =>
    Array.from({ length: depth }).reduce<Record<string, unknown>>((inner) => ({ a: inner }), {});

  it("refuses a mail whose arguments nest too deep to read, and leaves other sends alone", () => {
    const deep = { payload: nestedDeep(5_000) };
    expect(read("GMAIL_SEND_EMAIL", { to: "a@example.com", body: "Hi", ...deep })).toEqual({
      kind: "refuse",
      error: "Send this message with simpler arguments.",
    });
    expect(read("TWILIO_SEND_SMS", { to: "+15555550100", body: "Hi", ...deep })).toEqual({
      kind: "none",
    });
  });

  it("drafts a send to many recipients that still fit the card", () => {
    const bcc = Array.from({ length: 100 }, (_, i) => `p${i}@example.test`);
    expect(read("GMAIL_SEND_EMAIL", { to: "a@example.com", bcc, body: "Hi" }).kind).toBe("draft");
  });

  it.each([
    ["an empty body", { body: "  \n" }, "This message is empty."],
    [
      "a body too long to send",
      { body: "x".repeat(20_001) },
      "This message is longer than 20000 characters.",
    ],
  ])("refuses %s back to the bot", (_, body, error) => {
    expect(read("GMAIL_SEND_EMAIL", { to: "a@example.com", ...body })).toEqual({
      kind: "refuse",
      error,
    });
  });

  it("finds a body nested where the connector puts it", () => {
    const result = read("mcp__acme-mail__sendMessage", {
      toRecipients: [{ emailAddress: { address: "a@example.com" } }],
      email: { body: "Hello" },
    });
    expect(result.kind === "draft" && result.draft.textPath).toEqual(["email", "body"]);
  });

  it("refuses a batch that sends among other actions, and leaves a batch of reads alone", () => {
    const fetch = { toolName: "GMAIL_FETCH_EMAILS", args: {} };
    expect(readOutboundCall([fetch, tracedSend])).toEqual({
      kind: "refuse",
      error: "Send this message on its own.",
    });
    expect(readOutboundCall([fetch, fetch])).toEqual({ kind: "none" });
  });

  it("never drafts a mail with text the card does not show", () => {
    const keys = fc.constantFrom(
      "to",
      "cc",
      "bcc",
      "recipient_email",
      "toRecipients",
      "emailAddress",
      "address",
      "message",
      "body",
      "subject",
      "is_html",
      "thread_id",
      "notes",
      "html_body",
      "payload",
    );
    const value = fc.letrec((tie) => ({
      leaf: fc.oneof(
        fc.constantFrom("a@example.com", "Marie <m@example.com>", "Hello", "", true, false, null),
        fc.string(),
        fc.integer(),
      ),
      node: fc.oneof(
        { depthSize: "small" },
        tie("leaf"),
        fc.array(tie("leaf"), { maxLength: 3 }),
        fc.dictionary(keys, tie("node"), { maxKeys: 3 }),
      ),
    }));
    fc.assert(
      fc.property(fc.dictionary(keys, value.node, { maxKeys: 4 }), (extra) => {
        const args = { recipient_email: "a@example.com", body: "Hello", ...extra };
        const result = read("GMAIL_SEND_EMAIL", args);
        if (result.kind !== "draft") return;
        const shown = [
          result.draft.body,
          result.draft.subject,
          ...result.draft.recipients.map((recipient) => recipient.address),
        ];
        for (const path of flagPaths(args)) {
          expect(path.some((key) => /^(is_html|thread_id)$/.test(key))).toBe(true);
        }
        for (const [path, leaf] of stringLeaves(args)) {
          if (!leaf.trim() || path.includes("thread_id")) continue;
          const parts = path.some((key) => /to|cc|recipient/.test(key))
            ? leaf.split(",").map((part) => part.trim())
            : [leaf];
          for (const part of parts) expect(shown).toContain(part);
        }
      }),
      { numRuns: 500 },
    );
  });
});

function summary(result: OutboundCall): string {
  if (result.kind !== "draft") return result.kind;
  const { recipients, subject, body, account } = result.draft;
  const to = recipients.map((recipient) => `${recipient.role}:${recipient.address}`).join(" ");
  return `draft ${to} | ${subject ?? "-"} | ${body} | ${account ?? "-"}`;
}

function stringLeaves(value: unknown, path: string[] = []): Array<[string[], string]> {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item) => stringLeaves(item, path));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => stringLeaves(child, [...path, key]));
  }
  return [];
}

function flagPaths(value: unknown, path: string[] = []): string[][] {
  if (typeof value === "boolean" || typeof value === "number") return [path];
  if (Array.isArray(value)) return value.flatMap((item) => flagPaths(item, path));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => flagPaths(child, [...path, key]));
  }
  return [];
}
