import type { OutboundDraft } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  boundDirectApprovalRequest,
  catalogApprovalRequest,
  DIRECT_APPROVAL_TAG,
} from "./approval-effect.js";
import { connectorCallActions } from "./connector-actions.js";
import {
  draftRequest,
  outboundAskDraft,
  readConnectorOutbound,
  readSendResult,
} from "./outbound-gate.js";

// The send a bot made through Composio's batch tool (trace 2026-10-23), account and address
// replaced.
const tracedItem = {
  tool_slug: "GMAIL_SEND_EMAIL",
  account: "gmail_test",
  arguments: {
    recipient_email: "someone@example.com",
    subject: "Test Chief",
    body: "Hello from Chief.",
    is_html: false,
    include_signature: false,
  },
};
const fetchItem = { tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "is:unread" } };
const send = tracedItem.arguments;

function gate(toolName: string, args: Record<string, unknown>): string {
  const read = readConnectorOutbound(toolName, args, connectorCallActions(toolName, args), []);
  return read.kind === "refuse" ? `refuse: ${read.error}` : read.kind;
}

describe("an opaque batch", () => {
  it("gets the classic card while its tools value fits whole, and is refused when it cannot", () => {
    expect(gate("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: "[not json" })).toBe("classic");
    expect(gate("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: `[${"x".repeat(5_000)}` })).toBe(
      "refuse: Too many arguments to show the user. Send with fewer fields at a time.",
    );
  });
});

describe("readConnectorOutbound", () => {
  it.each([
    ["direct", "GMAIL_SEND_EMAIL", send, "draft"],
    ["direct, lower case", "gmail_send_email", send, "draft"],
    ["direct, MCP prefixed", "mcp__composio__GMAIL_SEND_EMAIL", send, "draft"],
    ["batch of one", "COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [tracedItem] }, "draft"],
    [
      "batch of one, MCP prefixed",
      "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL",
      { tools: [tracedItem], thought: "Send it" },
      "draft",
    ],
    [
      "batch of one, catalog id",
      "resource-1:COMPOSIO_MULTI_EXECUTE_TOOL",
      { tools: [tracedItem] },
      "draft",
    ],
    [
      "batch of one, percent-encoded catalog id",
      "resource-1:COMPOSIO%5FMULTI%5FEXECUTE%5FTOOL",
      { tools: [tracedItem] },
      "draft",
    ],
    [
      "batch of one, spaced lower case",
      " composio_multi_execute_tool ",
      { tools: [tracedItem] },
      "draft",
    ],
    [
      "batch of two with a send",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      { tools: [fetchItem, tracedItem] },
      "refuse: Send this message on its own.",
    ],
    [
      "batch of three with a send",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      { tools: [fetchItem, tracedItem, fetchItem] },
      "refuse: Send this message on its own.",
    ],
    [
      "batch of two reads",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      { tools: [fetchItem, fetchItem] },
      "none",
    ],
    [
      "batch of one, tools as a string",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      { tools: JSON.stringify([tracedItem]) },
      "classic",
    ],
    [
      "batch of reads, tools as a string",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      { tools: JSON.stringify([fetchItem]) },
      "none",
    ],
    ["unreadable batch", "COMPOSIO_MULTI_EXECUTE_TOOL", { tools: "[" }, "classic"],
  ])("%s gives %s", (_, toolName, args, expected) => {
    expect(gate(toolName, args)).toBe(expected);
  });

  it.each([
    [
      "Gmail send",
      "GMAIL_SEND_EMAIL",
      { to: "a@example.com", body: "Hi", is_html: true },
      {
        to: "a@example.com",
        body: "Hi",
        is_html: false,
        include_signature: false,
      },
    ],
    [
      "Gmail reply behind MCP",
      "mcp__composio__GMAIL_REPLY_TO_THREAD",
      { thread_id: "t1", recipient_email: "a@example.com", message_body: "Ok" },
      {
        thread_id: "t1",
        recipient_email: "a@example.com",
        message_body: "Ok",
        include_signature: false,
      },
    ],
    [
      "Outlook send",
      "OUTLOOK_SEND_EMAIL",
      { to: "a@example.com", body: "Hi" },
      {
        to: "a@example.com",
        body: "Hi",
      },
    ],
  ])(
    "sends a %s with what the card shows, no HTML and no signature it adds",
    (_, name, args, sent) => {
      const read = readConnectorOutbound(name, args, undefined, []);
      expect(read.kind === "draft" && read.draft.args).toEqual(sent);
    },
  );
});

describe("draftRequest", () => {
  const marker = "__marker";
  const route = { connectorId: "mcp", resourceId: "r1", toolName: "COMPOSIO_MULTI_EXECUTE_TOOL" };
  const draft = (args: Record<string, unknown>): OutboundDraft => ({
    connectorKind: "gmail",
    recipients: [{ role: "to", address: "someone@example.com" }],
    body: "Hello from Chief.",
    args: { ...args, include_signature: false },
    textPath: ["body"],
    fields: {
      recipients: [{ role: "to", path: ["recipient_email"], shape: "one" }],
      subject: ["subject"],
    },
  });

  it.each([
    ["a direct call", send, false, ["body"]],
    [
      "a catalog batch",
      catalogApprovalRequest(
        "mcp_execute_tool",
        { id: "r1:COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [tracedItem] } },
        marker,
        route,
      ),
      true,
      [2, "arguments", "tools", 0, "arguments", "body"],
    ],
    [
      "a native send over the lazy catalog, which has no batch",
      catalogApprovalRequest(
        "composio_execute_tool",
        { id: "r1:GMAIL_SEND_EMAIL", arguments: send },
        marker,
        { ...route, toolName: "GMAIL_SEND_EMAIL" },
      ),
      false,
      [2, "arguments", "body"],
    ],
    [
      "a bound batch",
      boundDirectApprovalRequest(route, { tools: [tracedItem] }, marker),
      true,
      [2, "args", "tools", 0, "arguments", "body"],
    ],
  ])("stores the draft's arguments in %s and finds its message", (_, request, batched, path) => {
    const stored = draftRequest(request, marker, batched, draft({ ...send, is_html: false }));
    const at = path.slice(0, -1);
    expect(stored?.binding).toEqual({
      path,
      proposed: "Hello from Chief.",
      fields: {
        recipients: [{ role: "to", path: [...at, "recipient_email"], shape: "one" }],
        subject: [...at, "subject"],
        proposed: { recipients: [{ role: "to", address: "someone@example.com" }] },
      },
    });
    expect(JSON.stringify(stored?.request)).toContain('"include_signature":false');
    expect(stored && path.reduce<unknown>((at, key) => (at as never)[key], stored.request)).toBe(
      "Hello from Chief.",
    );
  });

  it("has no place for a draft in a request that is not an object", () => {
    expect(draftRequest([marker, DIRECT_APPROVAL_TAG, {}], marker, false, draft(send))).toBe(
      undefined,
    );
  });
});

describe("readSendResult", () => {
  const batch = (response: object) => ({
    successful: false,
    data: { results: [{ response, tool_slug: "GMAIL_SEND_EMAIL", index: 0 }] },
    error: null,
  });

  it.each([
    ["a sent mail", { successful: true, data: { id: "m1", labelIds: ["SENT"] } }, "sent"],
    [
      "a batch that sent",
      { successful: true, data: { results: [{ response: { successful: true } }] }, error: null },
      "sent",
    ],
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
      "a failed action in a batch",
      batch({ successful: false, error: "Invalid recipient" }),
      "Invalid recipient",
    ],
    [
      "a failed action in an MCP text result",
      {
        content: [
          { type: "text", text: JSON.stringify(batch({ successful: false, error: "Quota" })) },
        ],
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
      "a failed action in MCP-hosted Composio's error",
      {
        error: "Connector tool reported an error. See details.",
        kind: "unknown",
        details: {
          content: [
            { type: "text", text: JSON.stringify(batch({ successful: false, error: "Quota" })) },
          ],
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
  const draft: OutboundDraft = {
    connectorKind: "gmail",
    recipients: [{ role: "to", address: "someone@example.com" }],
    subject: "Hi",
    body: "Hello",
    account: "me@example.com",
    args: {},
    textPath: ["body"],
  };

  it("names the app from the connector catalog, with its logo and the sending account", async () => {
    const card = await outboundAskDraft(draft, {
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
      recipients: draft.recipients,
      subject: "Hi",
      body: "Hello",
    });
  });

  it("still names the app when the catalog is unreachable or the app is not connected", async () => {
    const offline = await outboundAskDraft(draft, {
      connections: [{ connectorId: "composio", provider: "gmail", displayName: "Work mail" }],
      catalog: async () => {
        throw new Error("offline");
      },
    });
    const viaMcp = await outboundAskDraft(
      { ...draft, connectorKind: "sendmessage" },
      { connections: [], catalog: () => undefined, toolAppName: "Acme Mail" },
    );
    expect([offline.app, viaMcp.app.name]).toEqual([
      { name: "Work mail", logo: null, account: "me@example.com" },
      "Acme Mail",
    ]);
  });
});
