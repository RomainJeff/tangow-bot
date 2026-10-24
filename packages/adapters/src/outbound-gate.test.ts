import type { OutboundDraft } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  boundDirectApprovalRequest,
  catalogApprovalRequest,
  DIRECT_APPROVAL_TAG,
} from "./approval-effect.js";
import { connectorCallActions } from "./connector-actions.js";
import { isStoredDraft, outboundAskDraft, readConnectorOutbound } from "./outbound-gate.js";

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
    ["send that turns on HTML", "GMAIL_SEND_EMAIL", { ...send, is_html: true }, "classic"],
  ])("%s gives %s", (_, toolName, args, expected) => {
    expect(gate(toolName, args)).toBe(expected);
  });
});

describe("isStoredDraft", () => {
  const marker = "__marker";

  it("reads a draft back from each way a request is stored", () => {
    const route = { connectorId: "mcp", resourceId: "r1", toolName: "COMPOSIO_MULTI_EXECUTE_TOOL" };
    const stored = [
      { kind: "GMAIL_SEND_EMAIL", request: send },
      {
        kind: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL",
        request: catalogApprovalRequest(
          "mcp_execute_tool",
          { id: "r1:COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [tracedItem] } },
          marker,
          route,
        ),
      },
      {
        kind: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL",
        request: boundDirectApprovalRequest(route, { tools: [tracedItem] }, marker),
      },
      { kind: "GMAIL_FETCH_EMAILS", request: { query: "x" } },
      { kind: "spawn_bot", request: [marker, DIRECT_APPROVAL_TAG, {}] },
    ];
    expect(stored.map((effect) => isStoredDraft(effect, marker, []))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
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
