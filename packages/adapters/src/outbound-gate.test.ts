import type { DraftBinding } from "@rakazo/core";
import { draftMessage } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  boundDirectApprovalRequest,
  catalogApprovalRequest,
  DIRECT_APPROVAL_TAG,
} from "./approval-effect.js";
import { draftRequest, outboundAskDraft, readSendResult } from "./outbound-gate.js";

const send = {
  recipient_email: "someone@example.com",
  subject: "Test Chief",
  body: "Hello from Chief.",
  is_html: false,
  include_signature: false,
};

describe("draftRequest", () => {
  const marker = "__marker";
  const route = { connectorId: "composio", resourceId: "gmail", toolName: "GMAIL_SEND_EMAIL" };
  const draft: DraftBinding = {
    path: ["body"],
    proposed: send.body,
    fields: {
      recipients: [{ role: "to", path: ["recipient_email"], shape: "one" }],
      subject: ["subject"],
      proposed: { recipients: [{ role: "to", address: "someone@example.com" }] },
    },
  };
  it.each([
    ["direct", send, ["body"]],
    [
      "catalog",
      catalogApprovalRequest(
        "composio_execute_tool",
        { id: "gmail:GMAIL_SEND_EMAIL", arguments: send },
        marker,
        route,
      ),
      [2, "arguments", "body"],
    ],
    ["bound direct", boundDirectApprovalRequest(route, send, marker), [2, "args", "body"]],
  ])("binds editable fields in a %s call", (_, request, path) => {
    const stored = draftRequest(request, marker, draft);
    const at = path.slice(0, -1);
    expect(stored).toEqual({
      path,
      proposed: "Hello from Chief.",
      fields: {
        recipients: [{ role: "to", path: [...at, "recipient_email"], shape: "one" }],
        subject: [...at, "subject"],
        proposed: { recipients: [{ role: "to", address: "someone@example.com" }] },
      },
    });
    expect(stored && draftMessage(request, stored)).toEqual({
      recipients: [{ role: "to", address: "someone@example.com" }],
      subject: "Test Chief",
      body: "Hello from Chief.",
    });
  });

  it("has no place for a draft in a request that is not an object", () => {
    expect(draftRequest([marker, DIRECT_APPROVAL_TAG, {}], marker, draft)).toBeUndefined();
  });
});

describe("readSendResult", () => {
  it.each([
    ["a sent mail", { successful: true, data: { id: "m1", labelIds: ["SENT"] } }, "sent"],
    ["a connector error, which a timeout also gives", { error: "Request timed out" }, "uncertain"],
    [
      "a connector error the app reported",
      {
        error: "Invalid recipient",
        kind: "unknown",
        details: { successful: false, error: "Invalid recipient" },
      },
      "Invalid recipient",
    ],
    [
      "a failed action in an MCP text result",
      {
        content: [{ type: "text", text: JSON.stringify({ successful: false, error: "Quota" }) }],
        isError: false,
      },
      "Quota",
    ],
    [
      "an MCP error, which a server also gives for what failed after the send",
      {
        error: "Connector tool reported an error. See details.",
        kind: "unknown",
        details: { content: [{ type: "text", text: "Token expired" }], isError: true },
      },
      "uncertain",
    ],
    [
      "an app refusal inside an MCP error",
      {
        error: "Connector tool reported an error. See details.",
        kind: "unknown",
        details: {
          content: [{ type: "text", text: JSON.stringify({ successful: false, error: "Quota" }) }],
          isError: true,
        },
      },
      "Quota",
    ],
    [
      "a send that left, whose response has details of its own",
      { successful: true, data: { details: { successful: false, error: "Not this" } } },
      "sent",
    ],
    ["a failure with no words", { successful: false }, "The app did not send it."],
  ])("reads %s", (_, result, outcome) => {
    expect(readSendResult(result)).toEqual(
      outcome === "sent" || outcome === "uncertain"
        ? { kind: outcome }
        : { kind: "not_sent", reason: outcome },
    );
  });
});

describe("outboundAskDraft", () => {
  const request = { to: "someone@example.com", subject: "Hi", body: "Hello" };
  const draft: DraftBinding = {
    path: ["body"],
    proposed: "Hello",
    fields: {
      recipients: [{ role: "to", path: ["to"], shape: "one" }],
      subject: ["subject"],
      proposed: { recipients: [{ role: "to", address: "someone@example.com" }], subject: "Hi" },
    },
    account: "me@example.com",
  };

  it("names the app from the connector catalog, with its logo and the sending account", async () => {
    const card = await outboundAskDraft("gmail", request, draft, {
      connections: [{ connectorId: "composio", provider: "GMAIL", displayName: "Work mail" }],
      catalog: async () => [
        {
          connectorId: "composio",
          slug: "GMAIL",
          name: "Gmail",
          logo: "https://logos.example/gmail.svg",
          connected: true,
          noAuth: false,
        },
      ],
    });
    expect(card).toEqual({
      app: { name: "Gmail", logo: "https://logos.example/gmail.svg", account: "me@example.com" },
      recipients: [{ role: "to", address: "someone@example.com" }],
      subject: "Hi",
      fields: { to: 1, subject: true },
      body: "Hello",
    });
  });

  it("still names the app when the catalog is unreachable or the app is not connected", async () => {
    const offline = await outboundAskDraft("gmail", request, draft, {
      connections: [{ connectorId: "composio", provider: "gmail", displayName: "Work mail" }],
      catalog: async () => {
        throw new Error("offline");
      },
    });
    const viaMcp = await outboundAskDraft("sendmessage", request, draft, {
      connections: [],
      catalog: () => undefined,
      toolAppName: "Acme Mail",
    });
    expect([offline?.app, viaMcp?.app.name]).toEqual([
      { name: "Work mail", logo: null, account: "me@example.com" },
      "Acme Mail",
    ]);
  });

  it("shows a chat message's conversation by its id when its app gave no name", async () => {
    const card = await outboundAskDraft(
      "acmechat",
      { channel: "C0GENERAL", text: "Hi" },
      { path: ["text"], proposed: "Hi", chat: { path: ["channel"] } },
      { connections: [], catalog: () => undefined },
    );
    expect(card).toMatchObject({
      recipients: [{ role: "to", address: "C0GENERAL" }],
      body: "Hi",
    });
    expect(card?.conversation).toBe(undefined);
  });
});
