import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectorEvent, ConnectorFailureKind } from "@rakazo/adapter-kit";
import { z } from "zod";
import { ConnectorError } from "./connector-error.js";
import { redactConnectorPayload, sanitizeConnectorError } from "./connector-safety.js";

export function httpConnectorFailureKind(status: number | undefined): ConnectorFailureKind {
  if (status === 401) return "auth_required";
  if (status === 403) return "permission_denied";
  if (status === 400 || status === 422) return "invalid_arguments";
  if (status === 405 || status === 501) return "unsupported";
  if (status === 408 || status === 429 || (status !== undefined && status >= 500 && status < 600))
    return "transient";
  return "unknown";
}

const HttpFailureSchema = z.object({
  status: z.number().int().optional(),
  statusCode: z.number().int().optional(),
});

function failureKind(error: unknown): ConnectorFailureKind {
  if (error instanceof ConnectorError) return error.kind;
  if (error instanceof UnauthorizedError) return "auth_required";
  if (error instanceof StreamableHTTPError || error instanceof SseError)
    return httpConnectorFailureKind(error.code);
  if (error instanceof McpError) {
    switch (error.code) {
      case ErrorCode.InvalidParams:
        return "invalid_arguments";
      case ErrorCode.MethodNotFound:
        return "unsupported";
      case ErrorCode.RequestTimeout:
        return "transient";
      default:
        return "unknown";
    }
  }
  if (error instanceof z.ZodError) return "invalid_arguments";
  const parsed = HttpFailureSchema.safeParse(error);
  return parsed.success
    ? httpConnectorFailureKind(parsed.data.status ?? parsed.data.statusCode)
    : "unknown";
}

export function connectorError(
  error: unknown,
  secrets: string[] = [],
): Extract<ConnectorEvent, { type: "error" }> {
  return {
    type: "error",
    kind: failureKind(error),
    message: sanitizeConnectorError(error, secrets),
  };
}

export function connectorResult(data: unknown, secrets: string[] = []): ConnectorEvent {
  const clean = redactConnectorPayload(data, secrets);
  if (
    data &&
    typeof data === "object" &&
    (("isError" in data && data.isError === true) || ("error" in data && data.error === true))
  ) {
    return {
      type: "error",
      kind: "isError" in data && data.isError === true ? "unknown" : failureKind(data),
      message: "Connector tool reported an error. See details.",
      details: clean,
    };
  }
  return { type: "result", data: clean };
}
