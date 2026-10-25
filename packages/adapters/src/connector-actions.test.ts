import { describe, expect, it } from "vitest";
import {
  batchItemSchemaCall,
  batchItemSchemaIn,
  connectorCallActions,
} from "./connector-actions.js";

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

describe("batchItemSchemaCall", () => {
  const route = {
    connectorId: "mcp",
    resourceId: "r1",
    resourceRevision: 3,
    toolName: "COMPOSIO_MULTI_EXECUTE_TOOL",
  };

  it("asks the batch's own server, on its route, for one item's schema", () => {
    expect(
      batchItemSchemaCall(
        { tool: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", args: {}, executionId: "c1", route },
        "GMAIL_SEND_EMAIL",
      ),
    ).toEqual({
      tool: "COMPOSIO_GET_TOOL_SCHEMAS",
      args: { tool_slugs: ["GMAIL_SEND_EMAIL"] },
      executionId: "c1:schema",
      route: { ...route, toolName: "COMPOSIO_GET_TOOL_SCHEMAS" },
    });
  });

  it("asks nothing of a call that is not Composio's batch", () => {
    expect(
      batchItemSchemaCall(
        {
          tool: "GMAIL_SEND_EMAIL",
          args: {},
          executionId: "c1",
          route: { ...route, toolName: "GMAIL_SEND_EMAIL" },
        },
        "GMAIL_SEND_EMAIL",
      ),
    ).toBe(undefined);
  });
});

describe("batchItemSchemaIn", () => {
  const schema = {
    type: "object",
    properties: { cc: { type: "array", items: { type: "string" } } },
  };
  const answer = {
    successful: true,
    data: { success: true, tool_schemas: { GMAIL_SEND_EMAIL: { input_schema: schema } } },
  };

  it.each([
    ["the native session's data", { data: answer.data, logId: "log_1" }],
    [
      "an MCP text result",
      { content: [{ type: "text", text: JSON.stringify(answer) }], isError: false },
    ],
    ["an MCP structured result", { content: [], structuredContent: answer }],
  ])("reads the schema from %s", (_, result) => {
    expect(batchItemSchemaIn(result, "gmail_send_email")).toEqual(schema);
  });

  it.each([
    [
      "a slug it did not find",
      { data: { success: false, tool_schemas: {}, not_found: ["GMAIL_SEND_EMAIL"] } },
    ],
    [
      "a schema with no fields",
      { data: { tool_schemas: { GMAIL_SEND_EMAIL: { input_schema: { type: "object" } } } } },
    ],
    ["an error", { error: "Unknown tool" }],
  ])("reads nothing from %s", (_, result) => {
    expect(batchItemSchemaIn(result, "GMAIL_SEND_EMAIL")).toBe(undefined);
  });
});
