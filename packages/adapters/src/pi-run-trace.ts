import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { ToolCallGenerationResult, ToolCallTrace } from "@rakazo/adapter-kit";

import { RunTrace, type RunTraceSpan } from "./run-trace.js";

/** Upper bound on a single exported string, so one huge tool result cannot bloat a trace. */
const MAX_TRACE_TEXT = 20_000;

export interface RunTraceRecorderOptions {
  runId: string;
  threadId: string;
  botId: string;
  userId?: string;
  correlationTraceId?: string;
  provider: string;
  model: string;
  /** Thinking level actually sent to the provider, after clamping to the model. */
  thinkingLevel: string;
  /** Injectable clock, so tests produce deterministic timestamps. */
  now?: () => number;
  systemPrompt: string;
  /** Replayed history, recorded as trace input only. */
  history: readonly AgentMessage[];
  prompt: string;
}

function clip(text: string): string {
  return text.length <= MAX_TRACE_TEXT ? text : `${text.slice(0, MAX_TRACE_TEXT)}… [truncated]`;
}

function traceContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  // Image bytes are useless in a trace and would dwarf everything else.
  return content.map((part: { type?: string; mimeType?: string }) =>
    part?.type === "image" ? { type: "image", mimeType: part.mimeType } : part,
  );
}

function traceMessage(message: AgentMessage): unknown {
  return { role: message.role, content: traceContent((message as { content?: unknown }).content) };
}

function serialize(value: unknown): string {
  try {
    return clip(JSON.stringify(value) ?? "");
  } catch {
    return "";
  }
}

function usageDetails(usage: Usage): string {
  return serialize({
    input: usage.input,
    output: usage.output,
    cache_read: usage.cacheRead,
    cache_write: usage.cacheWrite,
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    total: usage.totalTokens,
  });
}

function costDetails(usage: Usage): string {
  // Mirrors the usage keys: Langfuse pairs the two maps by name.
  return serialize({
    input: usage.cost.input,
    output: usage.cost.output,
    cache_read: usage.cost.cacheRead,
    cache_write: usage.cost.cacheWrite,
    total: usage.cost.total,
  });
}

/**
 * Builds the span tree of one agent run: a root span for the run, a generation
 * per model turn, and a span per tool call.
 *
 * Replayed history is recorded as the input of the run, never as a generation.
 * A replayed message carries the current run's provider and no usage, so exporting
 * it as a generation would invent free calls that never ran.
 */
export class RunTraceRecorder {
  readonly trace: RunTrace;
  private readonly root?: RunTraceSpan;
  private generation?: RunTraceSpan;
  private readonly tools = new Map<string, RunTraceSpan>();
  private pendingInput: unknown[] = [];
  private turns = 0;
  private firstTokenSeen = false;

  constructor(private readonly options: RunTraceRecorderOptions) {
    this.trace = new RunTrace({ now: options.now });
    this.root = this.trace.openSpan({
      name: "rakazo.run",
      attributes: {
        "langfuse.observation.type": "span",
        "langfuse.trace.name": "agent run",
        "langfuse.session.id": options.threadId,
        ...(options.userId ? { "langfuse.user.id": options.userId } : {}),
        "langfuse.trace.input": serialize({
          system: options.systemPrompt,
          history: options.history.map(traceMessage),
          prompt: options.prompt,
        }),
        "langfuse.trace.metadata.runId": options.runId,
        "langfuse.trace.metadata.botId": options.botId,
        ...(options.correlationTraceId
          ? { "langfuse.trace.metadata.correlationId": options.correlationTraceId }
          : {}),
        "langfuse.observation.model.name": options.model,
        "langfuse.trace.metadata.provider": options.provider,
        "langfuse.trace.metadata.thinkingLevel": options.thinkingLevel,
      },
    });
    this.pendingInput.push({ role: "user", content: options.prompt });
  }

