import type {
  AssistantMessageEventStream,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  type Message,
  type Model,
  normalizeContext,
  type TextContent,
  type ThinkingContent,
} from "@earendil-works/pi-ai";
import type {
  AgentRunModel,
  GuestModel,
  PiAiModelCall,
  PiAiModelEvent,
  ReplyFinal,
  ReplyPart,
} from "@rakazo/adapter-kit";
import { conversationSessionId, type PiStreamFn, streamRunModel } from "../../pi-runtime.js";
import { billedPromptTokens, providerCacheTokens } from "../../pi-runtime-limits.js";
import type { ModelRelay } from "../model-relay.js";
import { prunePiAiImages } from "./pi-ai-images.js";

/**
 * The `pi-ai` model-access dialect: pi-ai's transcript out, pi-ai's stream events back. The only
 * module of the run channel that knows pi-ai, on both sides.
 */

/**
 * Where a guest's Pi would send its model calls. Never contacted: the guest relays every call,
 * and an OpenAI-compatible model only resolves with an endpoint set.
 */
const RELAYED_BASE_URL = "http://relay.invalid/v1";

/** The model a guest hands its own Pi runtime, whose calls are relayed. */
export function relayedModel(model: GuestModel): AgentRunModel {
  return { ...model, baseUrl: RELAYED_BASE_URL };
}

const NO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function failedMessage(
  model: Pick<Model<Api>, "api" | "provider" | "id">,
  reason: "aborted" | "error",
  message: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: NO_USAGE,
    stopReason: reason,
    errorMessage: message,
    timestamp: Date.now(),
  };
}

// Snapshots: pi-ai keeps mutating `partial`, and a cached reply may be replayed later.
const snapshot = (value: object) => structuredClone(value) as Record<string, unknown>;

function encodeModelEvent(event: AssistantMessageEvent): PiAiModelEvent {
  switch (event.type) {
    case "start":
      return { type: "start", partial: snapshot(event.partial) };
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        block: snapshot(event.partial.content[event.contentIndex] ?? {}),
      };
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
    case "text_end":
    case "thinking_end":
      return { type: event.type, contentIndex: event.contentIndex, content: event.content };
    case "toolcall_end":
      return {
        type: "toolcall_end",
        contentIndex: event.contentIndex,
        toolCall: snapshot(event.toolCall),
      };
    case "done":
      return { type: "done", reason: event.reason, message: snapshot(event.message) };
    case "error":
      return { type: "error", reason: event.reason, error: snapshot(event.error) };
  }
}

/**
 * Controller half: run a guest's model call with the model and key the controller holds, and
 * stream its events back. Usage comes from the provider's own response.
 */
