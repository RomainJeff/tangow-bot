import type { AgentToolExecutionResult } from "@tangow/adapter-kit";
import { APPROVAL_WAITING_TEXT } from "@tangow/contracts";
import {
  DRAFT_DISCARDED_NOTE,
  readDraft,
  refusedProposalResult,
  replacedDraftResult,
} from "@tangow/core";

export type ApprovalPausedToolResult = AgentToolExecutionResult & { terminate: true };

export interface ApprovedEffectReplay {
  kind: string;
  request: unknown;
  idempotencyKey?: string;
}

export interface ApprovedEffectReplayQueue {
  nextToolName(): string | undefined;
  nextRequest(): unknown;
  /** The approved effect's own key: a replay finds the row the user answered, whatever its args. */
  nextKey(): string | undefined;
  take(toolName: string): unknown;
  assertDrained(): void;
}

export function createApprovedEffectReplayQueue(
  effects: readonly ApprovedEffectReplay[],
): ApprovedEffectReplayQueue {
  const pending = [...effects];

  return {
    nextToolName() {
      return pending[0]?.kind;
    },
    nextRequest() {
      return pending[0]?.request;
    },
    nextKey() {
      return pending[0]?.idempotencyKey;
    },
    take(toolName) {
      const next = pending[0];
      if (!next || next.kind !== toolName) return undefined;
      pending.shift();
      return next.request;
    },
    assertDrained() {
      if (pending.length > 0) {
        throw new Error("Approved tool requests were not fully replayed");
      }
    },
  };
}

export function approvedCatalogReplay(
  queue: ApprovedEffectReplayQueue,
  toolName: string,
  marker: string,
  onCatalogExecuteRoute = false,
): { args?: Record<string, unknown>; error?: string } {
  const pending = catalogApprovalDetails(queue.nextRequest(), marker);
  if (!pending) return {};
  // Only the catalog execute wrapper may consume the wrapper envelope. After a catalog
  // shrink, matching direct tools resume via the FIFO path with inner arguments.
  if (!onCatalogExecuteRoute) return {};
  if (pending.toolName !== toolName) {
    return { error: `Approved request ${pending.toolName} must be replayed before ${toolName}.` };
  }
  return { args: pending.args };
}

export function approvedReplayArgs(
  approvedRequest: unknown,
  resolvedArgs: Record<string, unknown>,
  marker: string,
): Record<string, unknown> {
  // Catalog execute keeps resolveCall-parsed args (defaults/coercion). Shrink-to-direct
  // restores inner arguments in the executor when catalogRemapped is false.
  if (catalogApprovalDetails(approvedRequest, marker)) return resolvedArgs;
  const bound = boundDirectApprovalDetails(approvedRequest, marker);
  if (bound) return bound.args;
  if (!approvedRequest || typeof approvedRequest !== "object" || Array.isArray(approvedRequest)) {
    throw new TypeError("Approved tool request is not a JSON object");
  }
  return approvedRequest as Record<string, unknown>;
}

export const DIRECT_APPROVAL_TAG = "direct";

export type BoundApprovalRoute = {
  connectorId: string;
  resourceId: string;
  toolName: string;
  resourceRevision?: string | number;
};

export function catalogApprovalRequest(
  toolName: string,
  args: Record<string, unknown>,
  marker: string,
  route?: BoundApprovalRoute,
): unknown[] {
  return route ? [marker, toolName, args, route] : [marker, toolName, args];
}

export function catalogApprovalDetails(
  request: unknown,
  marker: string,
): { toolName: string; args: Record<string, unknown>; route?: BoundApprovalRoute } | undefined {
  if (
    !Array.isArray(request) ||
    (request.length !== 3 && request.length !== 4) ||
    request[0] !== marker ||
    typeof request[1] !== "string" ||
    !request[1].endsWith("_execute_tool") ||
    !request[2] ||
    typeof request[2] !== "object" ||
    Array.isArray(request[2])
  ) {
    return undefined;
  }
  if (request.length === 3) {
    return { toolName: request[1], args: request[2] as Record<string, unknown> };
  }
  const route = request[3];
  if (
    !route ||
    typeof route !== "object" ||
    Array.isArray(route) ||
    typeof (route as BoundApprovalRoute).connectorId !== "string" ||
    typeof (route as BoundApprovalRoute).resourceId !== "string" ||
    typeof (route as BoundApprovalRoute).toolName !== "string" ||
    ((route as BoundApprovalRoute).resourceRevision !== undefined &&
      typeof (route as BoundApprovalRoute).resourceRevision !== "string" &&
      typeof (route as BoundApprovalRoute).resourceRevision !== "number")
  ) {
    return undefined;
  }
  return {
    toolName: request[1],
    args: request[2] as Record<string, unknown>,
    route: route as BoundApprovalRoute,
  };
}

