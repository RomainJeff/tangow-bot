import { describe, expect, it } from "vitest";
import { batchItemSchemaCall, batchItemSchemaIn } from "./batch-item-schema.js";

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

  it("keeps only what a draft reads: the type and the recipient lines", () => {
    const full = {
      type: "object",
      properties: { ...schema.properties, body: { type: "string" }, user_id: { type: "string" } },
      required: ["body"],
    };
    expect(
      batchItemSchemaIn(
        { data: { tool_schemas: { GMAIL_SEND_EMAIL: { input_schema: full } } } },
        "GMAIL_SEND_EMAIL",
      ),
    ).toEqual(schema);
  });

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
    ["schemas under a key the lookup does not answer in", { echo: { request: answer.data } }],
  ])("reads nothing from %s", (_, result) => {
    expect(batchItemSchemaIn(result, "GMAIL_SEND_EMAIL")).toBe(undefined);
  });
});
