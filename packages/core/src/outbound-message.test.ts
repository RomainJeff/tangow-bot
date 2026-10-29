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
  return readOutboundCall({ toolName, args });
}

describe("readOutboundCall", () => {
  it("reads the traced send as a message", () => {
    expect(readOutboundCall(tracedSend)).toEqual({ kind: "message" });
  });

  it("reads every recipient by role, whatever the connector calls the field", () => {
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
    expect([gmail, outlook, fakeMcp].map((call) => call.kind)).toEqual([
      "message",
      "message",
      "message",
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
  ])("reads %s with %j as a message", (toolName, args) => {
    expect(read(toolName, args).kind).toBe("message");
  });

  it("reads one sender named twice, and the signed-in mailbox", () => {
    expect(
      read("OUTLOOK_SEND_EMAIL", {
        to: "a@example.com",
        body: "Hi",
        from_email: "me@example.com",
        from_address: "ME@example.com",
        user_id: "me",
      }).kind,
    ).toBe("message");
  });

  it("reads a reply that names its recipient and carries no subject", () => {
    expect(
      read("GMAIL_REPLY_TO_THREAD", {
        thread_id: "18c5f5d1a2b3c4d6",
        recipient_email: "a@example.com",
        message_body: "Thanks",
        cc: "",
      }).kind,
    ).toBe("message");
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
    ["HTML turned on", "GMAIL_SEND_EMAIL", { to: "a@example.com", body: "Hi", is_html: true }],
    [
      "the automatic signature turned on",
      "GMAIL_SEND_EMAIL",
      { to: "a@example.com", body: "Hi", include_signature: true },
    ],
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

  it("reads nested recipients that fit as a message", () => {
    expect(
      read("OUTLOOK_SEND_EMAIL", { payload: { toRecipients: nestedRecipients(3), body: "Hi" } })
        .kind,
    ).toBe("message");
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

  it("reads a send to many recipients that still fit the card as a message", () => {
    const bcc = Array.from({ length: 100 }, (_, i) => `p${i}@example.test`);
    expect(read("GMAIL_SEND_EMAIL", { to: "a@example.com", bcc, body: "Hi" }).kind).toBe("message");
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
});

describe("readOutboundCall on a chat app's send", () => {
  const chatApps = new Set(["slack"]);
  const chat = (toolName: string, args: Record<string, unknown>) =>
    readOutboundCall({ toolName, args }, [], chatApps);
  // Composio's Slack send as its docs give it (2026-10): a conversation id and Markdown text.
  const slackSend = { channel: "D0MARIE", markdown_text: "Thursday instead?" };

  it("reads a send to one conversation as a message", () => {
    expect(
      chat("SLACK_SEND_MESSAGE", { ...slackSend, thread_ts: "1.2", unfurl_links: true }),
    ).toEqual({ kind: "message" });
    expect(chat("SLACK_CHAT_POST_MESSAGE", { channel_id: "C0GENERAL", text: "Hi" })).toEqual({
      kind: "message",
    });
    // Slack's own server's send, a user id standing for a direct message.
    const args = {
      channel_id: "U0MARIE",
      message: "Thursday instead?",
      thread_ts: "1.2",
      reply_broadcast: false,
      unfurl_app_links: true,
    };
    expect(chat("slack_send_message", args)).toEqual({ kind: "message" });
    // A Slack draft of its own, deleted once sent, is not something the card shows.
    expect(chat("slack_send_message", { ...args, draft_id: "Dr0" })).toEqual({ kind: "classic" });
  });

  it.each([
    ["Block Kit content the card does not show", { blocks: [{ type: "section" }] }],
    ["a second text", { text: "Something else" }],
    ["a second conversation", { channel_id: "C0GENERAL" }],
    ["a name the message would go out under", { username: "Ceo" }],
    ["a mail recipient", { to: "a@example.com" }],
    ["a conversation inside another argument", { options: { channel: "C0GENERAL" } }],
  ])("gives a send with %s the classic card", (_, extra) => {
    expect(chat("SLACK_SEND_MESSAGE", { ...slackSend, ...extra })).toEqual({ kind: "classic" });
  });

  it("gives a send it cannot find the conversation of the classic card, never no card", () => {
    expect(chat("SLACK_SEND_MESSAGE", { markdown_text: "Hi" })).toEqual({ kind: "classic" });
  });

  it("refuses an empty message back to the bot", () => {
    expect(chat("SLACK_SEND_MESSAGE", { channel: "C0GENERAL", markdown_text: " " })).toEqual({
      kind: "refuse",
      error: "This message is empty.",
    });
  });

  it("leaves a chat app without a recipient reader, and Slack's reads, as they were", () => {
    expect(readOutboundCall({ toolName: "SLACK_SEND_MESSAGE", args: slackSend })).toEqual({
      kind: "none",
    });
    expect(chat("TEAMS_SEND_MESSAGE", slackSend)).toEqual({ kind: "none" });
    expect(chat("SLACK_FETCH_CONVERSATION_HISTORY", { channel: "C0GENERAL" })).toEqual({
      kind: "none",
    });
  });

  it("keeps reading a mail as a mail", () => {
    expect(readOutboundCall(tracedSend, [], chatApps).kind).toBe("message");
    expect(read("GMAIL_SEND_EMAIL", { ...tracedSend.args, channel: "C0GENERAL" })).toEqual({
      kind: "classic",
    });
  });

  it("never leaves a chat app's send without a card", () => {
    const keys = fc.constantFrom(
      "channel",
      "channel_id",
      "markdown_text",
      "text",
      "thread_ts",
      "unfurl_links",
      "blocks",
      "username",
      "notes",
    );
    const value = fc.oneof(
      fc.constantFrom("C0GENERAL", "Hello", "", true, false, null),
      fc.string(),
      fc.array(fc.string(), { maxLength: 2 }),
      fc.dictionary(keys, fc.string(), { maxKeys: 2 }),
    );
    fc.assert(
      fc.property(fc.dictionary(keys, value, { maxKeys: 4 }), (extra) => {
        const result = chat("SLACK_SEND_MESSAGE", { ...slackSend, ...extra });
        // Whatever it holds, a Slack send shows a card: never none, which would send it unseen.
        expect(result.kind).not.toBe("none");
      }),
      { numRuns: 500 },
    );
  });
});
