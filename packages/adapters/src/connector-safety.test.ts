import { describe, expect, it } from "vitest";
import { redactConnectorPayload, sanitizeConnectorError } from "./connector-safety.js";

describe("redactConnectorPayload", () => {
  it("redacts secrets that JSON escapes in property names and values", () => {
    const secret = 'api"key';

    expect(
      redactConnectorPayload(
        {
          [secret]: `prefix ${secret} suffix`,
          nested: { value: secret },
        },
        [secret],
      ),
    ).toEqual({
      "[redacted]": "prefix [redacted] suffix",
      nested: { value: "[redacted]" },
    });
  });

  it("falls back to an inert result when the payload is not JSON serializable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(redactConnectorPayload(circular, ["secret"])).toEqual({ ok: true });
  });

  it("redacts secrets represented by non-string JSON leaves", () => {
    expect(
      redactConnectorPayload({ number: 123, boolean: true, empty: null }, ["123", "true", "null"]),
    ).toEqual({ number: "[redacted]", boolean: "[redacted]", empty: "[redacted]" });
  });
});

describe("sanitizeConnectorError", () => {
  it("appends the cause chain so undici's 'fetch failed' names the real failure", () => {
    const error = new Error("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo EAI_AGAIN mcp.notion.com"), {
        code: "EAI_AGAIN",
      }),
    });

    expect(sanitizeConnectorError(error)).toBe(
      "fetch failed: getaddrinfo EAI_AGAIN mcp.notion.com (EAI_AGAIN)",
    );
  });

  it("stops at a self-referential cause and still redacts secrets", () => {
    const error = new Error("outer", { cause: new Error("Bearer tok_live_123") });
    error.cause = Object.assign(error.cause as Error, { cause: error });

    expect(sanitizeConnectorError(error)).toBe("outer: Bearer [redacted]");
  });
});
