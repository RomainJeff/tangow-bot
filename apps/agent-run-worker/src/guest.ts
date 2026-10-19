import type {
  AgentInputImage,
  AgentRunRequest,
  GuestBody,
  GuestImage,
  GuestModel,
  ReplyFinal,
  ReplyPart,
  SubagentLog,
  WorkerIdentity,
  WorkerStartV1,
} from "@rakazo/adapter-kit";
import { PiAgentRuntime } from "@rakazo/adapters";
import {
  capabilityWorker,
  encodeMessage,
  type FrameChannel,
  readControllerFrame,
  relayedModel,
  relayStreamFn,
  WORKER_LIMITS,
} from "@rakazo/adapters/runtime-worker";
import { LOCAL_TOOLS } from "./local-tools.js";
import { createOutbox } from "./outbox.js";

/** How the guest's run ended. Only `done` and `paused` are a controller's normal stop. */
export type GuestExit = "done" | "paused" | "cancelled" | "disconnected" | "refused";

export interface GuestOptions {
  /** One per connection, in order. The guest gives up when they run out. */
  channels: AsyncIterable<FrameChannel>;
  capability: string;
  /** Where tools keep output too long for the model. */
  spoolDir: string;
}

function sameWorker(a: WorkerIdentity, b: WorkerIdentity) {
  return a.runId === b.runId && a.attemptId === b.attemptId && a.fence === b.fence;
}

