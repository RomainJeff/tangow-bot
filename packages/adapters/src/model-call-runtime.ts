import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { redactSensitiveText } from "@rakazo/logging";
import { stripModelControlTokens } from "./agent-text-policy.js";
import { streamRunModel, thinkingLevelFor } from "./pi-run-model.js";
import { RunTraceRecorder } from "./pi-run-trace.js";
import { billedPromptTokens, providerCacheTokens } from "./pi-runtime-limits.js";
import type { TraceExporter } from "./trace-export.js";

/**
 * One model call from the controller, without tools: what compaction, the team-chat judge and
 * auto-review ask of a model. Agent runs go through a worker. Throws when the call fails. With an
 * exporter, each call is exported as a trace; without one, nothing is recorded.
 */
export class ModelCallRuntime implements AgentRuntime {
  constructor(private readonly trace: { exporter?: TraceExporter; serviceName?: string } = {}) {}

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
    const exporter = this.trace.exporter;
    const recorder =
      exporter &&
      new RunTraceRecorder({
        runId: request.runId,
        threadId: request.threadId,
        botId: request.botId,
        userId: context?.userId,
        correlationTraceId: context?.traceId,
        provider: model.provider,
        model: model.id,
        thinkingLevel: thinkingLevelFor(model, request.model.thinkingLevel),
        systemPrompt: request.instructions,
        history: [],
        prompt: request.prompt,
      });
    recorder?.turnStart();
    let text = "";
    let failure: unknown;
    try {
      const message = await stream.result();
      recorder?.assistantMessage(message as AgentMessage, message.usage);
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
      text = stripModelControlTokens(
        message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      ).trim();
      yield { type: "done", ...(text ? { text } : {}) };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (recorder && exporter) {
        recorder.finish(text, failure);
        const secrets = request.secrets ?? [];
        exporter.export(recorder.trace, {
          userId: context?.userId,
          spaceId: context?.spaceId,
          serviceName: this.trace.serviceName,
          redact: (value) => redactSensitiveText(redactSecrets(value, [...secrets])),
        });
      }
    }
  }
}