  turnStart(): void {
    if (this.generation) return;
    this.turns += 1;
    this.generation = this.trace.openSpan(
      {
        name: `generation ${this.turns}`,
        attributes: {
          "langfuse.observation.type": "generation",
          "langfuse.observation.model.name": this.options.model,
          "langfuse.observation.metadata.thinkingLevel": this.options.thinkingLevel,
          "langfuse.observation.input": serialize(this.pendingInput),
        },
      },
      this.root,
    );
    this.pendingInput = [];
    this.firstTokenSeen = false;
  }

  /**
   * Marks the first streamed text or thinking delta of the open generation.
   * Langfuse derives time to first token from this timestamp and the span start.
   */
  firstToken(): void {
    if (!this.generation || this.firstTokenSeen) return;
    this.firstTokenSeen = true;
    this.generation.setAttributes({
      "langfuse.observation.completion_start_time": new Date(this.trace.now()).toISOString(),
    });
  }

  /** Records a message produced during the run as input to the next generation. */
  message(message: AgentMessage): void {
    if (message.role === "assistant") return;
    this.pendingInput.push(traceMessage(message));
  }

  assistantMessage(message: AgentMessage, usage?: Usage): void {
    const span = this.generation;
    this.generation = undefined;
    if (!span) return;
    span.setAttributes({
      "langfuse.observation.output": serialize(traceMessage(message)),
      ...(usage
        ? {
            "langfuse.observation.usage_details": usageDetails(usage),
            "langfuse.observation.cost_details": costDetails(usage),
          }
        : {}),
    });
    span.end();
  }

  toolStart(toolCallId: string, toolName: string, args: unknown): void {
    const span = this.trace.openSpan(
      {
        name: `tool ${toolName}`,
        attributes: {
          "langfuse.observation.type": "tool",
          "langfuse.observation.input": serialize(args),
        },
      },
      this.root,
    );
    if (span) this.tools.set(toolCallId, span);
  }

  toolEnd(toolCallId: string, result: unknown, isError: boolean): void {
    const span = this.tools.get(toolCallId);
    if (!span) return;
    this.tools.delete(toolCallId);
    span.setAttributes({ "langfuse.observation.output": serialize(result) });
    span.end(isError ? { ok: false, error: new Error("tool failed") } : { ok: true });
  }

  /** Lets the tool call record the model calls it makes itself, nested under its span. */
  toolTrace(toolCallId: string): ToolCallTrace {
    return {
      generation: (name, input) => {
        const tool = this.tools.get(toolCallId);
        if (!tool) return undefined;
        const span = this.trace.openSpan(
          {
            name,
            attributes: {
              "langfuse.observation.type": "generation",
              "langfuse.observation.input": serialize(input),
            },
          },
          tool,
        );
        if (!span) return undefined;
        return {
          end: (result: ToolCallGenerationResult) => {
            const metadata: Record<string, string | number | boolean> = {};
            for (const [key, value] of Object.entries(result.metadata ?? {})) {
              if (value !== undefined) metadata[`langfuse.observation.metadata.${key}`] = value;
            }
            const { inputTokens, cost } = result.usage ?? {};
            span.setAttributes({
              "langfuse.observation.output": serialize(result.output),
              ...(result.model ? { "langfuse.observation.model.name": result.model } : {}),
              ...(inputTokens === undefined
                ? {}
                : { "langfuse.observation.usage_details": serialize({ input: inputTokens }) }),
              ...(cost === undefined
                ? {}
                : { "langfuse.observation.cost_details": serialize({ total: cost }) }),
              ...metadata,
            });
            span.end(
              result.error === undefined
                ? { ok: true }
                : { ok: false, error: new Error(result.error) },
            );
          },
        };
      },
    };
  }

  /** Closes every span still open, including ones abandoned by an aborted run. */
  finish(output: string, error?: unknown): void {
    for (const span of this.tools.values()) span.end({ ok: false, error });
    this.tools.clear();
    this.generation?.end({ ok: error === undefined, error });
    this.generation = undefined;
    this.root?.setAttributes({ "langfuse.trace.output": clip(output) });
    this.root?.end(error === undefined ? { ok: true } : { ok: false, error });
  }
}
