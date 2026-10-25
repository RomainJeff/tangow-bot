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
    ["COMPOSIO_MULTI_EXECUTE_TOOL", [send], false],
    ["mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", [send], false],
    ["mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", JSON.stringify([send]), true],
    ["resource-1:COMPOSIO_MULTI_EXECUTE_TOOL", [send], false],
    ["resource-1:COMPOSIO%5FMULTI%5FEXECUTE%5FTOOL", [send], false],
    [" composio_multi_execute_tool ", [send], false],
  ])("unwraps a %s batch", (toolName, tools, serialized) => {
    expect(connectorCallActions(toolName, { tools, thought: "Send it" })).toEqual({
      kind: "actions",
      actions: [{ toolName: "GMAIL_SEND_EMAIL", args: send.arguments }],
      serialized,
    });
  });

  it("keeps every action of a batch in order", () => {
    const fetch = { tool_slug: "GMAIL_FETCH_EMAILS" };
    expect(connectorCallActions("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [fetch, send] })).toEqual({
      kind: "actions",
      actions: [
        { toolName: "GMAIL_FETCH_EMAILS", args: {} },
        { toolName: "GMAIL_SEND_EMAIL", args: send.arguments },
      ],
      serialized: false,
    });
  });

  it("leaves a tool that is not a batch to itself", () => {
    expect(connectorCallActions("GMAIL_SEND_EMAIL", { tools: [send] })).toBeUndefined();
    expect(connectorCallActions("COMPOSIO_SEARCH_TOOLS", { queries: [] })).toBeUndefined();
  });

  it.each([
    ["an empty batch", { tools: [] }],
    ["a batch without tools", { thought: "Send it" }],
    ["an unparseable batch", { tools: "[" }],
    ["an item without a slug", { tools: [send, { arguments: {} }] }],
    ["an item whose arguments are not an object", { tools: [{ ...send, arguments: "x" }] }],
  ])("marks %s as unreadable", (_, args) => {
    expect(connectorCallActions("COMPOSIO_MULTI_EXECUTE_TOOL", args)).toEqual({ kind: "opaque" });
  });
});
