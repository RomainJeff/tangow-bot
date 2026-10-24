import type { AgentRuntimeEvent, GuestBody, ModelDialect, ReplyFinal } from "@rakazo/adapter-kit";
import { ingestPiAi } from "./dialects/pi-ai-history.js";
import { nativeToolsForHarness } from "./guest-input.js";

/** Each dialect's ingest of a native session. A new dialect is one entry here. */
const INGEST: { [D in ModelDialect]: typeof ingestPiAi } = { "pi-ai": ingestPiAi };

type ToolCall = Extract<GuestBody, { type: "tool.call" }>;
type Transcript = Extract<GuestBody, { type: "transcript" }>;
type TranscriptEvent = Extract<AgentRuntimeEvent, { type: "transcript" }>;

type AgentTranscript = {
  answered: Map<string, number>;
  ingest?: ReturnType<typeof ingestPiAi>;
};

/**
 * The controller's half of a native harness's transcripts. Per agent, it counts what it answered
 * each controller tool and ingests the agent's reports in order, so a result the harness claims
 * for a controller tool never replaces the controller's.
 */
export function transcriptIngest(clean: (text: string) => string) {
  const agents = new Map<string, AgentTranscript>();
  const agentOf = (agent: string) => {
    let state = agents.get(agent);
    if (!state) {
      state = { answered: new Map() };
      agents.set(agent, state);
    }
    return state;
  };
  return {
    answered(call: ToolCall, reply: ReplyFinal): ReplyFinal {
      if (reply.type === "tool.result" || reply.type === "error") {
        const { answered } = agentOf(call.agent);
        answered.set(call.name, (answered.get(call.name) ?? 0) + 1);
      }
      return reply;
    },
    /** The steps this report adds to the agent's earlier ones. */
    ingest(agent: string, body: Transcript, harness: string): TranscriptEvent {
      const state = agentOf(agent);
      state.ingest ??= INGEST[body.dialect]({
        answered: state.answered,
        nativeTools: nativeToolsForHarness(harness).map((tool) => tool.name),
        clean,
      });
      const { steps, unverifiedCalls } = state.ingest(body.messages);
      return { type: "transcript", entries: steps, unverifiedCalls };
    },
  };
}
