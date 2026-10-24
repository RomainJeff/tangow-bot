import type { ConnectorCatalogItem } from "@rakazo/adapter-kit";
import type { AskDraft } from "@rakazo/contracts";
import type { DraftPath, OutboundCall, OutboundDraft } from "@rakazo/core";
import {
  cardFitsArguments,
  FEATURED_CONNECTOR_LABELS,
  matchFeaturedConnectorId,
  REFUSE_UNSHOWABLE,
  readOutboundCall,
  valueAt,
  withValueAt,
} from "@rakazo/core";
import { boundDirectApprovalDetails, catalogApprovalDetails } from "./approval-effect.js";
import type { ConnectorCallActions } from "./connector-actions.js";

/** Composio's Gmail sends add the account's signature unless told not to. */
const COMPOSIO_SIGNED_SENDS = new Set(["GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD"]);

/** How a connector call is gated when it may send a message. */
export function readConnectorOutbound(
  toolName: string,
  args: Record<string, unknown>,
  contained: ConnectorCallActions | undefined,
  connectorKinds: string[],
): OutboundCall {
  if (contained?.kind === "opaque") {
    return cardFitsArguments(args) ? { kind: "classic" } : REFUSE_UNSHOWABLE;
  }
  const actions = contained?.actions ?? [{ toolName, args }];
  const read = readOutboundCall(actions, connectorKinds);
  if (read.kind !== "draft") return read;
  // The draft's arguments are stored in place of the call's, and items sent as one JSON string
  // have no place to put them back.
  if (contained?.serialized) {
    return cardFitsArguments(args) ? { kind: "classic" } : REFUSE_UNSHOWABLE;
  }
  const action = actions[0]!.toolName.replace(/^mcp__.+?__/, "").toUpperCase();
  if (COMPOSIO_SIGNED_SENDS.has(action) && !("include_signature" in read.draft.args)) {
    return {
      kind: "draft",
      draft: { ...read.draft, args: { ...read.draft.args, include_signature: false } },
    };
  }
  return read;
}

/**
 * The stored request with the draft's arguments in place of the call's, and where its body sits,
 * or undefined when the request has no place for them.
 */
export function draftRequest(
  request: unknown,
  marker: string,
  batched: boolean,
  draft: OutboundDraft,
): { request: unknown; path: DraftPath } | undefined {
  const envelope: DraftPath = boundDirectApprovalDetails(request, marker)
    ? [2, "args"]
    : catalogApprovalDetails(request, marker)
      ? [2, "arguments"]
      : [];
  const at = batched ? [...envelope, "tools", 0, "arguments"] : envelope;
  const current = valueAt(request, at);
  if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
  const next = withValueAt(request, at, draft.args);
  return next === undefined ? undefined : { request: next, path: [...at, ...draft.textPath] };
}

/**
 * Why a connector did not send, read from its result: an error, an MCP error result, or a
 * Composio action marked unsuccessful, inside a batch or a JSON text included.
 */
export function sendFailure(result: unknown): string | undefined {
  const reason = failureIn(result, 0);
  return reason === undefined
    ? undefined
    : reason.trim().slice(0, 200) || "The app did not send it.";
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
  for (const key of ["data", "response", "results", "structuredContent", "content"]) {
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
  const error = typeof record.error === "string" ? record.error : "";
  if (record.successful === false || record.isError === true || (depth === 0 && error)) {
    return error || textOf(record.content);
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
    subject: draft.subject,
    body: draft.body,
  };
}
