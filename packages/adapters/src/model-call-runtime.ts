import { normalizeContext } from "@earendil-works/pi-ai";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { redactSensitiveText } from "@rakazo/logging";
import { stripModelControlTokens } from "./agent-text-policy.js";
import { streamRunModel } from "./pi-run-model.js";
import { billedPromptTokens, providerCacheTokens } from "./pi-runtime-limits.js";

/**
 * One model call from the controller, without tools: what compaction, the team-chat judge and
 * auto-review ask of a model. Agent runs go through a worker. Throws when the call fails.
 */
export class ModelCallRuntime implements AgentRuntime {
  describe() {
    return {
      id: "model-call",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: false, compaction: true, tools: false, scripted: false },
    };
  }

  async abort(): Promise<void> {}

  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncGenerator<AgentRuntimeEvent, void> {
    if (request.tools.length > 0) throw new Error("A model call takes no tools");
    const { model, stream } = streamRunModel(
      request.model,
      normalizeContext({
        systemPrompt: request.instructions,
        messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
      }),
      { signal: context?.signal },
    );
    const message = await stream.result();
    if (message.usage) {
      yield {
        type: "usage",
        ...billedPromptTokens(message.usage),
        ...providerCacheTokens(message.usage),
        provider: model.provider,
        model: model.id,
      };
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(
        redactSensitiveText(message.errorMessage ?? `Model call ${message.stopReason}`),
      );
    }
    const text = stripModelControlTokens(
      message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    ).trim();
    yield { type: "done", ...(text ? { text } : {}) };
  }
}
