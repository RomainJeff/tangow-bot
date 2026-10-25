import type {
  AgentRuntimeEvent,
  GuestBody,
  ModelDialect,
  RefusalReason,
  ReplyFinal,
} from "@rakazo/adapter-kit";
import { ingestPiAi } from "./dialects/pi-ai-history.js";
import { nativeToolsForHarness } from "./guest-input.js";

/** Each dialect's ingest of a native session. A new dialect is one entry here. */
const INGEST: { [D in ModelDialect]: typeof ingestPiAi } = { "pi-ai": ingestPiAi };

type ToolCall = Extract<GuestBody, { type: "tool.call" }>;
type Transcript = Extract<GuestBody, { type: "transcript" }>;
type TranscriptEvent = Extract<AgentRuntimeEvent, { type: "transcript" }>;

type AgentTranscript = {
  answered: Map<string, number>;
  /** Model requests relayed, and the responses and compactions reported, which each need one. */
  requests: number;
  responses: number;
  /** Tool calls reported, and the tool results reported, which each answer one. */
  calls: number;
  results: number;
  ingest?: ReturnType<typeof ingestPiAi>;
};

/**
 * The controller's half of a native harness's transcripts. Per agent, it counts what it answered
 * each controller tool and ingests the agent's reports in order, so a result the harness claims
 * for a controller tool never replaces the controller's. A report needs the model requests and
 * calls behind it.
 */
export function transcriptIngest(clean: (text: string) => string) {
  const agents = new Map<string, AgentTranscript>();
  // The log pairs a result with the latest open call of its id: one id is one side's for the attempt.
  const controllerCalls = new Set<string>();
  const nativeCalls = new Set<string>();
  const agentOf = (agent: string) => {
    let state = agents.get(agent);
    if (!state) {
      state = { answered: new Map(), requests: 0, responses: 0, calls: 0, results: 0 };
      agents.set(agent, state);
    }
    return state;
  };
  return {
    /** Takes the id for a controller call, unless the harness already reported one of its own. */
    claim(callId: string): boolean {
      if (nativeCalls.has(callId)) return false;
      controllerCalls.add(callId);
      return true;
    },
    requested(agent: string) {
      agentOf(agent).requests += 1;
    },
    answered(call: ToolCall, reply: ReplyFinal): ReplyFinal {
      if (reply.type === "tool.result" || reply.type === "error") {
        const { answered } = agentOf(call.agent);
        answered.set(call.name, (answered.get(call.name) ?? 0) + 1);
      }
      return reply;
    },
    /** The steps this report adds to the agent's earlier ones, or why it is refused. */
    ingest(agent: string, body: Transcript, harness: string): TranscriptEvent | RefusalReason {
      const state = agentOf(agent);
      state.ingest ??= INGEST[body.dialect]({
        answered: state.answered,
        nativeTools: nativeToolsForHarness(harness).map((tool) => tool.name),
        clean,
      });
      const { steps, unverifiedCalls } = state.ingest(body.messages);
      for (const message of body.messages) {
        if (message.role === "toolResult") state.results += 1;
        else state.responses += 1;
      }
      for (const step of steps) {
        if (step.kind === "controller") state.calls += 1;
        if (step.kind !== "call") continue;
        if (controllerCalls.has(step.callId)) return "invalid";
        nativeCalls.add(step.callId);
        state.calls += 1;
      }
      if (state.responses > state.requests || state.results > state.calls) return "budget";
      return { type: "transcript", entries: steps, unverifiedCalls };
    },
  };
}