export function boundDirectApprovalRequest(
  route: BoundApprovalRoute,
  args: Record<string, unknown>,
  marker: string,
): unknown[] {
  return [marker, DIRECT_APPROVAL_TAG, { route, args }];
}

export function boundDirectApprovalDetails(
  request: unknown,
  marker: string,
): { route: BoundApprovalRoute; args: Record<string, unknown> } | undefined {
  if (
    !Array.isArray(request) ||
    request.length !== 3 ||
    request[0] !== marker ||
    request[1] !== DIRECT_APPROVAL_TAG ||
    !request[2] ||
    typeof request[2] !== "object" ||
    Array.isArray(request[2])
  ) {
    return undefined;
  }
  const payload = request[2] as { route?: unknown; args?: unknown };
  const route = payload.route;
  if (
    !route ||
    typeof route !== "object" ||
    Array.isArray(route) ||
    typeof (route as BoundApprovalRoute).connectorId !== "string" ||
    typeof (route as BoundApprovalRoute).resourceId !== "string" ||
    typeof (route as BoundApprovalRoute).toolName !== "string" ||
    ((route as BoundApprovalRoute).resourceRevision !== undefined &&
      typeof (route as BoundApprovalRoute).resourceRevision !== "string" &&
      typeof (route as BoundApprovalRoute).resourceRevision !== "number") ||
    !payload.args ||
    typeof payload.args !== "object" ||
    Array.isArray(payload.args)
  ) {
    return undefined;
  }
  return {
    route: route as BoundApprovalRoute,
    args: payload.args as Record<string, unknown>,
  };
}

export function approvalRoutesMatch(
  left: BoundApprovalRoute | undefined,
  right: BoundApprovalRoute | undefined,
): boolean {
  // Match resourceRevision so OAuth reauthorization (which bumps mcpServer.revision)
  // cannot replay an approval against a newly authenticated account. Quiet token
  // refresh persists credentials without incrementing revision, so those stay valid.
  return Boolean(
    left &&
      right &&
      left.connectorId === right.connectorId &&
      left.resourceId === right.resourceId &&
      left.toolName === right.toolName &&
      left.resourceRevision === right.resourceRevision,
  );
}

/** Reject draining a catalog approval from a non-catalog call unless the live route
 * matches the approved catalog target (catalog shrank back to direct tools). Direct
 * approvals may be replayed through a catalog wrapper after the catalog grows. */
export function approvalReplayPathError(
  toolName: string,
  catalogRemapped: boolean,
  approvedRequest: unknown,
  marker: string,
  liveRoute?: BoundApprovalRoute,
): string | undefined {
  if (!approvedRequest) return undefined;
  const catalog = catalogApprovalDetails(approvedRequest, marker);
  if (!catalogRemapped && catalog) {
    if (catalogApprovalMatchesLiveRoute(catalog, liveRoute)) return undefined;
    return `Approved catalog request ${toolName} must be replayed via its catalog execute tool.`;
  }
  return undefined;
}

/** Bound direct approvals must match the live connector resource on every replay.
 * Catalog approvals must match the approved target (and revision when persisted).
 * Legacy unbound direct approvals only fail closed when reached via catalog remap. */
export function approvalReplayResourceError(
  toolName: string,
  catalogRemapped: boolean,
  approvedRequest: unknown,
  liveRoute: BoundApprovalRoute | undefined,
  marker: string,
): string | undefined {
  const catalog = catalogApprovalDetails(approvedRequest, marker);
  if (catalog) {
    if (!liveRoute) return undefined;
    if (!catalogApprovalMatchesLiveRoute(catalog, liveRoute)) {
      return `Approved request ${toolName} was for a different connector resource.`;
    }
    return undefined;
  }
  const bound = boundDirectApprovalDetails(approvedRequest, marker);
  if (!bound) {
    if (catalogRemapped) {
      return `Approved direct request ${toolName} must be replayed as a direct tool call.`;
    }
    return undefined;
  }
  if (!approvalRoutesMatch(bound.route, liveRoute)) {
    return `Approved request ${toolName} was for a different connector resource.`;
  }
  return undefined;
}

