import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { NativeSessionHost, ReserveResult } from "./native-session-host.js";
import type { ResolvedBinding } from "./rakazo-mcp-bridge.js";
import {
  createNativeToolServer,
  createRakazoMcpServer,
  deriveCallId,
} from "./rakazo-mcp-server.js";

/**
 * A real MCP `Client` (SDK) drives these tests over a real `Transport` pair
 * (`InMemoryTransport.createLinkedPair`) against the real `McpServer`
 * produced by `createRakazoMcpServer`. The mechanism under test — ticket
 * authorization, catalog enforcement, replay refusal — is never mocked.
 * The Postgres-backed guarantees of `NativeSessionHost` itself (generation
 * TOCTOU, real transactions) are covered by
 * `rakazo-mcp-bridge.postgres.test.ts`; here the host is a deterministic
 * in-memory fake so this file isolates the MCP wiring/catalog concern.
 */
function fakeHost(): NativeSessionHost {
  const bindings = new Map<string, { botId: string; threadId: string; generation: number }>();
  const activeTicket = new Map<string, string>(); // bindingKey -> ticket
  const seenCallIds = new Set<string>(); // `${ticket}:${callId}`

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
    async reserveCall(ticket, callId, _toolName, hooks): Promise<ReserveResult> {
      const entry = [...bindings.values()].find(
        (b) => activeTicket.get(key(b.botId, b.threadId)) === ticket,
      );
      if (!entry) return { ok: false, reason: "stale_attempt" };
      await hooks?.afterLock?.();
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

async function connectedClient(server: ReturnType<typeof createRakazoMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t02-test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("Rakazo internal MCP server (T02 S3)", () => {
  it("separates a reconnected MCP session in the same run while retaining retransmission identity", () => {
    const retransmission = deriveCallId("ticket", "run-1", "mcp-session-1", 42);
    expect(deriveCallId("ticket", "run-1", "mcp-session-1", 42)).toBe(retransmission);
    expect(deriveCallId("ticket", "run-1", "mcp-session-2", 42)).not.toBe(retransmission);
    expect(deriveCallId("ticket", "run-2", "mcp-session-1", 42)).not.toBe(retransmission);
  });

  it("routes an authorized catalog tool call from a real MCP client through the callback, with no ticket or callId in the tool input", async () => {
    const host = fakeHost();
    const resource = { writes: 0 };
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket } = await host.issueTicket(botId, threadId);

    const server = createRakazoMcpServer(
      {
        host,
        catalog: new Set(["resource.write"]),
        callTool: async (_name, args) => {
          resource.writes += 1;
          return { applied: args.value };
        },
      },
      { ticket },
    );
    const client = await connectedClient(server);

    // The tool's input carries only business args: no ticket, no callId.
    // The server injects both itself.
    const result = await client.callTool({
      name: "resource.write",
      arguments: { args: { value: "hello" } },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ applied: "hello" }) }]);
    expect(resource.writes).toBe(1);
  });

  it("refuses a stale ticket bound to this server instance, and a tool outside the catalog, without ever calling the callback", async () => {
    const host = fakeHost();
    const resource = { writes: 0 };
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket } = await host.issueTicket(botId, threadId);
    await host.advanceGeneration(botId, threadId); // retires the ticket immediately

    const server = createRakazoMcpServer(
      {
        host,
        catalog: new Set(["resource.write"]),
        callTool: async (_name, args) => {
          resource.writes += 1;
          return { applied: args.value };
        },
      },
      { ticket },
    );
    const client = await connectedClient(server);

    const staleResult = await client.callTool({
      name: "resource.write",
      arguments: { args: { value: "hello" } },
    });
    expect(staleResult.isError).toBe(true);
    expect(staleResult.content).toEqual([{ type: "text", text: "stale_attempt" }]);

    // A tool outside the catalog was never registered on the server: the
    // real MCP client gets the SDK's own protocol-level "tool not found"
    // refusal, before this module's ticket/replay authorization would even
    // run.
    const outOfCatalog = await client.callTool({
      name: "resource.delete",
      arguments: { args: {} },
    });
    expect(outOfCatalog.isError).toBe(true);
    const outOfCatalogText = (outOfCatalog.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(outOfCatalogText).toMatch(/not found/i);

    expect(resource.writes).toBe(0);
  });

  it("gives two distinct real calls two distinct server-generated callIds and two distinct effects", async () => {
    const host = fakeHost();
    const resource = { writes: 0 };
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket } = await host.issueTicket(botId, threadId);

    const server = createRakazoMcpServer(
      {
        host,
        catalog: new Set(["resource.write"]),
        callTool: async (_name, args) => {
          resource.writes += 1;
          return { applied: args.value };
        },
      },
      { ticket },
    );
    const client = await connectedClient(server);

    const first = await client.callTool({
      name: "resource.write",
      arguments: { args: { value: "hello" } },
    });
    const second = await client.callTool({
      name: "resource.write",
      arguments: { args: { value: "hello-again" } },
    });

    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    expect(resource.writes).toBe(2);
  });

  it("cannot be made to provoke duplicate_call against itself: the tool input never carries a callId to preempt", async () => {
    const host = fakeHost();
    const resource = { writes: 0 };
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket } = await host.issueTicket(botId, threadId);

    const server = createRakazoMcpServer(
      {
        host,
        catalog: new Set(["resource.write"]),
        callTool: async (_name, args) => {
          resource.writes += 1;
          return { applied: args.value };
        },
      },
      { ticket },
    );
    const client = await connectedClient(server);

    // Two concurrent connections/calls against the same ticket: without a
    // client-suppliable callId, neither can preempt the other's server-
    // generated id, so neither is refused as duplicate_call.
    const [a, b] = await Promise.all([
      client.callTool({ name: "resource.write", arguments: { args: { value: "a" } } }),
      client.callTool({ name: "resource.write", arguments: { args: { value: "b" } } }),
    ]);

    expect(a.isError).not.toBe(true);
    expect(b.isError).not.toBe(true);
    expect(resource.writes).toBe(2);
  });

  it("treats the same JSON-RPC request id retransmitted as a single operation, and two distinct ids as two effects", async () => {
    const host = fakeHost();
    const resource = { writes: 0 };
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket } = await host.issueTicket(botId, threadId);

    const server = createRakazoMcpServer(
      {
        host,
        catalog: new Set(["resource.write"]),
        callTool: async (_name, args) => {
          resource.writes += 1;
          return { applied: args.value };
        },
      },
      { ticket },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const responses = new Map<string | number, unknown>();
    clientTransport.onmessage = (message) => {
      if ("id" in message && message.id !== undefined) responses.set(message.id, message);
    };
    await clientTransport.start();

    const callToolRequest = (id: string, value: string) => ({
      jsonrpc: "2.0" as const,
      id,
      method: "tools/call",
      params: { name: "resource.write", arguments: { args: { value } } },
    });

    const waitFor = async (id: string) => {
      const deadline = Date.now() + 2_000;
      while (!responses.has(id)) {
        if (Date.now() > deadline) throw new Error(`no response for request id ${id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return responses.get(id);
    };

    // The exact same JSON-RPC request id, sent twice: a retransmission at the
    // transport level, not two calls the model made. The response map entry
    // is cleared before each send so `waitFor` observes this send's own
    // response, never a stale one left over from the first.
    await clientTransport.send(callToolRequest("retransmit-1", "hello"));
    const first = await waitFor("retransmit-1");
    responses.delete("retransmit-1");
    await clientTransport.send(callToolRequest("retransmit-1", "hello"));
    const replay = await waitFor("retransmit-1");

    expect((first as { result: { isError?: boolean } }).result.isError).not.toBe(true);
    // Vitest's deep-equal on the exact same response object from the map
    // would be trivially true; assert on the observable effect instead.
    expect(resource.writes).toBe(1);
    expect(
      (replay as { result: { isError?: boolean; content: Array<{ text: string }> } }).result,
    ).toMatchObject({ isError: true, content: [{ text: "duplicate_call" }] });

    // A distinct JSON-RPC id is a genuinely distinct call: a second effect.
    await clientTransport.send(callToolRequest("distinct-2", "world"));
    await waitFor("distinct-2");
    expect(resource.writes).toBe(2);

    await clientTransport.close();
  });

  it("gives a numeric JSON-RPC id and its string look-alike two distinct callIds and two effects, but collapses a real replay of the numeric id to one", async () => {
    const host = fakeHost();
    const resource = { writes: 0 };
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket } = await host.issueTicket(botId, threadId);

    const server = createRakazoMcpServer(
      {
        host,
        catalog: new Set(["resource.write"]),
        callTool: async (_name, args) => {
          resource.writes += 1;
          return { applied: args.value };
        },
      },
      { ticket },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const responses: unknown[] = [];
    clientTransport.onmessage = (message) => {
      if ("id" in message && message.id !== undefined) responses.push(message);
    };
    await clientTransport.start();

    const callToolRequest = (id: string | number, value: string) => ({
      jsonrpc: "2.0" as const,
      id,
      method: "tools/call",
      params: { name: "resource.write", arguments: { args: { value } } },
    });

    const waitForCount = async (count: number) => {
      const deadline = Date.now() + 2_000;
      while (responses.length < count) {
        if (Date.now() > deadline)
          throw new Error(`only ${responses.length} of ${count} responses`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    // The numeric id `1` and the string id `"1"` are two distinct JSON-RPC
    // requests (raw send, at the transport level): a hash that concatenates
    // ticket and id without their type would confuse them into one callId.
    await clientTransport.send(callToolRequest(1, "numeric"));
    await waitForCount(1);
    await clientTransport.send(callToolRequest("1", "string"));
    await waitForCount(2);
    expect(resource.writes).toBe(2);

    // A genuine replay of the numeric id `1` is still collapsed to the same
    // callId as its first send, and refused as duplicate_call.
    await clientTransport.send(callToolRequest(1, "numeric-replay"));
    await waitForCount(3);
    expect(resource.writes).toBe(2);
    const replay = responses[2] as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(replay.result).toMatchObject({ isError: true, content: [{ text: "duplicate_call" }] });

    await clientTransport.close();
  });

  it("ignores an identity forged in the tool's own business arguments: the effect lands only on the ticket's real binding", async () => {
    const host = fakeHost();
    const writesByBot = new Map<string, number>();
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    const forgedBotId = `bot-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket } = await host.issueTicket(botId, threadId);

    const server = createRakazoMcpServer(
      {
        host,
        catalog: new Set(["resource.write"]),
        callTool: async (_name, args, binding: ResolvedBinding) => {
          writesByBot.set(binding.botId, (writesByBot.get(binding.botId) ?? 0) + 1);
          return { applied: args.value };
        },
      },
      { ticket },
    );
    const client = await connectedClient(server);

    const result = await client.callTool({
      name: "resource.write",
      arguments: { args: { value: "hello", botId: forgedBotId } },
    });

    expect(result.isError).not.toBe(true);
    expect(writesByBot.get(botId)).toBe(1);
    expect(writesByBot.get(forgedBotId)).toBeUndefined();
  });
});

