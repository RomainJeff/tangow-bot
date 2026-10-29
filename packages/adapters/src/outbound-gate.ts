import type { ConnectorCatalogItem } from "@rakazo/adapter-kit";
import type { AskDraft } from "@rakazo/contracts";
import type { DraftBinding, DraftPath } from "@rakazo/core";
import {
  askDraftFields,
  draftMessage,
  FEATURED_CONNECTOR_LABELS,
  matchFeaturedConnectorId,
  valueAt,
} from "@rakazo/core";
import { boundDirectApprovalDetails, catalogApprovalDetails } from "./approval-effect.js";

export function draftRequest(
  request: unknown,
  marker: string,
  draft: DraftBinding,
): DraftBinding | undefined {
  const at: DraftPath = boundDirectApprovalDetails(request, marker)
    ? [2, "args"]
    : catalogApprovalDetails(request, marker)
      ? [2, "arguments"]
      : [];
  const current = valueAt(request, at);
  if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
  const within = (path: DraftPath): DraftPath => [...at, ...path];
  const { fields, chat } = draft;
  return {
    ...draft,
    path: within(draft.path),
    ...(fields
      ? {
          fields: {
            ...fields,
            recipients: fields.recipients.map((slot) => ({ ...slot, path: within(slot.path) })),
            ...(fields.subject ? { subject: within(fields.subject) } : {}),
          },
        }
      : {}),
    ...(chat ? { chat: { ...chat, path: within(chat.path) } } : {}),
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

export async function outboundAskDraft(
  connectorKind: string,
  request: unknown,
  draft: DraftBinding,
  sources: {
    connections: ReadonlyArray<{ connectorId: string; provider: string; displayName: string }>;
    catalog: (connectorId: string) => Promise<ConnectorCatalogItem[]> | undefined;
    toolAppName?: string;
  },
): Promise<AskDraft | undefined> {
  const message = draftMessage(request, draft);
  const conversation = draft.chat && valueAt(request, draft.chat.path);
  const recipients =
    message.recipients ??
    (typeof conversation === "string"
      ? [{ role: "to" as const, address: draft.chat?.name ?? conversation }]
      : []);
  if (!recipients.length) return undefined;
  const connection = sources.connections.find(
    (row) => row.provider.toLowerCase() === connectorKind,
  );
  const items = connection
    ? await sources.catalog(connection.connectorId)?.catch(() => undefined)
    : undefined;
  const item = items?.find((candidate) => candidate.slug.toLowerCase() === connectorKind);
  const featured = matchFeaturedConnectorId(connectorKind);
  return {
    app: {
      name:
        item?.name ??
        connection?.displayName ??
        (featured ? FEATURED_CONNECTOR_LABELS[featured] : undefined) ??
        sources.toolAppName ??
        connectorKind,
      logo: item?.logo ?? null,
      account: draft.account,
    },
    recipients,
    ...(draft.chat ? { chat: true as const } : {}),
    subject: message.subject,
    ...(draft.fields ? { fields: askDraftFields(draft.fields) } : {}),
    body: message.body,
  };
}