export const relayPiAiCall: ModelRelay<PiAiModelCall, PiAiModelEvent> = async (
  config,
  call,
  send,
  { signal, conversation },
) => {
  let model: Model<Api> | undefined;
  try {
    // The transcript is the guest's to shape; a malformed one fails this call, nothing else.
    const context = normalizeContext({
      messages: prunePiAiImages(
        call.context.messages,
        config.maxImagesPerPrompt,
      ) as unknown as Message[],
    });
    const relayed = streamRunModel(config, context, {
      sessionId: conversationSessionId(
        conversation.threadId,
        conversation.botId,
        conversation.helper,
      ),
      signal,
    });
    model = relayed.model;
    for await (const event of relayed.stream) {
      send(encodeModelEvent(event));
      if (event.type === "done" || event.type === "error") {
        const { usage } = event.type === "done" ? event.message : event.error;
        return {
          type: "usage",
          ...billedPromptTokens(usage),
          ...providerCacheTokens(usage),
          provider: relayed.model.provider,
          model: relayed.model.id,
        };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const target = model ?? { api: "unknown", provider: config.provider, id: config.id };
    send({
      type: "error",
      reason: "error",
      error: snapshot(failedMessage(target, "error", message)),
    });
  }
  return undefined;
};

/** Guest half of `encodeModelEvent`: rebuilds the growing `partial` from blocks and deltas. */
function modelEventDecoder() {
  let partial: AssistantMessage | undefined;
  const current = () => {
    if (!partial) throw new Error("Relayed model event before its start");
    return partial;
  };
  // The controller is the trusted side of this channel: its events are pi-ai's own, re-sent.
  return (event: PiAiModelEvent): AssistantMessageEvent => {
    switch (event.type) {
      case "start":
        partial = event.partial as unknown as AssistantMessage;
        return { type: "start", partial };
      case "text_start":
      case "thinking_start":
      case "toolcall_start": {
        const message = current();
        message.content[event.contentIndex] =
          event.block as unknown as AssistantMessage["content"][number];
        return { type: event.type, contentIndex: event.contentIndex, partial: message };
      }
      case "text_delta":
      case "thinking_delta":
      case "toolcall_delta": {
        const message = current();
        const block = message.content[event.contentIndex];
        if (event.type === "text_delta" && block?.type === "text") block.text += event.delta;
        if (event.type === "thinking_delta" && block?.type === "thinking") {
          block.thinking += event.delta;
        }
        return {
          type: event.type,
          contentIndex: event.contentIndex,
          delta: event.delta,
          partial: message,
        };
      }
      case "text_end": {
        const message = current();
        (message.content[event.contentIndex] as TextContent).text = event.content;
        return {
          type: "text_end",
          contentIndex: event.contentIndex,
          content: event.content,
          partial: message,
        };
      }
      case "thinking_end": {
        const message = current();
        (message.content[event.contentIndex] as ThinkingContent).thinking = event.content;
        return {
          type: "thinking_end",
          contentIndex: event.contentIndex,
          content: event.content,
          partial: message,
        };
      }
      case "toolcall_end": {
        const message = current();
        const toolCall = event.toolCall as unknown as Extract<
          AssistantMessage["content"][number],
          { type: "toolCall" }
        >;
        message.content[event.contentIndex] = toolCall;
        return {
          type: "toolcall_end",
          contentIndex: event.contentIndex,
          toolCall,
          partial: message,
        };
      }
      case "done":
        return {
          type: "done",
          reason: event.reason,
          message: event.message as unknown as AssistantMessage,
        };
      case "error":
        return {
          type: "error",
          reason: event.reason,
          error: event.error as unknown as AssistantMessage,
        };
    }
  };
}

/** Sends one model request and settles with its final reply; parts arrive through `onPart`. */
export type RelayRequest = (
  body: { type: "model.request"; agent: string; dialect: "pi-ai"; call: PiAiModelCall },
  onPart: (part: ReplyPart) => void,
  /** Aborting stops the controller's upstream call too. */
  signal?: AbortSignal,
) => Promise<ReplyFinal>;

/**
 * Guest half: a stream function that sends every model call to the controller. `agentRef` maps a
 * helper's agent id to the ref the controller gave it.
 */
export function piAiStreamFn(
  request: RelayRequest,
  agentRef: (agentId: string | undefined) => string,
): PiStreamFn {
  return (model, context, options, agentId) => {
    const stream = createAssistantMessageEventStream();
    const decode = modelEventDecoder();
    let ended = false;
    const push = (event: AssistantMessageEvent) => {
      if (ended) return;
      ended = event.type === "done" || event.type === "error";
      stream.push(event);
    };
    const fail = (reason: "aborted" | "error", message: string) =>
      push({ type: "error", reason, error: failedMessage(model, reason, message) });
    const onAbort = () => fail("aborted", "Request was aborted");
    if (options?.signal?.aborted) {
      onAbort();
      return stream;
    }
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    request(
      {
        type: "model.request",
        agent: agentRef(agentId),
        dialect: "pi-ai",
        call: {
          context: {
            messages: context.messages as unknown as PiAiModelCall["context"]["messages"],
          },
          options: options?.sessionId ? { sessionId: options.sessionId } : {},
        },
      },
      (part) => {
        if (part.type === "model.event") push(decode(part.event));
      },
      options?.signal,
    )
      .then((final) =>
        fail(
          "error",
          final.type === "error" ? final.message : "The model relay ended without a response",
        ),
      )
      .catch((error: unknown) =>
        fail("error", error instanceof Error ? error.message : String(error)),
      )
      .finally(() => options?.signal?.removeEventListener("abort", onAbort));
    return stream;
  };
}

/** The relay as a Pi provider's stream: every call of a native Pi session, compaction included. */
export function piAiProviderStream(request: RelayRequest) {
  const stream = piAiStreamFn(request, () => "root");
  return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) =>
    stream(model, context, options, undefined) as AssistantMessageEventStream;
}

export * from "./pi-ai-history.js";
