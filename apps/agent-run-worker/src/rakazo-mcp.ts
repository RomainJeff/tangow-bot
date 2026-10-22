import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GuestTool } from "@rakazo/adapter-kit";
import {
  assertConnectorToolArgs,
  clipToolResultContent,
  TOOL_RESULT_TEXT_LIMIT,
} from "@rakazo/adapters/runtime-worker/wire";
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

type McpBlock = { type: string; [key: string]: unknown };

const isBlock = (value: unknown): value is McpBlock =>
  typeof (value as { type?: unknown } | null)?.type === "string";

/**
 * A controller tool's output as one envelope. Rakazo tools return `agent_tool_result` content,
 * connectors an MCP result, and a refused or failed call `{ error }`.
 */
function resultBlocks(output: unknown): { blocks: McpBlock[]; isError: boolean } {
  if (typeof output === "string")
    return { blocks: [{ type: "text", text: output }], isError: false };
  const result = output as { content?: unknown; isError?: unknown; error?: unknown } | null;
  if (typeof result?.error === "string" && result.error) {
    return { blocks: [{ type: "text", text: result.error }], isError: true };
  }
  if (Array.isArray(result?.content) && result.content.every(isBlock)) {
    return { blocks: result.content, isError: result.isError === true };
  }
  return { blocks: [{ type: "text", text: JSON.stringify(output) ?? "" }], isError: false };
}

/**
 * A controller tool's result for the model, its text within the tool result budget. An image is
 * also written to `screensDir` and named in the result: the relay keeps only the newest images in
 * the model's context, and the harness reads an older screen from its file.
 */
/**
 * Names for the screens saved from one result, within the text budget: once they no longer fit,
 * one line counts the rest.
 */
function screenHints(files: string[], screensDir: string): McpBlock[] {
  const more = (count: number) => `[${count} more screenshots saved in ${screensDir}]`;
  const lines: string[] = [];
  let used = 0;
  for (const [index, file] of files.entries()) {
    const line = `Screenshot saved at ${file}. Read it to see it again.`;
    const after = files.length - index - 1;
    if (used + line.length + (after > 0 ? more(after).length : 0) > TOOL_RESULT_TEXT_LIMIT) break;
    lines.push(line);
    used += line.length;
  }
  if (lines.length < files.length) lines.push(more(files.length - lines.length));
  return lines.map((text) => ({ type: "text", text }));
}

async function mcpResult(output: unknown, screensDir: string, callId: string) {
  const { blocks, isError } = resultBlocks(output);
  const files: string[] = [];
  for (const block of blocks) {
    if (block.type !== "image") continue;
    const mimeType = String(block.mimeType);
    const file = path.join(
      screensDir,
      `${callId}-${files.length + 1}.${mimeType.split("/")[1] ?? "png"}`,
    );
    await mkdir(screensDir, { recursive: true });
    await writeFile(file, Buffer.from(String(block.data), "base64"));
    files.push(file);
  }
  const hints = screenHints(files, screensDir);
  const hintChars = hints.reduce((sum, hint) => sum + String(hint.text).length, 0);
  return {
    content: [
      ...clipToolResultContent(blocks, Math.max(0, TOOL_RESULT_TEXT_LIMIT - hintChars)),
      ...hints,
    ],
    isError,
  };
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
    const args = params.arguments ?? {};
    const callId = `mcp-${randomUUID()}`;
    try {
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new Error("Tool arguments must be an object");
      }
      assertConnectorToolArgs(tool.inputSchema, args as Record<string, unknown>);
      const [name, relayed] = tool.catalog
        ? [tool.catalog.via, { id: tool.catalog.id, arguments: args }]
        : [tool.name, args as Record<string, unknown>];
      await host.emit({ type: "tool", name, args: relayed, executionId: callId });
      const outcome = await host.callTool("root", name, relayed, callId);
      return await mcpResult(outcome.output, screensDir, callId);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { content: clipToolResultContent([{ type: "text", text }]), isError: true };
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