export function catalogExecuteToolName(connectorId: string): string {
  return `${connectorId}_execute_tool`;
}

export function catalogIdForRoute(route: BoundApprovalRoute): string {
  return `${route.resourceId}:${encodeURIComponent(route.toolName)}`;
}

export function parseCatalogApprovalTarget(
  args: Record<string, unknown>,
): { resourceId: string; toolName: string } | undefined {
  const id = args.id;
  if (typeof id !== "string") return undefined;
  const separator = id.indexOf(":");
  if (separator <= 0 || separator === id.length - 1) return undefined;
  try {
    const resourceId = id.slice(0, separator);
    const toolName = decodeURIComponent(id.slice(separator + 1));
    if (!resourceId || !toolName) return undefined;
    return { resourceId, toolName };
  } catch {
    return undefined;
  }
}

export function catalogApprovalConnectorId(wrapperToolName: string): string {
  return wrapperToolName.endsWith("_execute_tool")
    ? wrapperToolName.slice(0, -"_execute_tool".length)
    : wrapperToolName;
}

export function catalogApprovalMatchesLiveRoute(
  catalog: { toolName: string; args: Record<string, unknown>; route?: BoundApprovalRoute },
  liveRoute: BoundApprovalRoute | undefined,
): boolean {
  if (catalog.route) return approvalRoutesMatch(catalog.route, liveRoute);
  // Legacy catalog approvals without a bound route cannot prove revision identity.
  // If the live tool carries a revision (MCP), fail closed rather than replaying
  // across an OAuth reauth that the old envelope could not name.
  if (liveRoute?.resourceRevision !== undefined) return false;
  const target = parseCatalogApprovalTarget(catalog.args);
  return Boolean(
    liveRoute &&
      target &&
      liveRoute.connectorId === catalogApprovalConnectorId(catalog.toolName) &&
      liveRoute.resourceId === target.resourceId &&
      liveRoute.toolName === target.toolName,
  );
}

