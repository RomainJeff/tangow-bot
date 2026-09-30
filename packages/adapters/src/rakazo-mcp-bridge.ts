import type { NativeSessionHost } from "./native-session-host.js";

/**
 * T02 MCP bridge: route an authorized MCP tool call for a turn authorization
 * (opaque ticket bound to a binding + generation by the session host, never
 * an identity carried in the call's own arguments) to the existing execution
 * callback, and refuse a stale or replayed call without ever invoking it.
 */
export type ResolvedBinding = { botId: string; threadId: string; generation: number };

/**
 * The callback only ever receives the identity `reserveCall` resolved from
 * the ticket (`binding`), never anything the caller could have put in its
 * own `args`. A callback that keys its resource by identity must use
 * `binding`, not `args`: an identity forged in `args` is then structurally
 * unable to affect any resource but the ticket's own binding (S3 admission
 * sécurité, `contrats-tdd/T02.md:39`).
 */
export type McpToolCallback = (
  name: string,
  args: Record<string, unknown>,
  binding: ResolvedBinding,
  callId: string,
) => Promise<unknown>;

export type McpAuthorizedCall = {
  ticket: string;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
};

export type McpCallResult =
  | { ok: true; result: unknown }
  | { ok: false; error: "stale_attempt" | "duplicate_call" | "tool_not_allowed" };

export interface McpBridgeDeps {
  host: NativeSessionHost;
  callTool: McpToolCallback;
  /** Closed set of tool names admitted for this binding (S3 "catalogue autorisé"). */
  catalog: ReadonlySet<string>;
  /**
   * T07:4 (Q12, admission point 3): re-checked on *every* call, unlike `catalog` above which
   * is fixed once at server-construction time and so cannot see a right revoked mid-session
   * (a parked specialist is the case that matters — Q12's "révocation concurrente"). Receives
   * the identity `reserveCall` just resolved (never anything from `call.args`). Omitted
   * entirely, a caller keeps the pre-T07:4 behavior of admitting anything in `catalog`
   * (non-regression for callers that do not yet supply one, e.g. `rakazo-mcp-server.test.ts`).
   */
  authorizeRight?: (binding: ResolvedBinding, toolName: string) => Promise<boolean>;
}

export async function callAuthorizedTool(
  deps: McpBridgeDeps,
  call: McpAuthorizedCall,
): Promise<McpCallResult> {
  // Checked before any ticket/DB resolution: a tool outside the catalog is
  // refused without ever touching the reservation ledger or the callback.
  if (!deps.catalog.has(call.toolName)) {
    return { ok: false, error: "tool_not_allowed" };
  }
  const reservation = await deps.host.reserveCall(call.ticket, call.callId, call.toolName);
  if (!reservation.ok) {
    return { ok: false, error: reservation.reason };
  }
  const binding: ResolvedBinding = {
    botId: reservation.botId,
    threadId: reservation.threadId,
    generation: reservation.generation,
  };
  // T07:4 point 3: admission "au plus près de l'admission réelle" — after the reservation
  // resolved a real, non-forgeable binding, before the callback ever runs.
  //
  // T07:4 correction (Terra review): admission is the declared linearization point for this
  // call. A call that is admitted here runs to completion even if a revocation commits
  // between this check and `callTool` returning below — this is a deliberate, documented
  // choice, not an unguarded race: `authorizeRight` re-reads live state on every call (never
  // cached), so the *next* call always observes the revocation. Closing that one narrower
  // window (revoke-during-an-in-flight-call) would require holding a lock or a lease across
  // the callback's entire execution, which no seam here does today; left as backlog, not
  // silently assumed away.
  if (deps.authorizeRight && !(await deps.authorizeRight(binding, call.toolName))) {
    return { ok: false, error: "tool_not_allowed" };
  }
  const result = await deps.callTool(call.toolName, call.args, binding, call.callId);
  return { ok: true, result };
}
