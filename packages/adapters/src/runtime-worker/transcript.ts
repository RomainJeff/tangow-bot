import type {
  AgentRuntimeEvent,
  ConnectorTool,
  GuestBody,
  ModelDialect,
  ReplyFinal,
} from "@rakazo/adapter-kit";
import type { ControllerCallRecord } from "./dialects/pi-ai-history.js";
import { ingestPiAi } from "./dialects/pi-ai-history.js";
import { nativeToolsForHarness } from "./guest-input.js";

/** Each dialect's ingest of a native session. A new dialect is one entry here. */
const INGEST: { [D in ModelDialect]: typeof ingestPiAi } = { "pi-ai": ingestPiAi };

type ToolCall = Extract<GuestBody, { type: "tool.call" }>;
type Transcript = Extract<GuestBody, { type: "transcript" }>;
type TranscriptEvent = Extract<AgentRuntimeEvent, { type: "transcript" }>;

function outputText(output: unknown): string {
  const content = (output as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    return content
      .map((block: { type?: string; text?: string }) =>
        block.type === "text" ? (block.text ?? "") : `[${block.type}]`,
      )
      .join("\n");
  }
  return typeof output === "string" ? output : JSON.stringify(output ?? null);
}

/**
 * The controller's half of a native harness's transcripts. It keeps what it answered each tool
 * call of the attempt, per agent, and ingests each agent's one transcript against that record,
 * so a result the harness claims for a controller tool never replaces the controller's.
 */
export function transcriptIngest(clean: (text: string) => string) {
  const answers = new Map<string, ControllerCallRecord[]>();
  const ingested = new Set<string>();
  const record = (call: ToolCall, output: string) => {
    const agent = answers.get(call.agent) ?? [];
    agent.push({ callId: call.callId, name: call.name, output });
    answers.set(call.agent, agent);
  };
  return {
    answered(call: ToolCall, reply: ReplyFinal): ReplyFinal {
      if (reply.type === "tool.result") record(call, clean(outputText(reply.output)));
      else if (reply.type === "error") record(call, reply.message);
      return reply;
    },
    /** The event for an agent's transcript, or nothing for its second one. */
    ingest(
      agent: string,
      body: Transcript,
      tools: readonly ConnectorTool[],
      harness: string,
    ): TranscriptEvent | undefined {
      if (ingested.has(agent)) return undefined;
      ingested.add(agent);
      const nativeTools = nativeToolsForHarness(harness).map((tool) => tool.name);
      const result = INGEST[body.dialect](body.messages, {
        answers: answers.get(agent) ?? [],
        controllerTools: tools
          .map((tool) => tool.name)
          .filter((name) => !nativeTools.includes(name)),
        nativeTools,
        clean,
      });
      return { type: "transcript", entries: result.steps, unverifiedCalls: result.unverifiedCalls };
    },
  };
}
