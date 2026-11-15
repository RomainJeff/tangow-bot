import { z } from "zod";
import { ConnectorError } from "./connector-error.js";

const HeaderValue = z.string().max(2_048);
export const HeaderName = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "Invalid HTTP header name")
  .refine((name) => !isTransportHeader(name), "Transport-level headers cannot be customized");

export const PublicHeadersSchema = z
  .record(HeaderName, HeaderValue)
  .default({})
  .superRefine((headers, context) => {
    for (const name of Object.keys(headers)) {
      if (isSensitiveHeader(name)) {
        context.addIssue({
          code: "custom",
          message: `Sensitive header ${name} must use the encrypted credential field`,
        });
      } else if (isTransportHeader(name)) {
        context.addIssue({
          code: "custom",
          message: `Transport-level header ${name} cannot be customized`,
        });
      }
    }
  });

export function requireCredential(auth: { type: string }, credential?: string): void {
  if (auth.type !== "none" && !credential)
    throw new ConnectorError("auth_required", "This connector requires a credential");
}

function isSensitiveHeader(name: string): boolean {
  return /(authorization|cookie|api[-_]?key|token|secret)/i.test(name);
}

function isTransportHeader(name: string): boolean {
  return /^(connection|content-length|host|proxy-authorization|proxy-connection|te|trailer|transfer-encoding|upgrade)$/i.test(
    name,
  );
}

export function assertNoSensitiveQuery(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Connector URL is invalid");
  }
  for (const name of url.searchParams.keys()) {
    if (/(auth|credential|key|password|secret|token)/i.test(name)) {
      throw new Error(`Connector URL must put ${name} in the encrypted credential field`);
    }
  }
}
