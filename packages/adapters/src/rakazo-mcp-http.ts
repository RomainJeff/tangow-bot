import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ConnectorRoute } from "@rakazo/adapter-kit";
import { nativeMcpRelayHeaders } from "@rakazo/core";
import { nativeMcpToolsForRun } from "./native-mcp-tools.js";
import type { NativeSessionHost } from "./native-session-host.js";
import type { McpBridgeDeps, ResolvedBinding } from "./rakazo-mcp-bridge.js";
import type { NativeToolServer, RakazoMcpTool } from "./rakazo-mcp-server.js";
import { createRakazoMcpServer } from "./rakazo-mcp-server.js";

export { nativeMcpRelayHeaders } from "@rakazo/core";

export type NativeMcpRun = {
  runId: string;
  computerId: string;
  tools: ReadonlyArray<RakazoMcpTool>;
  executeTool(
    name: string,
    args: Record<string, unknown>,
    callId: string,
    route?: ConnectorRoute,
  ): Promise<unknown>;
  authorizeRight?: (binding: ResolvedBinding, toolName: string) => Promise<boolean>;
};

type ArmedTicket = NativeMcpRun & { ticket: string };
type TicketConnection = {
  server: ReturnType<typeof createRakazoMcpServer>;
  transport: StreamableHTTPServerTransport;
};

export type NativeMcpHttpServer = {
  issue(input: { botId: string; threadId: string; url: string }): Promise<NativeToolServer>;
  arm(ticket: string, run: NativeMcpRun): Promise<void>;
  disarm(ticket: string): Promise<void>;
  listen(port: number, host?: string): Promise<Server>;
  close(): Promise<void>;
};

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function equalsSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function bearer(request: IncomingMessage): string | undefined {
  const value = header(request, "authorization");
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? undefined : JSON.parse(text);
}

function status(response: ServerResponse, code: 400 | 401 | 403 | 404): void {
  response.writeHead(code, { "content-type": "application/json" });
  const errors = { 400: "bad request", 401: "unauthorized", 403: "forbidden", 404: "not found" };
  response.end(JSON.stringify({ error: errors[code] }));
}

/**
 * Worker-local Streamable HTTP entry point.  It keeps raw bearer tickets only
 * in this process; the durable host stores their SHA-256 digest and fences
 * every call against the armed run.
 */
export function createNativeMcpHttpServer(input: {
  host: NativeSessionHost;
  relaySecret: string;
  path?: string;
}): NativeMcpHttpServer {
  const path = input.path ?? "/native-mcp";
  const armed = new Map<string, ArmedTicket>();
  const connections = new Map<string, TicketConnection>();
  let http: Server | undefined;

  const release = async (ticket: string) => {
    armed.delete(ticket);
    const connection = connections.get(ticket);
    connections.delete(ticket);
    await connection?.server.close().catch(() => undefined);
  };

  const requestHandler = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url?.split("?", 1)[0] !== path) return status(response, 404);
    if (!equalsSecret(header(request, nativeMcpRelayHeaders.relaySecret), input.relaySecret))
      return status(response, 401);
    const ticket = bearer(request);
    if (!ticket) return status(response, 401);
    const run = armed.get(ticket);
    if (!run) return status(response, 401);
    if (header(request, nativeMcpRelayHeaders.sourceComputer) !== run.computerId)
      return status(response, 403);

    let connection = connections.get(ticket);
    if (!connection && header(request, "mcp-session-id")) {
      // release() retires the transport between turns, while the parked Codex
      // client retains its session ID. MCP 404 triggers its initialize handshake
      // without that header and retries the call under the newly armed run.
      // Authority and Computer placement have already been checked above.
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32001,
            message: "Session not found",
          },
        }),
      );
      return;
    }
    if (!connection) {
      const toolsByName = new Map(run.tools.map((tool) => [tool.name, tool]));
      const deps: McpBridgeDeps = {
        host: input.host,
        catalog: new Set(toolsByName.keys()),
        authorizeRight: run.authorizeRight,
        callTool: async (name, args, _binding, callId) => {
          const tool = toolsByName.get(name);
          if (!tool) throw new Error("tool_not_allowed");
          return run.executeTool(name, args, callId, tool.route);
        },
      };
      const server = createRakazoMcpServer(deps, { ticket, runId: run.runId, tools: run.tools });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
      await server.connect(transport);
      connection = { server, transport };
      connections.set(ticket, connection);
    }
    try {
      await connection.transport.handleRequest(request, response, await body(request));
    } catch {
      if (!response.headersSent) status(response, 400);
    }
  };

  return {
    async issue({ botId, threadId, url }) {
      await input.host.ensureBinding(botId, threadId);
      const { ticket } = await input.host.issueTicket(botId, threadId);
      return {
        endpoint: {
          url,
          httpHeaders: {
            Authorization: `Bearer ${ticket}`,
          },
        },
        ticket,
        async close() {
          await release(ticket);
          await input.host.revokeTicket(botId, threadId, ticket);
        },
      };
    },
    async arm(ticket, run) {
      const armedByHost = input.host.armTicket
        ? await input.host.armTicket(ticket, run.runId)
        : true;
      if (!armedByHost) throw new Error("native_mcp_ticket_not_current");
      await release(ticket);
      armed.set(ticket, { ...run, ticket, tools: nativeMcpToolsForRun(run.tools) });
    },
    async disarm(ticket) {
      await release(ticket);
      await input.host.disarmTicket?.(ticket);
    },
    async listen(port, host = "127.0.0.1") {
      if (http) return http;
      http = createServer((request, response) => void requestHandler(request, response));
      await new Promise<void>((resolve, reject) => {
        http!.once("error", reject);
        http!.listen(port, host, () => {
          http!.off("error", reject);
          resolve();
        });
      });
      return http;
    },
    async close() {
      await Promise.all([...armed.keys()].map((ticket) => release(ticket)));
      if (!http) return;
      await new Promise<void>((resolve, reject) =>
        http!.close((error) => (error ? reject(error) : resolve())),
      );
      http = undefined;
    },
  };
}
