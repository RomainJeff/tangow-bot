import { isDeepStrictEqual } from "node:util";
import type { ConnectorCatalogItem } from "@rakazo/adapter-kit";
import type { AskDraft } from "@rakazo/contracts";
import type { OutboundCall, OutboundDraft } from "@rakazo/core";
import {
  FEATURED_CONNECTOR_LABELS,
  matchFeaturedConnectorId,
  readOutboundCall,
} from "@rakazo/core";
import {
  boundDirectApprovalDetails,
  catalogApprovalDetails,
  catalogApprovalInnerArgs,
} from "./approval-effect.js";
import { type ConnectorCallActions, connectorCallActions } from "./connector-actions.js";

/** How a connector call is gated when it may send a message. */
export function readConnectorOutbound(
  toolName: string,
  args: Record<string, unknown>,
  contained: ConnectorCallActions | undefined,
  connectorKinds: string[],
): OutboundCall {
  if (contained?.kind === "opaque") return { kind: "classic" };
  const actions = contained?.actions ?? [{ toolName, args }];
  const read = readOutboundCall(actions, connectorKinds);
  if (read.kind !== "draft") return read;
  // Send replays the stored request as proposed, so the card can only show a request that
  // already is what leaves.
  if (contained?.serialized || !isDeepStrictEqual(read.draft.args, actions[0]!.args)) {
    return { kind: "classic" };
  }
  return read;
}

/** Whether an effect waiting for an answer is a draft, read as it was when proposed. */
export function isStoredDraft(
  effect: { kind: string; request: unknown },
  marker: string,
  connectorKinds: string[],
): boolean {
  const { toolName, args } = storedCall(effect, marker);
  const contained = connectorCallActions(toolName, args);
  return readConnectorOutbound(toolName, args, contained, connectorKinds).kind === "draft";
}

function storedCall(
  { kind, request }: { kind: string; request: unknown },
  marker: string,
): { toolName: string; args: Record<string, unknown> } {
  const bound = boundDirectApprovalDetails(request, marker);
  if (bound) return { toolName: bound.route.toolName, args: bound.args };
  const catalog = catalogApprovalDetails(request, marker);
  if (catalog) {
    return {
      toolName: catalog.route?.toolName ?? kind,
      args: catalogApprovalInnerArgs(catalog) ?? {},
    };
  }
  const args =
    request && typeof request === "object" && !Array.isArray(request)
      ? (request as Record<string, unknown>)
      : {};
  return { toolName: kind, args };
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