export function catalogApprovalInnerArgs(catalog: {
  args: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const inner = catalog.args.arguments;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return undefined;
  return inner as Record<string, unknown>;
}

export function approvalPausedToolResult(): ApprovalPausedToolResult {
  return {
    kind: "agent_tool_result",
    content: [{ type: "text", text: APPROVAL_WAITING_TEXT }],
    details: { approval: "paused" },
    terminate: true,
  };
}

export function inputPausedToolResult(
  pausedFor: "ask" | "takeover",
  text: string,
): ApprovalPausedToolResult {
  return {
    kind: "agent_tool_result",
    content: [{ type: "text", text }],
    details: { [pausedFor]: "paused" },
    terminate: true,
  };
}

export function isToolPauseResult(result: unknown): result is ApprovalPausedToolResult {
  if (!result || typeof result !== "object") return false;
  const record = result as ApprovalPausedToolResult;
  if (record.kind !== "agent_tool_result") return false;
  const details = record.details;
  if (!details || typeof details !== "object") return false;
  const pause = details as Record<"approval" | "secret" | "ask" | "takeover", unknown>;
  return (
    pause.approval === "paused" ||
    pause.secret === "paused" ||
    pause.ask === "paused" ||
    pause.takeover === "paused"
  );
}

export function isFailedToolResult(value: unknown): value is { error: unknown } {
  if (!value || typeof value !== "object" || !("error" in value)) return false;
  const error = (value as { error?: unknown }).error;
  return error !== undefined && error !== null;
}

export function isApprovalPausedResult(result: unknown): result is ApprovalPausedToolResult {
  return isToolPauseResult(result);
}

export type DuplicateEffectGate =
  | { action: "execute" }
  | { action: "return"; result: unknown }
  | { action: "paused" }
  | { action: "uncertain"; toolName: string };

export type ExternalEffectStore = {
  externalEffect: {
    updateMany: (args: {
      where: { id: string; status: string };
      data: { status: string };
    }) => Promise<{ count: number }>;
  };
};

export const DRAFT_DISCARDED_RESULT = {
  ok: false,
  discarded: true,
  note: DRAFT_DISCARDED_NOTE,
} as const;

/** A cancelled card is a decision, not a failure: the bot is told once and must not retry. */
export const SPAWN_BOT_CANCELLED_RESULT = {
  ok: false,
  cancelled: true,
  note: "The user cancelled creating this bot. Do not call spawn_bot for it again unless they ask.",
} as const;

export function resolveDuplicateEffectGate(
  effect: { status: string; result?: unknown; kind?: string; draft?: unknown; request?: unknown },
  toolName: string,
): DuplicateEffectGate {
  if (effect.status === "completed") {
    return { action: "return", result: effect.result ?? { duplicate: true } };
  }
  if (effect.status === "denied") {
    const drafted = readDraft(effect.status, effect.draft);
    if (drafted?.state === "discarded") {
      return { action: "return", result: { ...DRAFT_DISCARDED_RESULT } };
    }
    // A send the run ended on may or may not have left.
    if (drafted?.state === "unsent") {
      return { action: "return", result: uncertainEffectResult(toolName) };
    }
    const replaced = replacedDraftResult(effect);
    if (replaced) return { action: "return", result: replaced };
    return {
      action: "return",
      result:
        (effect.kind && refusedProposalResult(effect.kind, effect.result)) ??
        (toolName === "spawn_bot"
          ? { ...SPAWN_BOT_CANCELLED_RESULT }
          : { error: "User denied this action." }),
    };
  }
  if (effect.status === "executing") {
    return { action: "uncertain", toolName };
  }
  if (effect.status === "uncertain") {
    return { action: "return", result: effect.result ?? uncertainEffectResult(toolName) };
  }
  if (effect.status === "approved") {
    return { action: "execute" };
  }
  if (effect.status === "intended") {
    return { action: "paused" };
  }
  return { action: "uncertain", toolName };
}

export type UncertainEffectResult = { error: string; uncertain: true };

export function uncertainEffectResult(toolName: string): UncertainEffectResult {
  return {
    error: `The earlier ${toolName} execution was interrupted, so its outcome is unknown. It was not replayed to avoid a duplicate side effect. Verify the destination before proposing another action.`,
    uncertain: true,
  };
}

export async function settleUncertainEffect(
  store: {
    externalEffect: {
      updateMany: (args: {
        where: { id: string; status: string };
        data: { status: string; result: UncertainEffectResult };
      }) => Promise<{ count: number }>;
      findUnique: (args: {
        where: { id: string };
      }) => Promise<{ status: string; result?: unknown } | null>;
    };
  },
  effectId: string,
  toolName: string,
): Promise<unknown> {
  const result = uncertainEffectResult(toolName);
  const settled = await store.externalEffect.updateMany({
    where: { id: effectId, status: "executing" },
    data: { status: "uncertain", result },
  });
  if (settled.count === 1) return result;

  const current = await store.externalEffect.findUnique({ where: { id: effectId } });
  if (!current) return result;
  const gate = resolveDuplicateEffectGate(current, toolName);
  return gate.action === "return" ? gate.result : result;
}

export async function claimApprovedEffect(
  store: ExternalEffectStore,
  effectId: string,
): Promise<boolean> {
  const claimed = await store.externalEffect.updateMany({
    where: { id: effectId, status: "approved" },
    data: { status: "executing" },
  });
  return claimed.count === 1;
}

export async function claimIntendedEffect(
  store: ExternalEffectStore,
  effectId: string,
): Promise<boolean> {
  const claimed = await store.externalEffect.updateMany({
    where: { id: effectId, status: "intended" },
    data: { status: "executing" },
  });
  return claimed.count === 1;
}

export async function completeExternalEffect(
  store: {
    externalEffect: {
      updateMany: (args: {
        where: { id: string; status: string };
        data: { status: string; result: never };
      }) => Promise<{ count: number }>;
    };
  },
  effectId: string,
  expectedStatus: "intended" | "executing" | "approved",
  result: unknown,
): Promise<boolean> {
  const completed = await store.externalEffect.updateMany({
    where: { id: effectId, status: expectedStatus },
    data: { status: "completed", result: result as never },
  });
  return completed.count === 1;
}

export async function replaceCompletedExternalEffectResult(
  store: {
    externalEffect: {
      updateMany: (args: {
        where: { id: string; status: string };
        data: { result: never };
      }) => Promise<{ count: number }>;
    };
  },
  effectId: string,
  result: unknown,
): Promise<boolean> {
  const replaced = await store.externalEffect.updateMany({
    where: { id: effectId, status: "completed" },
    data: { result: result as never },
  });
  return replaced.count === 1;
}
