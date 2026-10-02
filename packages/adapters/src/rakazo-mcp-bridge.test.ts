import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { NativeSessionHost, ReserveResult } from "./native-session-host.js";
import type { McpBridgeDeps } from "./rakazo-mcp-bridge.js";
import { callAuthorizedTool } from "./rakazo-mcp-bridge.js";

/**
 * Offline unit tests for the native specialist tool-call admission seam
 * added to `callAuthorizedTool` (`McpBridgeDeps.authorizeRight`). The Postgres-backed
 * ticket/generation guarantees of `NativeSessionHost` are covered elsewhere
 * (`rakazo-mcp-bridge.postgres.test.ts`); here the host is a deterministic in-memory fake,
 * same pattern as `rakazo-mcp-server.test.ts`, so this file isolates the rights-admission
 * concern from the ticket/reservation mechanics.
 */
function fakeHost(): NativeSessionHost {
  const bindings = new Map<string, { botId: string; threadId: string; generation: number }>();
  const activeTicket = new Map<string, string>();
  const seenCallIds = new Set<string>();
  const key = (botId: string, threadId: string) => `${botId}:${threadId}`;

  return {
    async ensureBinding(botId, threadId) {
      const k = key(botId, threadId);
      const existing = bindings.get(k);
      if (existing) return { generation: existing.generation };
      bindings.set(k, { botId, threadId, generation: 0 });
      return { generation: 0 };
    },
    async advanceGeneration(botId, threadId) {
      const k = key(botId, threadId);
      const binding = bindings.get(k);
      if (!binding) throw new Error(`No binding for ${botId}/${threadId}`);
      binding.generation += 1;
      activeTicket.delete(k);
      return { generation: binding.generation };
    },
    async revokeTicket(botId, threadId, ticket) {
      const k = key(botId, threadId);
      if (activeTicket.get(k) === ticket) activeTicket.delete(k);
    },
    async issueTicket(botId, threadId) {
      const k = key(botId, threadId);
      const binding = bindings.get(k);
      if (!binding) throw new Error(`No binding for ${botId}/${threadId}`);
      const ticket = randomUUID();
      activeTicket.set(k, ticket);
      return { ticket, generation: binding.generation };
    },
    async reserveCall(ticket, callId): Promise<ReserveResult> {
      const entry = [...bindings.values()].find(
        (b) => activeTicket.get(key(b.botId, b.threadId)) === ticket,
      );
      if (!entry) return { ok: false, reason: "stale_attempt" };
      const seenKey = `${ticket}:${callId}`;
      if (seenCallIds.has(seenKey)) return { ok: false, reason: "duplicate_call" };
      seenCallIds.add(seenKey);
      return {
        ok: true,
        botId: entry.botId,
        threadId: entry.threadId,
        generation: entry.generation,
      };
    },
  };
}

async function setUp(catalog: ReadonlySet<string>) {
  const host = fakeHost();
  const botId = "bot-native-1";
  const threadId = "thread-native-1";
  await host.ensureBinding(botId, threadId);
  const { ticket } = await host.issueTicket(botId, threadId);
  const callTool = vi.fn(async () => "ok");
  return { host, botId, threadId, ticket, callTool, catalog };
}

describe("callAuthorizedTool — native specialist admission beyond the closed catalog", () => {
  it("passes each authorized tool name to the shared callback", async () => {
    const { host, ticket, catalog } = await setUp(new Set(["search_docs", "write_note"]));
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({ name, args }));
    const deps: McpBridgeDeps = { host, callTool, catalog };

    await callAuthorizedTool(deps, {
      ticket,
      callId: "call-search",
      toolName: "search_docs",
      args: { query: "needle" },
    });
    await callAuthorizedTool(deps, {
      ticket,
      callId: "call-write",
      toolName: "write_note",
      args: { text: "kept" },
    });

    expect(callTool).toHaveBeenNthCalledWith(
      1,
      "search_docs",
      { query: "needle" },
      { botId: "bot-native-1", threadId: "thread-native-1", generation: 0 },
      "call-search",
    );
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      "write_note",
      { text: "kept" },
      { botId: "bot-native-1", threadId: "thread-native-1", generation: 0 },
      "call-write",
    );
  });

  it("admits a call when authorizeRight resolves true, passing the resolved binding through", async () => {
    const { host, ticket, callTool, catalog, botId, threadId } = await setUp(
      new Set(["search_docs"]),
    );
    const authorizeRight = vi.fn(async () => true);
    const deps: McpBridgeDeps = { host, callTool, catalog, authorizeRight };

    const outcome = await callAuthorizedTool(deps, {
      ticket,
      callId: "call-1",
      toolName: "search_docs",
      args: {},
    });

    expect(outcome).toEqual({ ok: true, result: "ok" });
    expect(authorizeRight).toHaveBeenCalledWith({ botId, threadId, generation: 0 }, "search_docs");
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("refuses a call in the closed catalog whose right is not currently effective, and never invokes the callback", async () => {
    const { host, ticket, callTool, catalog } = await setUp(new Set(["delete_db"]));
    const authorizeRight = vi.fn(async () => false);
    const deps: McpBridgeDeps = { host, callTool, catalog, authorizeRight };

    const outcome = await callAuthorizedTool(deps, {
      ticket,
      callId: "call-1",
      toolName: "delete_db",
      args: {},
    });

    expect(outcome).toEqual({ ok: false, error: "tool_not_allowed" });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("recomputes admission on every call — a right effective on the first call can be refused on the second, without the static catalog changing", async () => {
    const { host, ticket, callTool, catalog } = await setUp(new Set(["search_docs"]));
    let allowed = true;
    const authorizeRight = vi.fn(async () => allowed);
    const deps: McpBridgeDeps = { host, callTool, catalog, authorizeRight };

    const first = await callAuthorizedTool(deps, {
      ticket,
      callId: "call-1",
      toolName: "search_docs",
      args: {},
    });
    expect(first.ok).toBe(true);

    // Simulates a revocation that happened between the two calls (a concurrent
    // revocation), even though `catalog` — fixed at construction — never changes.
    allowed = false;
    const second = await callAuthorizedTool(deps, {
      ticket,
      callId: "call-2",
      toolName: "search_docs",
      args: {},
    });
    expect(second).toEqual({ ok: false, error: "tool_not_allowed" });
    expect(authorizeRight).toHaveBeenCalledTimes(2);
  });

  it("omitting authorizeRight admits anything in the closed catalog is admitted", async () => {
    const { host, ticket, callTool, catalog } = await setUp(new Set(["search_docs"]));
    const deps: McpBridgeDeps = { host, callTool, catalog };

    const outcome = await callAuthorizedTool(deps, {
      ticket,
      callId: "call-1",
      toolName: "search_docs",
      args: {},
    });

    expect(outcome).toEqual({ ok: true, result: "ok" });
  });

  it("still refuses a tool outside the closed catalog before ever consulting authorizeRight", async () => {
    const { host, ticket, callTool, catalog } = await setUp(new Set(["search_docs"]));
    const authorizeRight = vi.fn(async () => true);
    const deps: McpBridgeDeps = { host, callTool, catalog, authorizeRight };

    const outcome = await callAuthorizedTool(deps, {
      ticket,
      callId: "call-1",
      toolName: "not_in_catalog",
      args: {},
    });

    expect(outcome).toEqual({ ok: false, error: "tool_not_allowed" });
    expect(authorizeRight).not.toHaveBeenCalled();
  });
});
