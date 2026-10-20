import path from "node:path";
import {
  FRAME_CAPABILITY,
  type GuestBody,
  type ReplyFinal,
  sameWorker,
  type WorkerStartV1,
} from "@rakazo/adapter-kit";
import {
  capabilityWorker,
  encodeMessage,
  type FrameChannel,
  readControllerFrame,
  WORKER_LIMITS,
} from "@rakazo/adapters/runtime-worker/wire";
import type { GuestHarness, HarnessHost, InformativeBody } from "./harness.js";
import { createOutbox, type Outbox } from "./outbox.js";

/** How the guest's run ended. Only `done` and `paused` are a controller's normal stop. */
export type GuestExit = "done" | "paused" | "cancelled" | "disconnected" | "refused";

export interface GuestOptions {
  /** One per connection, in order. The guest gives up when they run out. */
  channels: AsyncIterable<FrameChannel>;
  capability: string;
  harness: GuestHarness;
  /** Where tools keep output too long for the model. */
  spoolDir: string;
  /** Prefix of every guest path the controller names. `/` in a VM. */
  root?: string;
  /** Stops the run like a `worker.cancel`, for the process's own termination. */
  signal?: AbortSignal;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Runs one attempt's harness against its controller. The guest holds no key and no secret. A
 * guest-placed tool runs here only after the controller granted its start, and its result counts
 * once the controller recorded it.
 */
export async function runGuest(options: GuestOptions): Promise<GuestExit> {
  const worker = capabilityWorker(options.capability);
  if (!worker) throw new Error("Unreadable worker capability");
  const outbox = createOutbox(worker);
  const cancel = new AbortController();
  options.signal?.addEventListener("abort", () => cancel.abort(), { once: true });
  const started = deferred<WorkerStartV1 | null>();
  const link = { finished: false, lost: false };
  let current: FrameChannel | undefined;

  const connections = (async () => {
    for await (const channel of options.channels) {
      current = channel;
      await channel.send(
        encodeMessage({
          version: 1,
          kind: "worker.hello",
          worker,
          capability: options.capability,
          harness: options.harness.declaration,
        }),
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
    ? await runAttempt(start, options, outbox, cancel, link)
    : ("disconnected" as const);
  link.finished = true;
  current?.close();
  outbox.shutdown(new Error("The run ended"));
  void connections.catch(() => undefined);
  return exit;
}

async function runAttempt(
  start: WorkerStartV1,
  options: GuestOptions,
  outbox: Outbox,
  cancel: AbortController,
  link: { lost: boolean },
): Promise<GuestExit> {
  const { run, worker, workspace } = start;
  const signal = cancel.signal;
  const cwd = path.join(options.root ?? "/", workspace.cwd);
  const declared = new Set(options.harness.declaration.capabilities);
  const placement = new Map(run.tools.map((tool) => [tool.name, tool.where]));
  const announcements = new Map<string, ReturnType<typeof deferred<void>>>();
  const announcement = (callId: string) => {
    const existing = announcements.get(callId);
    if (existing) return existing;
    const created = deferred<void>();
    announcements.set(callId, created);
    return created;
  };

  let refused = false;
  const send = async (body: GuestBody, onPart?: Parameters<Outbox["request"]>[1]) => {
    const needed = FRAME_CAPABILITY[body.type];
    if (needed && !declared.has(needed)) throw new Error(`This harness does not offer ${needed}`);
    const reply = await outbox.request(body, onPart);
    if (reply.type !== "refused") return reply;
    refused = true;
    cancel.abort();
    throw new Error(`The controller refused ${body.type}: ${reply.reason}`);
  };

  const decide: HarnessHost["decide"] = async (body, expected) => {
    const reply = await send(body);
    if (reply.type === expected) return reply as Extract<ReplyFinal, { type: typeof expected }>;
    throw new Error(
      reply.type === "error" ? reply.message : `Unexpected reply ${reply.type} to ${body.type}`,
    );
  };

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

  const host: HarnessHost = {
    signal,
    async emit(body: InformativeBody) {
      if (body.type === "text") {
        text += body.text;
        if (Buffer.byteLength(text) >= WORKER_LIMITS.textFlushBytes) return flushText();
        clearTimeout(flushTimer);
        flushTimer = setTimeout(
          () => void flushText().catch(() => undefined),
          WORKER_LIMITS.textFlushMs,
        );
        return;
      }
      await flushText();
      await outbox.post(body);
      if (body.type === "tool") announcement(body.executionId).resolve();
    },
    decide: async (body, expected) => {
      await flushText();
      return decide(body, expected);
    },
    async model(body, onPart, abort) {
      const { seq, final } = await outbox.send(body, onPart);
      const onAbort = () =>
        void outbox.request({ type: "model.abort", re: seq }).catch(() => undefined);
      abort?.addEventListener("abort", onAbort, { once: true });
      try {
        const reply = await final;
        if (reply.type === "refused") {
          refused = true;
          cancel.abort();
          throw new Error(`The controller refused model.request: ${reply.reason}`);
        }
        return reply;
      } finally {
        abort?.removeEventListener("abort", onAbort);
      }
    },
    async callTool(agent, name, args, callId) {
      await announcement(callId).promise;
      announcements.delete(callId);
      const reply = await send({ type: "tool.call", agent, callId, name, args });
      if (reply.type === "tool.result") return { placement: "controller", output: reply.output };
      if (reply.type !== "tool.grant") {
        throw new Error(reply.type === "error" ? reply.message : `Unexpected reply ${reply.type}`);
      }
      const tool =
        placement.get(name) === "guest" &&
        options.harness.nativeTools.some((tool) => tool.name === name);
      const output = tool
        ? await options.harness.executeNativeTool(name, args, callId, {
            cwd,
            signal,
            spoolDir: options.spoolDir,
          })
        : {
            text: `${name} cannot run in this worker.`,
            isError: true,
            truncated: false,
            totalBytes: 0,
          };
      await decide({ type: "tool.done", callId, output }, "tool.recorded");
      return { placement: "guest", output };
    },
  };

  try {
    const done = await options.harness.run({ worker, run, cwd }, host);
    await flushText();
    return (await decide(done, "stop")).reason;
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
