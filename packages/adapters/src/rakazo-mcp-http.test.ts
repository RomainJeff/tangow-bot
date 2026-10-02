import type {
  AdapterContext,
  AgentRunRequest,
  NativeProcessRequest,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ClaudeNativeRuntime } from "./claude-native-runtime.js";
import { CodexNativeRuntime } from "./computer-native-runtime.js";
import type { NativeSessionHost, ReserveResult } from "./native-session-host.js";
import { createNativeMcpHttpServer, nativeMcpRelayHeaders } from "./rakazo-mcp-http.js";

function host(): NativeSessionHost {
  let active = "";
  return {
    ensureBinding: async () => ({ generation: 0 }),
    advanceGeneration: async () => ({ generation: 1 }),
    issueTicket: async () => {
      active = "ticket-for-test";
      return { ticket: active, generation: 0 };
    },
    revokeTicket: async () => undefined,
    armTicket: async (ticket) => ticket === active,
    disarmTicket: async () => undefined,
    reserveCall: async (ticket, callId): Promise<ReserveResult> =>
      ticket === active && callId
        ? { ok: true, botId: "bot-1", threadId: "thread-1", generation: 0 }
        : { ok: false, reason: "stale_attempt" },
  };
}

async function post(url: string, headers: Record<string, string>, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function mcpJson(response: Response) {
  const text = await response.text();
  return JSON.parse(text.startsWith("event:") ? (text.match(/^data: (.+)$/m)?.[1] ?? "{}") : text);
}

describe("native MCP Streamable HTTP", () => {
  it("reinitializes expired MCP sessions on a second Codex turn in the same parked app-server", async () => {
    const service = createNativeMcpHttpServer({ host: host(), relaySecret: "relay-secret" });
    const listener = await service.listen(0);
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("expected TCP listener");
    const url = `http://127.0.0.1:${address.port}/native-mcp`;
    const tool = await service.issue({ botId: "bot-1", threadId: "thread-1", url });
    if (!("url" in tool.endpoint)) throw new Error("expected HTTP endpoint");
    const auth = {
      ...tool.endpoint.httpHeaders,
      [nativeMcpRelayHeaders.relaySecret]: "relay-secret",
      [nativeMcpRelayHeaders.sourceComputer]: "computer-1",
    };
    let session = "";
    let recoveries = 0;
    const effects: string[] = [];
    const writes: Array<{ method?: string; params?: unknown }> = [];
    const initialize = async () => {
      const response = await post(url, auth, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fake-codex-app-server", version: "1" },
        },
      });
      expect(response.status).toBe(200);
      session = response.headers.get("mcp-session-id")!;
      expect(session).toBeTruthy();
      await response.text();
      const ready = await post(
        url,
        { ...auth, "mcp-session-id": session },
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        },
      );
      expect(ready.status).toBe(202);
    };
    const call = async () => {
      // Codex 0.154.0 uses rmcp 3.2.0: on HTTP 404 it repeats initialize without
      // a session header, sends initialized, and retries the ordinary POST once.
      const body = {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "save_note", arguments: {} },
      };
      let response = await post(url, { ...auth, "mcp-session-id": session }, body);
      if (response.status === 404) {
        await response.text();
        recoveries += 1;
        await initialize();
        response = await post(url, { ...auth, "mcp-session-id": session }, body);
      }
      expect(response.status).toBe(200);
      expect(await mcpJson(response)).toMatchObject({
        result: { content: [{ text: expect.stringContaining("saved") }] },
      });
    };
    const startNativeProcess = vi.fn(async () => ({
      id: "parked-app-server",
      write: async (data: string) => {
        writes.push(JSON.parse(data));
      },
      stdout: (async function* () {
        yield '{"id":1,"result":{}}';
        yield '{"id":2,"result":{}}';
        await initialize();
        yield '{"method":"mcpServer/startupStatus/updated","params":{"name":"rakazo","status":"ready"}}';
        yield '{"id":3,"result":{"thread":{"id":"native-thread"}}}';
        yield '{"id":4,"result":{}}';
        await call();
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}';
        yield '{"id":5,"result":{}}';
        await call();
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped" as const,
    }));
    const runtime = new CodexNativeRuntime(
      {
        sandbox: { startNativeProcess } as unknown as SandboxProvider,
        computer: { id: "computer-1", providerRef: "computer-1", botId: "bot-1", kind: "docker" },
        cwd: ".",
      },
      {
        toolServer: async () => ({
          ...tool,
          arm: async (request) =>
            service.arm(tool.ticket, {
              runId: request.runId,
              computerId: "computer-1",
              tools: request.tools,
              executeTool: async () => {
                effects.push(request.runId);
                return { saved: request.runId };
              },
            }),
          disarm: async () => service.disarm(tool.ticket),
        }),
      },
    );
    const request: AgentRunRequest = {
      runId: "first",
      botId: "bot-1",
      threadId: "thread-1",
      prompt: "save",
      instructions: "",
      history: [],
      tools: [
        { name: "save_note", description: "Save", inputSchema: { type: "object", properties: {} } },
      ],
      model: {
        provider: "openai-codex",
        id: "fixture-model",
        oauth: {
          credential: {
            type: "oauth",
            access: "fake-access",
            refresh: "",
            expires: 0,
            accountId: "fixture-account",
          },
        },
      },
      execution: {
        choice: { harness: "codex-native", targetId: "computer-1" },
        authority: { runId: "first", attemptId: "first", fence: 1, policyRevision: 1 },
        continuity: { mode: "new", ref: { bindingId: "rearm-binding", generation: 0 } },
        computerId: "computer-1",
      },
    };
    const context: AdapterContext = {
      operationId: "rearm",
      traceId: "rearm",
      spaceId: "space",
      userId: "user",
      botId: "bot-1",
      signal: new AbortController().signal,
    };
    try {
      const first = [];
      for await (const event of runtime.run(request, context)) first.push(event);
      expect(first).toContainEqual({ type: "done" });
      const firstSession = session;
      const between = await post(
        url,
        { ...auth, "mcp-session-id": session },
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "save_note", arguments: {} },
        },
      );
      expect(between.status).toBe(401);
      await between.text();
      const second = [];
      for await (const event of runtime.run(
        {
          ...request,
          runId: "second",
          execution: {
            ...request.execution!,
            authority: { ...request.execution!.authority, runId: "second", attemptId: "second" },
            continuity: {
              mode: "resume",
              ref: { bindingId: "rearm-binding", generation: 0 },
              inputId: "second",
            },
          },
        },
        context,
      ))
        second.push(event);
      expect(second).toContainEqual({ type: "done" });
      expect(effects).toEqual(["first", "second"]);
      expect(recoveries).toBe(1);
      expect(session).not.toBe(firstSession);
      expect(startNativeProcess).toHaveBeenCalledOnce();
      expect(writes.filter((write) => write.method === "turn/start")).toHaveLength(2);
    } finally {
      await runtime.abort("first");
      await runtime.abort("second");
      await service.close();
    }
  });

  it.each(["claude-native", "codex-native"] as const)(
    "keeps the relay secret out of %s private configuration",
    async (harness) => {
      const service = createNativeMcpHttpServer({
        host: host(),
        relaySecret: "supervisor-only-secret",
      });
      const tool = await service.issue({
        botId: "bot-1",
        threadId: "thread-1",
        url: "http://rakazo-mcp/native-mcp",
      });
      const start = vi.fn(async (_computer: unknown, _request: NativeProcessRequest) => {
        throw new Error("captured configuration");
      });
      const placement = {
        sandbox: { startNativeProcess: start } as unknown as SandboxProvider,
        computer: {
          id: "computer",
          providerRef: "computer",
          botId: "bot-1",
          kind: "docker" as const,
        },
        cwd: ".",
      };
      const options = { toolServer: async () => tool };
      const runtime =
        harness === "claude-native"
          ? new ClaudeNativeRuntime(placement, options)
          : new CodexNativeRuntime(placement, options);
      const request: AgentRunRequest = {
        runId: "config",
        botId: "bot-1",
        threadId: "thread-1",
        prompt: "hello",
        instructions: "",
        history: [],
        tools: [],
        model: {
          provider: harness === "claude-native" ? "anthropic" : "openai-codex",
          id: "fixture-model",
          oauth: {
            credential: {
              type: "oauth",
              access: "fixture-access",
              refresh: "",
              expires: 0,
              accountId: "fixture-account",
            },
            refresh: async (value) => value,
          },
        },
        execution: {
          choice: { harness, targetId: "computer" },
          authority: { runId: "config", attemptId: "attempt", fence: 1, policyRevision: 1 },
          continuity: { mode: "new" },
          computerId: "computer",
        },
      };
      const context: AdapterContext = {
        operationId: "config",
        traceId: "config",
        spaceId: "space",
        userId: "user",
        botId: "bot-1",
        signal: new AbortController().signal,
      };
      try {
        await expect(
          (async () => {
            for await (const _event of runtime.run(request, context)) undefined;
          })(),
        ).rejects.toThrow("captured configuration");
        const files = start.mock.calls[0]![1].files!;
        expect(JSON.stringify(files)).not.toContain("supervisor-only-secret");
        expect(JSON.stringify(files)).not.toContain("x-rakazo-relay-secret");
        expect(files[0]!.content).toContain("http://rakazo-mcp/native-mcp");
        expect(files[0]!.content).toContain(`Bearer ${tool.ticket}`);
        expect(tool.endpoint).toEqual({
          url: "http://rakazo-mcp/native-mcp",
          httpHeaders: { Authorization: `Bearer ${tool.ticket}` },
        });
      } finally {
        await service.close();
      }
    },
  );

  it("rejects a worker request with a valid bearer and placement but no relay secret", async () => {
    const service = createNativeMcpHttpServer({ host: host(), relaySecret: "relay-secret" });
    const server = await service.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP listener");
      const url = `http://127.0.0.1:${address.port}/native-mcp`;
      const tool = await service.issue({ botId: "bot-1", threadId: "thread-1", url });
      await service.arm(tool.ticket, {
        runId: "run-1",
        computerId: "computer-1",
        tools: [],
        executeTool: async () => ({}),
      });
      await expect(
        post(
          url,
          {
            Authorization: `Bearer ${tool.ticket}`,
            [nativeMcpRelayHeaders.sourceComputer]: "computer-1",
          },
          { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        ),
      ).resolves.toMatchObject({ status: 401 });
    } finally {
      await service.close();
    }
  });

  it.each(["shell", "run_subagent"])(
    "never lists or executes denied native tool %s",
    async (denied) => {
      const executeTool = vi.fn(async () => ({ executed: true }));
      const service = createNativeMcpHttpServer({ host: host(), relaySecret: "relay-secret" });
      const server = await service.listen(0);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP listener");
      const url = `http://127.0.0.1:${address.port}/native-mcp`;
      const tool = await service.issue({ botId: "bot-1", threadId: "thread-1", url });
      await service.arm(tool.ticket, {
        runId: "run-1",
        computerId: "computer-1",
        tools: [
          {
            name: denied,
            description: "Run a shell command",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "save_note",
            description: "Save a note",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        executeTool,
      });
      const auth = {
        Authorization: `Bearer ${tool.ticket}`,
        [nativeMcpRelayHeaders.relaySecret]: "relay-secret",
        [nativeMcpRelayHeaders.sourceComputer]: "computer-1",
      };
      const initialize = await post(url, auth, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      });
      const session = initialize.headers.get("mcp-session-id");
      expect(session).toBeTruthy();

      const list = await post(
        url,
        { ...auth, "mcp-session-id": session! },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      );
      await expect(mcpJson(list)).resolves.toMatchObject({
        result: { tools: [{ name: "save_note" }] },
      });

      const call = await post(
        url,
        { ...auth, "mcp-session-id": session! },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: denied, arguments: {} },
        },
      );
      await expect(mcpJson(call)).resolves.toMatchObject({
        result: { isError: true, content: [{ text: "tool_not_allowed" }] },
      });
      expect(executeTool).not.toHaveBeenCalled();
      await service.close();
    },
  );

  it("requires both relay proof and placement, exposes real schemas, and routes the armed call", async () => {
    const executeTool = vi.fn(async () => ({ saved: true }));
    const service = createNativeMcpHttpServer({ host: host(), relaySecret: "relay-secret" });
    const server = await service.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP listener");
    const url = `http://127.0.0.1:${address.port}/native-mcp`;
    const tool = await service.issue({ botId: "bot-1", threadId: "thread-1", url });
    await service.arm(tool.ticket, {
      runId: "run-1",
      computerId: "computer-1",
      tools: [
        {
          name: "save_note",
          description: "Save a note",
          inputSchema: {
            type: "object",
            required: ["text"],
            properties: { text: { type: "string" } },
          },
          route: { connectorId: "connector-1", toolName: "save_note" },
        },
      ],
      executeTool,
    });
    const auth = {
      Authorization: `Bearer ${tool.ticket}`,
      [nativeMcpRelayHeaders.relaySecret]: "relay-secret",
      [nativeMcpRelayHeaders.sourceComputer]: "computer-1",
    };

    await expect(
      post(url, {}, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      post(
        url,
        { ...auth, [nativeMcpRelayHeaders.sourceComputer]: "computer-2" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ),
    ).resolves.toMatchObject({ status: 403 });

    const initialize = await post(url, auth, {
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    expect(initialize.status).toBe(200);
    const session = initialize.headers.get("mcp-session-id");
    expect(session).toBeTruthy();
    const list = await post(
      url,
      { ...auth, "mcp-session-id": session! },
      { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
    );
    await expect(mcpJson(list)).resolves.toMatchObject({
      result: { tools: [{ name: "save_note", inputSchema: { required: ["text"] } }] },
    });

    // Re-provisioning preserves the database Computer but changes Docker inspect().Id.
    // Even an established MCP session cannot reuse the old ticket from that container.
    await expect(
      post(
        url,
        {
          ...auth,
          "mcp-session-id": session!,
          [nativeMcpRelayHeaders.sourceComputer]: "replacement-container",
        },
        {
          jsonrpc: "2.0",
          id: 50,
          method: "tools/call",
          params: { name: "save_note", arguments: { text: "denied" } },
        },
      ),
    ).resolves.toMatchObject({ status: 403 });
    expect(executeTool).not.toHaveBeenCalled();

    const call = await post(
      url,
      { ...auth, "mcp-session-id": session! },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "save_note", arguments: { text: "kept", botId: "forged" } },
      },
    );
    await expect(mcpJson(call)).resolves.toMatchObject({
      result: { content: [{ text: '{"saved":true}' }] },
    });
    expect(executeTool).toHaveBeenCalledWith(
      "save_note",
      { text: "kept", botId: "forged" },
      expect.any(String),
      { connectorId: "connector-1", toolName: "save_note" },
    );
    await service.disarm(tool.ticket);
    await expect(
      post(url, auth, { jsonrpc: "2.0", id: 6, method: "tools/list" }),
    ).resolves.toMatchObject({ status: 401 });
    await service.close();
  });
});
