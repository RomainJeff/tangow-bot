import { describe, expect, it } from "vitest";
import { outboundDraftIdentity, readOutboundCall } from "./outbound-message.js";

const identityOf = (toolName: string, args: Record<string, unknown>) => {
  const call = readOutboundCall({ toolName, args });
  if (call.kind !== "draft") throw new Error(`${toolName} did not read as a draft`);
  return outboundDraftIdentity(call.draft);
};

const mail = {
  recipient_email: "Anna@Example.com",
  cc: ["bo@example.com"],
  subject: "Hello",
  body: "Hi Anna.",
};

describe("outboundDraftIdentity", () => {
  it("names the mail a draft would send by its app, recipients, subject and text", () => {
    expect(identityOf("GMAIL_SEND_EMAIL", mail)).toEqual({
      app: "gmail",
      recipients: ["cc bo@example.com", "to anna@example.com"],
      subject: "Hello",
      body: "Hi Anna.",
    });
  });

  it("is the same for a mail issued again with other notes or flags", () => {
    const first = identityOf("GMAIL_SEND_EMAIL", mail);
    expect(
      identityOf("GMAIL_SEND_EMAIL", {
        ...mail,
        thought: "Retrying the mail.",
        is_html: false,
        include_signature: false,
      }),
    ).toEqual(first);
  });

  it.each([
    ["Gmail thread", "GMAIL_REPLY_TO_THREAD", { thread_id: "t-1" }, { thread_id: "t-2" }],
    ["message", "GMAIL_SEND_EMAIL", { message_id: "m-1" }, { message_id: "m-2" }],
    [
      "Slack thread",
      "SLACK_SEND_MESSAGE",
      { channel: "C0OPS", markdown_text: "Done", thread_ts: "1.1" },
      { channel: "C0OPS", markdown_text: "Done", thread_ts: "2.2" },
    ],
    [
      "Slack broadcast",
      "SLACK_SEND_MESSAGE",
      { channel: "C0OPS", markdown_text: "Done", thread_ts: "1.1", reply_broadcast: false },
      { channel: "C0OPS", markdown_text: "Done", thread_ts: "1.1", reply_broadcast: true },
    ],
  ])("tells the same text in another %s apart", (_, tool, first, second) => {
    const base = tool === "GMAIL_SEND_EMAIL" || tool === "GMAIL_REPLY_TO_THREAD" ? mail : {};
    const read = (extra: Record<string, unknown>) => {
      const call = readOutboundCall(
        { toolName: tool, args: { ...base, ...extra } },
        [],
        new Set(["slack"]),
      );
      if (call.kind === "none" || call.kind === "refuse") throw new Error(`${tool}: ${call.kind}`);
      if (call.kind === "classic") throw new Error(`${tool}: classic`);
      return outboundDraftIdentity(call.draft);
    };
    expect(read(first)).not.toEqual(read(second));
  });

  it("is the same whatever order and case the recipients come in", () => {
    expect(
      identityOf("GMAIL_SEND_EMAIL", {
        ...mail,
        recipient_email: "anna@example.com",
        extra_recipients: ["BO@example.com"],
        cc: undefined,
      }),
    ).toMatchObject({ recipients: ["to anna@example.com", "to bo@example.com"] });
  });

  it.each([
    ["the text", { body: "Hi Anna, again." }],
    ["the subject", { subject: "Hello again" }],
    ["a recipient", { recipient_email: "eve@example.com" }],
    ["a recipient's role", { cc: undefined, bcc: ["bo@example.com"] }],
  ])("tells a mail from one with another %s", (_, change) => {
    expect(identityOf("GMAIL_SEND_EMAIL", { ...mail, ...change })).not.toEqual(
      identityOf("GMAIL_SEND_EMAIL", mail),
    );
  });

  it("tells the same message in another app apart", () => {
    const outlook = identityOf("OUTLOOK_SEND_EMAIL", {
      to: "Anna@Example.com",
      subject: "Hello",
      body: "Hi Anna.",
    });
    expect(outlook).toMatchObject({ app: "outlook" });
    expect(outlook).not.toEqual(
      identityOf("GMAIL_SEND_EMAIL", {
        recipient_email: "Anna@Example.com",
        subject: "Hello",
        body: "Hi Anna.",
      }),
    );
  });
});
