import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GuestTool } from "@rakazo/adapter-kit";
import type { HarnessHost } from "./harness.js";

type JsonRpcId = string | number;
type JsonRpcMessage =
  | { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

/** The pipe an MCP client talks through. Pi's MCP client transport has this shape. */
export interface McpClientTransport {
  start(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  onMessage(listener: (message: JsonRpcMessage) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onClose(listener: () => void): () => void;
}

/** `deferred`: the harness declares the tool to its model only once its own tool search finds it. */
export type McpExposure = "direct" | "deferred";

export interface RakazoMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  exposure: McpExposure;
  /** The controller tool that runs it, with `{ id, arguments }`, when it is a catalog entry. */
  catalog?: { via: string; id: string };
}

/**
 * What the Rakazo MCP server lists. Every tool is a controller tool; the harness's own tools stay
 * native. A harness with native tool search gets each large catalog's tools deferred, and one
 * without gets the catalog's search, load and execute tools instead.
 */
export function rakazoMcpTools(
  tools: readonly GuestTool[],
  nativeToolSearch: boolean,
): RakazoMcpTool[] {
  return tools
    .filter(
      (tool) =>
        tool.where === "controller" &&
        (nativeToolSearch ? tool.catalog !== "fallback" : typeof tool.catalog !== "object"),
    )
    .map(({ name, description, inputSchema, readOnly, catalog }) => ({
      name,
      description,
      inputSchema,
      ...(readOnly === undefined ? {} : { readOnly }),
      ...(typeof catalog === "object"
        ? { exposure: "deferred" as const, catalog }
        : { exposure: "direct" as const }),
    }));
}

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * A controller tool's output as MCP content. An image the tool still returns is also written to
 * `screensDir` and named in the result: the relay keeps only the newest images in the model's
 * context, and the harness reads an older screen from its file.
 */
async function mcpContent(
  output: unknown,
  screensDir: string,
  callId: string,
): Promise<McpContent[]> {
  if (typeof output === "string") return [{ type: "text", text: output }];
  const result = output as { kind?: unknown; content?: unknown } | null;
  if (result?.kind !== "agent_tool_result" || !Array.isArray(result.content)) {
    return [{ type: "text", text: JSON.stringify(output) ?? "" }];
  }
  const content: McpContent[] = [];
  let images = 0;
  for (const block of result.content as Array<Record<string, unknown>>) {
    if (block.type === "text") {
      content.push({ type: "text", text: String(block.text ?? "") });
      continue;
    }
    if (block.type !== "image") {
      content.push({ type: "text", text: JSON.stringify(block) });
      continue;
    }
    const mimeType = String(block.mimeType);
    const data = String(block.data);
    const file = path.join(screensDir, `${callId}-${++images}.${mimeType.split("/")[1] ?? "png"}`);
    await mkdir(screensDir, { recursive: true });
    await writeFile(file, Buffer.from(data, "base64"));
    content.push({ type: "image", data, mimeType });
    content.push({ type: "text", text: `Screenshot saved at ${file}. Read it to see it again.` });
  }
  return content;
}

class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const PROTOCOL_VERSION = "2025-06-18";

/**
 * The Rakazo MCP server in the guest process, one per attempt, as the client end of an in-process
 * transport. Every call is a `tool.call` to the controller, which keeps approval, journal,
 * redaction and budget. It depends on no harness: an adapter hands the transport to its MCP client.
 */
export function rakazoMcpServer(
  tools: readonly GuestTool[],
  host: HarnessHost,
  screensDir: string,
  options: { nativeToolSearch: boolean },
): McpClientTransport {
  const listed = rakazoMcpTools(tools, options.nativeToolSearch);
  const byName = new Map(listed.map((tool) => [tool.name, tool]));
  const listeners = {
    message: new Set<(message: JsonRpcMessage) => void>(),
    error: new Set<(error: Error) => void>(),
    close: new Set<() => void>(),
  };
  let closed = false;
  const reply = (message: JsonRpcMessage) => {
    // Delivered on a later tick, as a real transport would.
    queueMicrotask(() => {
      if (!closed) for (const listener of listeners.message) listener(message);
    });
  };

  async function call(params: { name?: unknown; arguments?: unknown }) {
    const tool = byName.get(String(params.name ?? ""));
    if (!tool) throw new McpError(-32602, `Unknown tool ${String(params.name)}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const [name, relayed] = tool.catalog
      ? [tool.catalog.via, { id: tool.catalog.id, arguments: args }]
      : [tool.name, args];
    const callId = `mcp-${randomUUID()}`;
    try {
      await host.emit({ type: "tool", name, args: relayed, executionId: callId });
      const outcome = await host.callTool("root", name, relayed, callId);
      return { content: await mcpContent(outcome.output, screensDir, callId), isError: false };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text }], isError: true };
    }
  }

  async function answer(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion:
            typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "rakazo", version: "1" },
          instructions: "Rakazo's own tools: your computer, browser, memory, connectors and app.",
        };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: listed.map(({ name, description, inputSchema, readOnly }) => ({
            name,
            description,
            inputSchema,
            ...(readOnly === undefined ? {} : { annotations: { readOnlyHint: readOnly } }),
          })),
        };
      case "tools/call":
        return call(params);
      default:
        throw new McpError(-32601, `Method not found: ${method}`);
    }
  }

  return {
    async start() {},
    async send(message) {
      if (closed || !("method" in message) || !("id" in message)) return;
      const { id } = message;
      const params = (message.params ?? {}) as Record<string, unknown>;
      answer(message.method, params).then(
        (result) => reply({ jsonrpc: "2.0", id, result }),
        (error: unknown) =>
          reply({
            jsonrpc: "2.0",
            id,
            error: {
              code: error instanceof McpError ? error.code : -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const listener of listeners.close) listener();
    },
    onMessage(listener) {
      listeners.message.add(listener);
      return () => listeners.message.delete(listener);
    },
    onError(listener) {
      listeners.error.add(listener);
      return () => listeners.error.delete(listener);
    },
    onClose(listener) {
      listeners.close.add(listener);
      return () => listeners.close.delete(listener);
    },
  };
}
