import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, ResourceLoader, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSteeringMessage } from "@rakazo/adapter-kit";
import { PiRuntimeCredentialStore } from "./pi-credentials.js";

export type WireProtocol = "openai-completions" | "anthropic-messages";

export type WireBlock =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; arguments: Record<string, unknown> };

export interface WireUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type WireReply =
  | { type: "message"; blocks: WireBlock[]; usage?: WireUsage }
  | { type: "hold"; blocks: WireBlock[]; onClose?: () => void };

export interface WireRequest {
  credential: string | undefined;
  tools: string[];
  schemas: Record<string, unknown>;
  transcript: string[];
}

export type WireStep = (request: WireRequest) => WireReply | Promise<WireReply>;

const MODEL_ID = "proof-model";
const NO_USAGE: WireUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export async function startWireFixture(options: { protocol: WireProtocol; steps: WireStep[] }) {
  const requests: WireRequest[] = [];
  const failures: Error[] = [];
  const sockets = new Set<Socket>();
  let stepIndex = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readJson(request);
      if (!isRecord(body) || body.model !== MODEL_ID || body.stream !== true) {
        throw new Error(`Expected a streamed ${MODEL_ID} request`);
      }
      const wire = options.protocol === "openai-completions" ? openAiRequest : anthropicRequest;
      const parsed = wire(request, body);
      requests.push(parsed);
      const step = options.steps[stepIndex++];
      if (!step) throw new Error(`Unexpected model request ${stepIndex}`);
      const reply = await step(parsed);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.flushHeaders();
      const encode = options.protocol === "openai-completions" ? openAiEvents : anthropicEvents;
      const events = encode(
        reply.blocks,
        reply.type === "message" ? (reply.usage ?? NO_USAGE) : undefined,
      );
      for (const event of events) response.write(event);
      if (reply.type === "hold") {
        response.once("close", () => reply.onClose?.());
        return;
      }
      response.end();
    })().catch((error: unknown) => {
      failures.push(error instanceof Error ? error : new Error(String(error)));
      if (response.headersSent) response.destroy();
      else response.writeHead(400).end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Wire fixture is not listening on TCP");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    protocol: options.protocol,
    baseUrl: options.protocol === "openai-completions" ? `${origin}/v1` : origin,
    requests,
    openConnections: () => sockets.size,
    assertComplete() {
      if (failures.length)
        throw new AggregateError(failures, failures.map((e) => e.message).join("\n"));
      if (stepIndex !== options.steps.length) {
        throw new Error(`Consumed ${stepIndex} of ${options.steps.length} model steps`);
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}

export type WireFixture = Awaited<ReturnType<typeof startWireFixture>>;

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return records(content)
    .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
    .join("");
}

function toolList(tools: Json[], schemaField: string) {
  return {
    tools: tools.map((tool) => String(tool.name)),
    schemas: Object.fromEntries(tools.map((tool) => [String(tool.name), tool[schemaField]])),
  };
}

function openAiRequest(request: IncomingMessage, body: unknown): WireRequest {
  if (request.url !== "/v1/chat/completions" || !isRecord(body)) {
    throw new Error(`Unexpected OpenAI request ${request.url}`);
  }
  const transcript = records(body.messages).flatMap((message): string[] => {
    const calls = records(message.tool_calls).map((call) => {
      const fn = isRecord(call.function) ? call.function : {};
      return `call ${String(call.id)} ${String(fn.name)} ${String(fn.arguments)}`;
    });
    if (message.role === "tool")
      return [`tool ${String(message.tool_call_id)}: ${textOf(message.content)}`];
    const role = message.role === "developer" ? "system" : String(message.role);
    const text = textOf(message.content);
    return [...(text ? [`${role}: ${text}`] : []), ...calls];
  });
  return {
    credential: request.headers.authorization?.replace(/^Bearer /, ""),
    ...toolList(
      records(body.tools).map((tool) => (isRecord(tool.function) ? tool.function : {})),
      "parameters",
    ),
    transcript,
  };
}

function anthropicRequest(request: IncomingMessage, body: unknown): WireRequest {
  if (!request.url?.startsWith("/v1/messages") || !isRecord(body)) {
    throw new Error(`Unexpected Anthropic request ${request.url}`);
  }
  const system = textOf(body.system);
  const transcript = records(body.messages).flatMap((message): string[] => {
    if (typeof message.content === "string") return [`${String(message.role)}: ${message.content}`];
    return records(message.content).flatMap((block): string[] => {
      if (block.type === "text") return [`${String(message.role)}: ${String(block.text)}`];
      if (block.type === "tool_use") {
        return [`call ${String(block.id)} ${String(block.name)} ${JSON.stringify(block.input)}`];
      }
      if (block.type === "tool_result") {
        return [`tool ${String(block.tool_use_id)}: ${textOf(block.content)}`];
      }
      return [];
    });
  });
  const header = request.headers["x-api-key"];
  return {
    credential: Array.isArray(header) ? header[0] : header,
    ...toolList(records(body.tools), "input_schema"),
    transcript: system ? [`system: ${system}`, ...transcript] : transcript,
  };
}

function openAiEvents(blocks: WireBlock[], usage: WireUsage | undefined): string[] {
  const chunk = (delta: Json, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: "proof",
      object: "chat.completion.chunk",
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const events = [chunk({ role: "assistant" })];
  const tools = blocks.filter((block) => block.type === "tool");
  for (const block of blocks) {
    if (block.type === "thinking") events.push(chunk({ reasoning_content: block.text }));
    if (block.type === "text") events.push(chunk({ content: block.text }));
    if (block.type === "tool") {
      const index = tools.indexOf(block);
      events.push(
        chunk({
          tool_calls: [
            {
              index,
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: "" },
            },
          ],
        }),
        chunk({
          tool_calls: [{ index, function: { arguments: JSON.stringify(block.arguments) } }],
        }),
      );
    }
  }
  if (!usage) return events;
  events.push(chunk({}, tools.length ? "tool_calls" : "stop"));
  events.push(
    `data: ${JSON.stringify({
      id: "proof",
      object: "chat.completion.chunk",
      created: 0,
      model: MODEL_ID,
      choices: [],
      usage: {
        prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
        completion_tokens: usage.output,
        prompt_tokens_details: {
          cached_tokens: usage.cacheRead,
          cache_write_tokens: usage.cacheWrite,
        },
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  );
  return events;
}

function anthropicEvents(blocks: WireBlock[], usage: WireUsage | undefined): string[] {
  const event = (type: string, data: Json) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const events = [
    event("message_start", {
      message: {
        id: "proof",
        type: "message",
        role: "assistant",
        model: MODEL_ID,
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: usage?.input ?? 0,
          output_tokens: 0,
          cache_read_input_tokens: usage?.cacheRead ?? 0,
          cache_creation_input_tokens: usage?.cacheWrite ?? 0,
        },
      },
    }),
  ];
  blocks.forEach((block, index) => {
    if (block.type === "thinking") {
      events.push(
        event("content_block_start", {
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
        event("content_block_delta", {
          index,
          delta: { type: "thinking_delta", thinking: block.text },
        }),
        event("content_block_delta", {
          index,
          delta: { type: "signature_delta", signature: "proof" },
        }),
      );
    }
    if (block.type === "text") {
      events.push(
        event("content_block_start", { index, content_block: { type: "text", text: "" } }),
        event("content_block_delta", { index, delta: { type: "text_delta", text: block.text } }),
      );
    }
    if (block.type === "tool") {
      events.push(
        event("content_block_start", {
          index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        }),
        event("content_block_delta", {
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.arguments) },
        }),
      );
    }
    if (usage) events.push(event("content_block_stop", { index }));
  });
  if (!usage) return events;
  events.push(
    event("message_delta", {
      delta: {
        stop_reason: blocks.some((block) => block.type === "tool") ? "tool_use" : "end_turn",
      },
      usage: { output_tokens: usage.output },
    }),
    event("message_stop", {}),
  );
  return events;
}

export async function proofModelRuntime(fixture: WireFixture, apiKey: string) {
  const provider = `rakazo-proof-${fixture.protocol}`;
  const modelRuntime = await ModelRuntime.create({
    credentials: new PiRuntimeCredentialStore(provider, { type: "api_key", key: apiKey }),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider(provider, {
    baseUrl: fixture.baseUrl,
    api: fixture.protocol,
    models: [
      {
        id: MODEL_ID,
        name: MODEL_ID,
        api: fixture.protocol,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
    ],
  });
  const model = modelRuntime.getModel(provider, MODEL_ID);
  if (!model) throw new Error(`Fixture model ${provider}/${MODEL_ID} did not register`);
  return { modelRuntime, model };
}

function explicitResources(systemPrompt: string): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

export async function createProofSession(options: {
  cwd: string;
  agentDir: string;
  runtime: Awaited<ReturnType<typeof proofModelRuntime>>;
  systemPrompt: string;
  transcript?:
    | { kind: "history"; messages: AgentMessage[] }
    | { kind: "restore"; manager: SessionManager };
  tools?: ToolDefinition[];
}): Promise<AgentSession> {
  const sessionManager =
    options.transcript?.kind === "restore"
      ? options.transcript.manager
      : SessionManager.inMemory(options.cwd);
  if (options.transcript?.kind === "history") {
    for (const message of options.transcript.messages) {
      if (
        message.role !== "user" &&
        message.role !== "assistant" &&
        message.role !== "toolResult"
      ) {
        throw new Error(`History cannot replay a ${message.role} message`);
      }
      sessionManager.appendMessage(message);
    }
  }
  const tools = options.tools ?? [];
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime: options.runtime.modelRuntime,
    model: options.runtime.model,
    thinkingLevel: "off",
    noTools: "all",
    tools: tools.map((tool) => tool.name),
    customTools: tools,
    resourceLoader: explicitResources(options.systemPrompt),
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    }),
  });
  return session;
}

/**
 * Wraps the hook AgentSession installed so compaction and the loadout refresh still run, and
 * returns claimed messages in the snapshot so the loop persists them through message_end.
 */
export function chainDurableSteering(
  session: AgentSession,
  claim: (seenIds: string[]) => Promise<AgentSteeringMessage[]>,
  seenIds: string[] = [],
) {
  const previous = session.agent.prepareNextTurnWithContext;
  session.agent.prepareNextTurnWithContext = async (turn, signal) => {
    const snapshot = await previous?.(turn, signal);
    if (signal?.aborted) return snapshot;
    const claimed = await claim([...seenIds]);
    if (claimed.length === 0) return snapshot;
    seenIds.push(...claimed.map((item) => item.id));
    const messages: AgentMessage[] = claimed.map((item) => ({
      role: "user",
      content: [{ type: "text", text: item.text }],
      timestamp: Date.now(),
    }));
    return { ...snapshot, messages: [...(snapshot?.messages ?? []), ...messages] };
  };
}
