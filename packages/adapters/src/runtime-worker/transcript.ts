import type {
  AgentRuntimeEvent,
  ConnectorTool,
  GuestBody,
  HarnessTranscriptEntry,
  ModelDialect,
  ReplyFinal,
} from "@rakazo/adapter-kit";
import type { ControllerCallRecord, IngestResult } from "./dialects/pi-ai-history.js";
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

function harnessEntries(
  { entries }: IngestResult,
  controllerTools: ReadonlySet<string>,
): HarnessTranscriptEntry[] {
  return entries.flatMap((entry): HarnessTranscriptEntry[] => {
    if (entry.kind === "summary") return [entry];
    return (entry.turn.parts ?? []).flatMap((part) =>
      part.type === "toolCalls"
        ? part.calls
            .filter((call) => !controllerTools.has(call.name))
            .map((call) => ({
              kind: "call" as const,
              callId: call.id,
              name: call.name,
              args: call.args,
              output: call.output,
            }))
        : [],
    );
  });
}

/**
 * The controller's half of a native harness's transcript. It keeps what it answered each tool
 * call of the attempt's root agent, and ingests the one transcript against that record, so a
 * result the harness claims for a controller tool never replaces the controller's.
 */
export function transcriptIngest(clean: (text: string) => string) {
  const answers: ControllerCallRecord[] = [];
  let ingested = false;
  return {
    answered(call: ToolCall, reply: ReplyFinal): ReplyFinal {
      if (call.agent !== "root") return reply;
      if (reply.type === "tool.result") {
        answers.push({ name: call.name, output: clean(outputText(reply.output)) });
      } else if (reply.type === "error") {
        answers.push({ name: call.name, output: reply.message });
      }
      return reply;
    },
    /** The event for the attempt's transcript, or nothing for a second one. */
    ingest(
      body: Transcript,
      tools: readonly ConnectorTool[],
      harness: string,
    ): TranscriptEvent | undefined {
      if (ingested) return undefined;
      ingested = true;
      const native = new Set(nativeToolsForHarness(harness).map((tool) => tool.name));
      const controllerTools = tools.map((tool) => tool.name).filter((name) => !native.has(name));
      const result = INGEST[body.dialect](body.messages, answers, controllerTools, clean);
      return {
        type: "transcript",
        entries: harnessEntries(result, new Set(controllerTools)),
        unverifiedCalls: result.unverifiedCalls,
      };
    },
  };
}
