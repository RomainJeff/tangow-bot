import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import type { AgentRunRequest } from "@tangow/adapter-kit";
import { DRAFT_CARDS } from "@tangow/core";

export interface ModelEmulatorRequest {
  model: string;
  stream: boolean;
  messages: Array<{
    role: string;
    content?: unknown;
    tool_call_id?: string;
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  }>;
  tools?: Array<{
    type: string;
    function: { name: string; parameters: unknown; strict?: boolean };
  }>;
}

/** Token counts the response reports in a final usage chunk. */
export type ModelEmulatorUsage = {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens read from the provider's cache. */
  cacheReadTokens?: number;
};

export type ModelEmulatorResponse =
  | {
      type: "text";
      text: string;
      usage?: ModelEmulatorUsage;
      /** A thinking block before the text; only the Anthropic protocol streams one. */
      thinking?: string;
    }
  | {
      type: "tool";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      /** Concatenation must equal the JSON arguments. Each fragment is a separate SSE delta. */
      argumentChunks?: string[];
      /** Further calls the same assistant turn makes, after this one. */
      siblings?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
      usage?: ModelEmulatorUsage;
    }
  | { type: "error"; status: number; message: string }
  | { type: "disconnect"; text?: string }
  | { type: "hold"; text?: string; onOpen?: () => void; onClose?: () => void };

export interface ModelEmulatorStep {
  /** Assertions run before the response; failures also make assertComplete fail. */
  expect: (request: ModelEmulatorRequest) => void | Promise<void>;
  response: ModelEmulatorResponse | ((request: ModelEmulatorRequest) => ModelEmulatorResponse);
}

export function prepares(
  proposal?: { card: keyof typeof DRAFT_CARDS } & Record<string, unknown>,
): ModelEmulatorStep {
  const offered = (request: ModelEmulatorRequest) =>
    assert.deepEqual(
      request.tools?.map((tool) => tool.function.name),
      [DRAFT_CARDS.mail.name, DRAFT_CARDS.chat.name],
    );
  if (!proposal) return { expect: offered, response: { type: "text", text: "classic" } };
  const { card, ...value } = proposal;
  return {
    expect: offered,
    response: { type: "tool", id: "draft-card", name: DRAFT_CARDS[card].name, arguments: value },
  };
}

/**
 * A loopback-only model protocol fixture. Pi itself and its HTTP/SSE transport
 * stay real. This tests execution, not whether a model can choose these actions.
 * Always call assertComplete: a runtime can consume a provider failure without
 * propagating the original fixture assertion.
 */
