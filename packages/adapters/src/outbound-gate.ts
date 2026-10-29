import type { ConnectorCatalogItem } from "@rakazo/adapter-kit";
import type { AskDraft } from "@rakazo/contracts";
import type { DraftBinding, DraftPath, OutboundCall, OutboundDraft } from "@rakazo/core";
import {
  askDraftFields,
  FEATURED_CONNECTOR_LABELS,
  matchFeaturedConnectorId,
  readOutboundCall,
  valueAt,
  withValueAt,
} from "@rakazo/core";
import { boundDirectApprovalDetails, catalogApprovalDetails } from "./approval-effect.js";
import { CHAT_APPS } from "./slack-recipient.js";

/** Composio's Gmail sends add the account's signature unless told not to. */
const COMPOSIO_SIGNED_SENDS = new Set(["GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD"]);

/**
 * How a connector call is gated when it may send a message, using the called tool's input schema.
 */
export function readConnectorOutbound(
  toolName: string,
  args: Record<string, unknown>,
  connectorKinds: string[],
  schema?: Record<string, unknown>,
): OutboundCall {
  const read = readOutboundCall({ toolName, args, schema }, connectorKinds, CHAT_APPS);
  if (read.kind !== "draft" && read.kind !== "chat") return read;
  if (read.kind === "chat") return read;
  const action = toolName.replace(/^mcp__.+?__/, "").toUpperCase();
  if (COMPOSIO_SIGNED_SENDS.has(action) && !("include_signature" in read.draft.args)) {
    return {
      kind: "draft",
      draft: { ...read.draft, args: { ...read.draft.args, include_signature: false } },
    };
  }
  return read;
}

/**
 * The stored request with the draft's arguments in place of the call's, and where its message
 * sits, or undefined when the request has no place for them.
 */
export function draftRequest(
  request: unknown,
  marker: string,
  draft: OutboundDraft,
): { request: unknown; binding: DraftBinding } | undefined {
  const envelope: DraftPath = boundDirectApprovalDetails(request, marker)
    ? [2, "args"]
    : catalogApprovalDetails(request, marker)
      ? [2, "arguments"]
      : [];
  const at = envelope;
  const current = valueAt(request, at);
  if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
  const next = withValueAt(request, at, draft.args);
  if (next === undefined) return undefined;
  const { fields } = draft;
  const within = (path: DraftPath): DraftPath => [...at, ...path];
  return {
    request: next,
    binding: {
      path: within(draft.textPath),
      proposed: draft.body,
      ...(fields
        ? {
            fields: {
              recipients: fields.recipients.map((slot) => ({ ...slot, path: within(slot.path) })),
              ...(fields.subject ? { subject: within(fields.subject) } : {}),
              proposed: { recipients: draft.recipients, subject: draft.subject },
            },
          }
        : {}),
    },
  };
}

export type SendResult =
  | { kind: "sent" }
  | { kind: "not_sent"; reason: string }
  | { kind: "uncertain" };

/**
 * What became of a send, read from the connector's result. Only the app saying no counts as not
 * sent: a Composio action marked `successful: false`, inside JSON text or the details
 * of the connector's error. Anything else is uncertain, a bare connector error and an MCP error
 * result included: a timeout after the send gives the first, and a server that throws after it
 * posted gives the second.
 */
export function readSendResult(result: unknown): SendResult {
  // The details of the executor's error envelope, which only the outermost level has.
  const details =
    result && typeof result === "object" ? (result as Record<string, unknown>).details : undefined;
  const reason = failureIn(result, 0) ?? failureIn(details, 1);
  if (reason !== undefined) {
    return { kind: "not_sent", reason: reason.trim().slice(0, 200) || "The app did not send it." };
  }
  const bare = result && typeof result === "object" && "error" in result && result.error;
  return bare ? { kind: "uncertain" } : { kind: "sent" };
}

function failureIn(value: unknown, depth: number): string | undefined {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = failureIn(item, depth + 1);
      if (reason !== undefined) return reason;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["data", "structuredContent", "content"]) {
    const reason = failureIn(record[key], depth + 1);
    if (reason !== undefined) return reason;
  }
  if (record.type === "text" && typeof record.text === "string") {
    try {
      return failureIn(JSON.parse(record.text), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (record.successful === false) {
    return (typeof record.error === "string" ? record.error : "") || textOf(record.content);
  }
  return undefined;
}

function textOf(content: unknown): string {
  return Array.isArray(content)
    ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(" ")
    : "";
}

/** The card's view of a draft: the app it leaves from and the message as it will leave. */
export async function outboundAskDraft(
  draft: OutboundDraft,
  sources: {
    connections: ReadonlyArray<{ connectorId: string; provider: string; displayName: string }>;
    catalog: (connectorId: string) => Promise<ConnectorCatalogItem[]> | undefined;
    toolAppName?: string;
  },
): Promise<AskDraft> {
  const kind = draft.connectorKind;
  const connection = sources.connections.find((row) => row.provider.toLowerCase() === kind);
  const items = connection
    ? await sources.catalog(connection.connectorId)?.catch(() => undefined)
    : undefined;
  const item = items?.find((candidate) => candidate.slug.toLowerCase() === kind);
  const featured = matchFeaturedConnectorId(kind);
  return {
    app: {
      name:
        item?.name ??
        connection?.displayName ??
        (featured ? FEATURED_CONNECTOR_LABELS[featured] : undefined) ??
        sources.toolAppName ??
        kind,
      logo: item?.logo ?? null,
      account: draft.account,
    },
    recipients: draft.recipients,
    ...(draft.conversation ? { conversation: draft.conversation } : {}),
    subject: draft.subject,
    ...(draft.fields ? { fields: askDraftFields(draft.fields) } : {}),
    body: draft.body,
  };
}
