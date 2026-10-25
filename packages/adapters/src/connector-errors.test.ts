import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { connectorError, connectorResult } from "./connector-errors.js";

describe("connector failures", () => {
  it.each([
    [new UnauthorizedError("Sign in"), "auth_required"],
    [new StreamableHTTPError(403, "Denied"), "permission_denied"],
    [new McpError(ErrorCode.InvalidParams, "Bad arguments"), "invalid_arguments"],
    [new McpError(ErrorCode.MethodNotFound, "Unavailable"), "unsupported"],
    [new McpError(ErrorCode.RequestTimeout, "Timed out"), "transient"],
    [Object.assign(new Error("Expired"), { status: 401 }), "auth_required"],
    [Object.assign(new Error("Busy"), { statusCode: 429 }), "transient"],
    [new Error("authentication failed, retry later"), "unknown"],
  ])("classifies explicit protocol evidence, not message wording: %s", (error, kind) => {
    expect(connectorError(error)).toMatchObject({ type: "error", kind });
  });

  it("redacts failure messages before returning them", () => {
    expect(
      connectorError(new Error("Failed with Bearer fake-token and private-value"), [
        "private-value",
      ]),
    ).toEqual({
      type: "error",
      kind: "unknown",
      message: "Failed with Bearer [redacted] and [redacted]",
    });
  });

  it("keeps opaque MCP tool failures unknown and preserves their redacted details", () => {
    expect(
      connectorResult({ isError: true, content: [{ type: "text", text: "auth fake-secret" }] }, [
        "fake-secret",
      ]),
    ).toEqual({
      type: "error",
      kind: "unknown",
      message: "Connector tool reported an error. See details.",
      details: { isError: true, content: [{ type: "text", text: "auth [redacted]" }] },
    });
  });

  it.each([
    [400, "invalid_arguments"],
    [401, "auth_required"],
    [403, "permission_denied"],
    [404, "unknown"],
    [429, "transient"],
    [500, "transient"],
    [501, "unsupported"],
  ])(
    "classifies unsuccessful HTTP results without treating missing resources as missing capabilities: %s",
    (status, kind) => {
      const result = { error: true, status, data: { message: "failure" } };
      expect(connectorResult(result)).toEqual({
        type: "error",
        kind,
        message: "Connector tool reported an error. See details.",
        details: result,
      });
    },
  );

  it("preserves successful results, including false error flags", () => {
    expect(connectorResult({ isError: false, content: [] })).toEqual({
      type: "result",
      data: { isError: false, content: [] },
    });
  });
});