export async function startModelEmulator(options: {
  steps: ModelEmulatorStep[];
  modelId?: string;
  apiKey?: string;
  /** The wire protocol it serves: OpenAI chat completions by default, or Anthropic messages. */
  protocol?: "openai" | "anthropic";
}) {
  const anthropic = options.protocol === "anthropic";
  const modelId = options.modelId ?? "offline-fixture";
  const requests: ModelEmulatorRequest[] = [];
  /** The request bodies as sent, before the Anthropic protocol's are read as chat requests. */
  const rawRequests: unknown[] = [];
  /** When each request arrived and when its response finished, on `performance.now()`. */
  const served: Array<{ received: number; firstByte: number; answered: number }> = [];
  const failures: Error[] = [];
  let stepIndex = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(404);
      response.end();
      return;
    }
    const received = performance.now();
    let firstByte = received;
    response.once("finish", () =>
      served.push({ received, firstByte, answered: performance.now() }),
    );
    void (async () => {
      assert.equal(request.method, "POST", "Expected a model POST request");
      if (anthropic) {
        // The SDK's beta client, which pi-ai uses, marks its calls with `?beta=true`.
        assert.equal(request.url?.split("?")[0], "/v1/messages", "Unexpected model endpoint");
        assert.equal(request.headers["x-api-key"], options.apiKey ?? "local");
      } else {
        assert.equal(request.url, "/v1/chat/completions", "Unexpected model endpoint");
        assert.equal(request.headers.authorization, `Bearer ${options.apiKey ?? "local"}`);
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        assert.ok(bytes <= 2 * 1024 * 1024, "Model fixture request exceeds 2 MiB");
        chunks.push(Buffer.from(chunk));
      }
      const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      rawRequests.push(raw);
      const body = anthropic ? fromAnthropic(raw) : (raw as ModelEmulatorRequest);
      requests.push(body);
      assert.equal(body.model, modelId, "Model routing changed");
      assert.equal(body.stream, true, "Expected streaming model request");
      assert.ok(Array.isArray(body.messages), "Expected model messages");
      const step = options.steps[stepIndex++];
      assert.ok(step, `Unexpected model request ${stepIndex}`);
      await step.expect(body);
      const reply = typeof step.response === "function" ? step.response(body) : step.response;
      if (reply.type === "error") {
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: reply.message, type: "fixture_error" } }));
        return;
      }
      if (reply.type === "tool" && reply.argumentChunks) {
        assert.equal(reply.argumentChunks.join(""), JSON.stringify(reply.arguments));
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      firstByte = performance.now();
      response.flushHeaders();
      if (anthropic) {
        await streamAnthropic(response, reply, modelId);
        return;
      }
      const emit = (delta: unknown, finishReason: string | null = null) => {
        response.write(
          `data: ${JSON.stringify({
            id: `fixture-${stepIndex}`,
            object: "chat.completion.chunk",
            created: 0,
            model: modelId,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      };
      emit({ role: "assistant" });
      if (reply.type === "tool") {
        emit({
          tool_calls: [
            {
              index: 0,
              id: reply.id,
              type: "function",
              function: { name: reply.name, arguments: "" },
            },
          ],
        });
        for (const fragment of reply.argumentChunks ?? [JSON.stringify(reply.arguments)]) {
          emit({ tool_calls: [{ index: 0, function: { arguments: fragment } }] });
        }
        for (const [offset, sibling] of (reply.siblings ?? []).entries()) {
          emit({
            tool_calls: [
              {
                index: offset + 1,
                id: sibling.id,
                type: "function",
                function: { name: sibling.name, arguments: JSON.stringify(sibling.arguments) },
              },
            ],
          });
        }
        emit({}, "tool_calls");
      } else {
        if (reply.text) emit({ content: reply.text });
        if (reply.type === "hold") {
          response.once("close", () => reply.onClose?.());
          reply.onOpen?.();
          return;
        }
        if (reply.type === "disconnect") {
          // Flush the partial SSE stream, then close without a terminal chunk.
          await new Promise<void>((resolve) => response.write(": disconnect\n\n", () => resolve()));
          response.destroy();
          return;
        }
        emit({}, "stop");
      }
      if (reply.usage) {
        response.write(
          `data: ${JSON.stringify({
            id: `fixture-${stepIndex}`,
            object: "chat.completion.chunk",
            created: 0,
            model: modelId,
            choices: [],
            usage: {
              prompt_tokens: reply.usage.promptTokens,
              completion_tokens: reply.usage.completionTokens,
              ...(reply.usage.cacheReadTokens === undefined
                ? {}
                : { prompt_tokens_details: { cached_tokens: reply.usage.cacheReadTokens } }),
            },
          })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
    })().catch((error: unknown) => {
      failures.push(error instanceof Error ? error : new Error(String(error)));
      failResponse(response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // An Anthropic client adds /v1 itself.
  const baseUrl = anthropic ? origin : `${origin}/v1`;
  const model: AgentRunRequest["model"] = {
    provider: "openai-compatible",
    id: modelId,
    baseUrl,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  };
  return {
    baseUrl,
    model,
    requests,
    rawRequests,
    served,
    assertComplete() {
      if (failures.length)
        throw new AggregateError(failures, failures.map((error) => error.message).join("\n"));
      assert.equal(stepIndex, options.steps.length, "Not all model fixture steps were consumed");
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

function failResponse(response: ServerResponse) {
  if (response.headersSent) response.destroy();
  else {
    response.writeHead(400, { "content-type": "application/json" });
    // Assertion details are retained locally; do not inject them into the agent conversation.
    response.end(
      JSON.stringify({
        error: { message: "Model fixture request mismatch", type: "fixture_error" },
      }),
    );
  }
}

type AnthropicBlock = {
  type: string;
  text?: string;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  id?: string;
  name?: string;
  input?: unknown;
};

/** An Anthropic messages request in the shape steps read, tool results as `tool` messages. */
function fromAnthropic(raw: {
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content: string | AnthropicBlock[] }>;
  tools?: Array<{ name: string; input_schema: unknown; strict?: boolean }>;
}): ModelEmulatorRequest {
  const messages = raw.messages.flatMap((message): ModelEmulatorRequest["messages"] => {
    if (typeof message.content === "string")
      return [{ role: message.role, content: message.content }];
    const results = message.content.filter((block) => block.type === "tool_result");
    const rest = message.content.filter((block) => block.type !== "tool_result");
    return [
      ...(rest.length ? [{ role: message.role, content: rest }] : []),
      ...results.map((block) => ({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content:
          typeof block.content === "string"
            ? block.content
            : (block.content ?? []).map((part) => part.text ?? "").join(""),
      })),
    ];
  });
  return {
    model: raw.model,
    stream: raw.stream,
    messages,
    tools: raw.tools?.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        parameters: tool.input_schema,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      },
    })),
  };
}

/** One reply as Anthropic's message stream: blocks, then the stop reason and usage. */
async function streamAnthropic(
  response: ServerResponse,
  reply: ModelEmulatorResponse,
  modelId: string,
) {
  const send = (event: Record<string, unknown> & { type: string }) =>
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const usage = "usage" in reply ? reply.usage : undefined;
  send({
    type: "message_start",
    message: {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: modelId,
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: usage?.promptTokens ?? 0,
        output_tokens: 0,
        cache_read_input_tokens: usage?.cacheReadTokens ?? 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
  let index = 0;
  const block = (start: Record<string, unknown>, deltas: Record<string, unknown>[]) => {
    send({ type: "content_block_start", index, content_block: start });
    for (const delta of deltas) send({ type: "content_block_delta", index, delta });
    send({ type: "content_block_stop", index });
    index += 1;
  };
  if (reply.type === "text" && reply.thinking) {
    block({ type: "thinking", thinking: "" }, [
      { type: "thinking_delta", thinking: reply.thinking },
      { type: "signature_delta", signature: "fixture-signature" },
    ]);
  }
  if (reply.type === "tool") {
    block(
      { type: "tool_use", id: reply.id, name: reply.name, input: {} },
      (reply.argumentChunks ?? [JSON.stringify(reply.arguments)]).map((partial_json) => ({
        type: "input_json_delta",
        partial_json,
      })),
    );
    for (const sibling of reply.siblings ?? []) {
      block({ type: "tool_use", id: sibling.id, name: sibling.name, input: {} }, [
        { type: "input_json_delta", partial_json: JSON.stringify(sibling.arguments) },
      ]);
    }
  } else if (reply.type === "text") {
    block({ type: "text", text: "" }, [{ type: "text_delta", text: reply.text }]);
  } else {
    throw new Error(`The Anthropic protocol emulator does not stream a ${reply.type} reply`);
  }
  send({
    type: "message_delta",
    delta: { stop_reason: reply.type === "tool" ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: usage?.completionTokens ?? 0 },
  });
  send({ type: "message_stop" });
  response.end();
}
