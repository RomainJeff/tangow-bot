import type {
  AgentInputImage,
  AgentRunRequest,
  GuestImage,
  GuestModel,
  SubagentLog,
} from "@rakazo/adapter-kit";
import { PiAgentRuntime } from "@rakazo/adapters/pi-runtime";
import { piAiStreamFn, relayedModel } from "@rakazo/adapters/runtime-worker/pi-ai";
import type { DoneBody, GuestHarness, HarnessHost } from "../harness.js";

function decodeImages(images: GuestImage[] | undefined): AgentInputImage[] {
  return (images ?? []).map((image) => ({ ...image, data: Buffer.from(image.data, "base64") }));
}

function toolCaller(host: HarnessHost, agent: string): NonNullable<AgentRunRequest["executeTool"]> {
  return async (name, args, executionId) => {
    const outcome = await host.callTool(agent, name, args, executionId);
    if (outcome.placement === "controller") return outcome.output;
    const { output } = outcome;
    if (output.isError) throw new Error(output.text);
    return {
      kind: "agent_tool_result",
      content: [{ type: "text", text: output.text }],
      details: {
        truncated: output.truncated,
        totalBytes: output.totalBytes,
        spoolPath: output.spoolPath,
      },
    };
  };
}

/** The Pi harness: the controller's own PiAgentRuntime policy, with every callback a frame. */
export const piHarness: GuestHarness = {
  declaration: { name: "pi", capabilities: ["subagents", "steering"] },

  async run({ worker, run }, host): Promise<DoneBody> {
    const helperRefs = new Map<string, string>();
    const helperModels = new Map<string, GuestModel>();
    const request: AgentRunRequest = {
      botId: run.botId,
      threadId: run.threadId,
      runId: worker.runId,
      sourceMessageId: run.sourceMessageId,
      prompt: run.prompt,
      instructions: run.instructions,
      history: run.history,
      currentTurnImages: decodeImages(run.images),
      tools: run.tools.map(({ name, description, inputSchema, readOnly }) => ({
        name,
        description,
        inputSchema,
        readOnly,
      })),
      model: relayedModel(run.model),
      allowSilentEmpty: run.allowSilentEmpty,
      freeTextIsPrivate: run.freeTextIsPrivate,
      runRecap: run.runRecap,
      emptyResponseText: run.emptyResponseText,
      executeTool: toolCaller(host, "root"),
      async claimSteering(seenIds) {
        const reply = await host.decide({ type: "steering.claim", seenIds }, "steering");
        return reply.messages.map((message) => ({
          ...message,
          images: decodeImages(message.images),
        }));
      },
      async startSubagent(call): Promise<SubagentLog> {
        const opened = await host.decide(
          {
            type: "subagent.open",
            callId: call.callId,
            name: call.name,
            task: call.task,
            args: call.args,
            model: call.model,
          },
          "subagent.opened",
        );
        const agent = opened.agent;
        helperRefs.set(call.callId, agent);
        helperModels.set(`${call.model.provider}/${call.model.id}`, opened.model);
        return {
          executeTool: toolCaller(host, agent),
          text: async (text) =>
            void (await host.decide({ type: "subagent.text", agent, text }, "recorded")),
          finish: async ({ status, result }) =>
            void (await host.decide(
              { type: "subagent.finish", agent, status, result },
              "recorded",
            )),
          abandon: async (result) =>
            void (await host.decide({ type: "subagent.abandon", agent, result }, "recorded")),
        };
      },
      async resolveModel(provider, id) {
        const model = helperModels.get(`${provider}/${id}`);
        if (!model) throw new Error("Per-call subagent model selection is unavailable");
        return relayedModel(model);
      },
    };

    const runtime = new PiAgentRuntime({
      streamFn: piAiStreamFn(
        (body, onPart, signal) => host.model(body, onPart, signal),
        (agentId) => {
          if (agentId === undefined) return "root";
          const ref = helperRefs.get(agentId);
          if (!ref) throw new Error(`No helper ${agentId} was opened`);
          return ref;
        },
      ),
    });

    for await (const event of runtime.run(request, { signal: host.signal })) {
      switch (event.type) {
        case "text":
        case "progress":
        case "subagent":
        case "tool":
          await host.emit(event);
          break;
        case "ask":
        case "takeover":
          await host.decide(event, "recorded");
          break;
        case "done":
          return event;
        case "usage":
        case "checkpoint":
          // The controller measures usage on the relay; checkpoints have no consumer.
          break;
        default:
          event satisfies never;
      }
    }
    throw new Error("The run ended without finishing");
  },
};
