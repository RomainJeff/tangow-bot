import { describe, expect, it } from "vitest";
import { connectorCallActions } from "./connector-actions.js";

// The envelope a bot sent through Composio's remote MCP server (trace 2026-10-23).
const send = {
  tool_slug: "GMAIL_SEND_EMAIL",
  account: "gmail_test",
  arguments: {
    recipient_email: "someone@example.com",
    subject: "Test",
    body: "Hello",
    is_html: false,
    include_signature: false,
  },
};

describe("connectorCallActions", () => {
  it.each([
    ["COMPOSIO_MULTI_EXECUTE_TOOL", [send]],
    ["mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", [send]],
    ["mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", JSON.stringify([send])],
  ])("unwraps a %s batch", (toolName, tools) => {
    expect(connectorCallActions(toolName, { tools, thought: "Send it" })).toEqual([
      { toolName: "GMAIL_SEND_EMAIL", args: send.arguments },
    ]);
  });

  it("keeps every action of a batch in order", () => {
    const fetch = { tool_slug: "GMAIL_FETCH_EMAILS" };
    expect(connectorCallActions("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [fetch, send] })).toEqual([
      { toolName: "GMAIL_FETCH_EMAILS", args: {} },
      { toolName: "GMAIL_SEND_EMAIL", args: send.arguments },
    ]);
  });

  it.each([
    ["a tool that is not a batch", "GMAIL_SEND_EMAIL", { tools: [send] }],
    ["an empty batch", "COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [] }],
    ["an unparseable batch", "COMPOSIO_MULTI_EXECUTE_TOOL", { tools: "[" }],
    ["an item without a slug", "COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [send, { arguments: {} }] }],
  ])("leaves %s to the wrapper", (_, toolName, args) => {
    expect(connectorCallActions(toolName, args)).toBeUndefined();
  });
});