function decodeImages(images: GuestImage[] | undefined): AgentInputImage[] {
  return (images ?? []).map((image) => ({ ...image, data: Buffer.from(image.data, "base64") }));
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * The guest host: the controller's PiAgentRuntime policy, run here, with every callback a frame.
 * It holds no key and no secret. A guest-placed tool runs here only after the controller granted
 * its start, and its result counts once the controller recorded it.
 */
export async function runGuest(options: GuestOptions): Promise<GuestExit> {
  const worker = capabilityWorker(options.capability);
  if (!worker) throw new Error("Unreadable worker capability");
  const outbox = createOutbox(worker);
  const cancel = new AbortController();
  const started = deferred<WorkerStartV1 | null>();
  const link = { finished: false, lost: false };
  let current: FrameChannel | undefined;

  const connections = (async () => {
    for await (const channel of options.channels) {
      current = channel;
      await channel.send(
        encodeMessage({ version: 1, kind: "worker.hello", worker, capability: options.capability }),
      );
      outbox.attach((frame) => void channel.send(frame));
      for await (const frame of channel.frames) {
        const read = readControllerFrame(frame);
        if (!read.ok || !sameWorker(read.message.worker, worker)) continue;
        const message = read.message;
        if (message.kind === "worker.start") started.resolve(message);
        else if (message.kind === "worker.cancel") cancel.abort();
        else outbox.receive(message.payload);
      }
      outbox.detach();
      if (link.finished) return;
    }
    link.lost = true;
    started.resolve(null);
    cancel.abort();
    outbox.shutdown(new Error("The controller is unreachable"));
  })();

  const start = await started.promise;
  const exit = start
    ? await runAttempt(start, options.spoolDir, outbox, cancel, link)
    : "disconnected";
  link.finished = true;
  current?.close();
  outbox.shutdown(new Error("The run ended"));
  void connections.catch(() => undefined);
  return exit;
}

async function runAttempt(
  start: WorkerStartV1,
  spoolDir: string,
  outbox: ReturnType<typeof createOutbox>,
  cancel: AbortController,
  link: { lost: boolean },
): Promise<GuestExit> {
  const { run, worker, workspace } = start;
  const signal = cancel.signal;
  const placement = new Map(run.tools.map((tool) => [tool.name, tool.where]));
  const helperRefs = new Map<string, string>();
  const helperModels = new Map<string, GuestModel>();
  const announcements = new Map<string, ReturnType<typeof deferred<void>>>();
  const announcement = (executionId: string) => {
    const existing = announcements.get(executionId);
    if (existing) return existing;
    const created = deferred<void>();
    announcements.set(executionId, created);
    return created;
  };

  let refused = false;
  // A refusal ends the channel: the run stops here, whatever was waiting on it.
  const send = async (body: GuestBody, onPart?: (part: ReplyPart) => void) => {
    const reply = await outbox.request(body, onPart);
    if (reply.type !== "refused") return reply;
    refused = true;
    cancel.abort();
    throw new Error(`The controller refused ${body.type}: ${reply.reason}`);
  };

  const decide = async <T extends ReplyFinal["type"]>(
    body: GuestBody,
    expected: T,
  ): Promise<Extract<ReplyFinal, { type: T }>> => {
    const reply = await send(body);
    if (reply.type === expected) return reply as Extract<ReplyFinal, { type: T }>;
    throw new Error(
      reply.type === "error" ? reply.message : `Unexpected reply ${reply.type} to ${body.type}`,
    );
  };

  const callTool =
    (agent: string): NonNullable<AgentRunRequest["executeTool"]> =>
    async (name, args, executionId) => {
      await announcement(executionId).promise;
      announcements.delete(executionId);
      const reply = await send({ type: "tool.call", agent, callId: executionId, name, args });
      if (reply.type === "tool.result") return reply.output;
      if (reply.type !== "tool.grant") {
        throw new Error(reply.type === "error" ? reply.message : `Unexpected reply ${reply.type}`);
      }
      const tool = placement.get(name) === "guest" ? LOCAL_TOOLS[name] : undefined;
      const output = tool
        ? await tool(args, { cwd: workspace.cwd, signal, spoolDir })
        : {
            text: `${name} cannot run in this worker.`,
            isError: true,
            truncated: false,
            totalBytes: 0,
          };
      await decide({ type: "tool.done", callId: executionId, output }, "tool.recorded");
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
    executeTool: callTool("root"),
    async claimSteering(seenIds) {
      const reply = await decide({ type: "steering.claim", seenIds }, "steering");
      return reply.messages.map((message) => ({
        ...message,
        images: decodeImages(message.images),
      }));
    },
    async startSubagent(call): Promise<SubagentLog> {
      const opened = await decide(
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
        executeTool: callTool(agent),
        text: async (text) =>
          void (await decide({ type: "subagent.text", agent, text }, "recorded")),
        finish: async ({ status, result }) =>
          void (await decide({ type: "subagent.finish", agent, status, result }, "recorded")),
        abandon: async (result) =>
          void (await decide({ type: "subagent.abandon", agent, result }, "recorded")),
      };
    },
    async resolveModel(provider, id) {
      const model = helperModels.get(`${provider}/${id}`);
      if (!model) throw new Error("Per-call subagent model selection is unavailable");
      return relayedModel(model);
    },
  };

  const runtime = new PiAgentRuntime({
    streamFn: relayStreamFn(send, (agentId) => {
      if (agentId === undefined) return "root";
      const ref = helperRefs.get(agentId);
      if (!ref) throw new Error(`No helper ${agentId} was opened`);
      return ref;
    }),
  });

  let text = "";
  let flushTimer: NodeJS.Timeout | undefined;
  // Text is coalesced so a token stream does not cost a frame per token.
  const flushText = () => {
    clearTimeout(flushTimer);
    if (!text) return Promise.resolve();
    const body: GuestBody = { type: "text", text };
    text = "";
    return outbox.post(body);
  };

  try {
    for await (const event of runtime.run(request, { signal })) {
      if (event.type === "text") {
        text += event.text;
        if (Buffer.byteLength(text) >= WORKER_LIMITS.textFlushBytes) await flushText();
        else {
          clearTimeout(flushTimer);
          flushTimer = setTimeout(
            () => void flushText().catch(() => undefined),
            WORKER_LIMITS.textFlushMs,
          );
        }
        continue;
      }
      await flushText();
      switch (event.type) {
        case "progress":
        case "subagent":
          await outbox.post(event);
          break;
        case "tool":
          await outbox.post(event);
          announcement(event.executionId).resolve();
          break;
        case "ask":
        case "takeover":
          await decide(event, "recorded");
          break;
        case "done":
          return (await decide(event, "stop")).reason;
        case "usage":
        case "checkpoint":
          // The controller measures usage on the relay; checkpoints have no consumer.
          break;
        default:
          event satisfies never;
      }
    }
    return (await decide({ type: "failed", message: "The run ended without finishing" }, "stop"))
      .reason;
  } catch (error) {
    if (refused) return "refused";
    await flushText().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    const stop = await decide({ type: "failed", message }, "stop").catch(() => null);
    if (refused) return "refused";
    return stop?.reason ?? (link.lost ? "disconnected" : "cancelled");
  } finally {
    clearTimeout(flushTimer);
  }
}