describe("createNativeToolServer (T01 composition seam)", () => {
  it("issues a ticket via the session host and describes a stdio endpoint that injects it through the environment, never a tool argument", async () => {
    const host = fakeHost();
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;

    const nativeToolServer = await createNativeToolServer(host, {
      botId,
      threadId,
      command: "node",
      stdioEntryPointPath: "/fixture/rakazo-mcp-stdio.js",
    });

    if ("url" in nativeToolServer.endpoint) throw new Error("expected legacy stdio endpoint");
    expect(nativeToolServer.endpoint.command).toBe("node");
    expect(nativeToolServer.endpoint.args).toEqual(["/fixture/rakazo-mcp-stdio.js"]);
    expect(nativeToolServer.endpoint.env).toEqual({ RAKAZO_MCP_TICKET: nativeToolServer.ticket });
    expect(typeof nativeToolServer.ticket).toBe("string");
    expect(nativeToolServer.ticket.length).toBeGreaterThan(0);
  });

  it("close() revokes only this ticket, refusing it as stale without advancing the generation or touching another attempt's ticket", async () => {
    const host = fakeHost();
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;

    const nativeToolServer = await createNativeToolServer(host, {
      botId,
      threadId,
      stdioEntryPointPath: "/fixture/rakazo-mcp-stdio.js",
    });
    const generationBeforeClose = (await host.ensureBinding(botId, threadId)).generation;

    const resource = { writes: 0 };
    const server = createRakazoMcpServer(
      {
        host,
        catalog: new Set(["resource.write"]),
        callTool: async (_name, args) => {
          resource.writes += 1;
          return { applied: args.value };
        },
      },
      { ticket: nativeToolServer.ticket },
    );
    const client = await connectedClient(server);

    await nativeToolServer.close();

    const result = await client.callTool({
      name: "resource.write",
      arguments: { args: { value: "hello" } },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "stale_attempt" }]);
    expect(resource.writes).toBe(0);

    // Routine close() is not an invalidation: the generation this attempt
    // held is unchanged.
    const generationAfterClose = (await host.ensureBinding(botId, threadId)).generation;
    expect(generationAfterClose).toBe(generationBeforeClose);
  });

  it("close() does not affect a ticket issued by a later attempt on the same binding", async () => {
    const host = fakeHost();
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;

    const firstAttempt = await createNativeToolServer(host, {
      botId,
      threadId,
      stdioEntryPointPath: "/fixture/rakazo-mcp-stdio.js",
    });
    // A later attempt on the same binding re-issues a ticket (e.g. after
    // advanceGeneration), superseding the first attempt's ticket.
    await host.advanceGeneration(botId, threadId);
    const { ticket: laterTicket } = await host.issueTicket(botId, threadId);

    await firstAttempt.close();

    const resource = { writes: 0 };
    const server = createRakazoMcpServer(
      {
        host,
        catalog: new Set(["resource.write"]),
        callTool: async (_name, args) => {
          resource.writes += 1;
          return { applied: args.value };
        },
      },
      { ticket: laterTicket },
    );
    const client = await connectedClient(server);

    const result = await client.callTool({
      name: "resource.write",
      arguments: { args: { value: "hello" } },
    });
    expect(result.isError).not.toBe(true);
    expect(resource.writes).toBe(1);
  });
});
