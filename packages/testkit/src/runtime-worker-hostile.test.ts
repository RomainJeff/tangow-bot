import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  ControllerMessageV1,
  GuestBody,
  LocalToolOutput,
  ReplyBody,
  WorkerIdentity,
} from "@rakazo/adapter-kit";
import {
  capabilityWorker,
  createWorkerAgentRuntime,
  encodeMessage,
  type FrameChannel,
  GUEST_TOOLS,
  type LaunchedGuest,
  memoryChannelPair,
  readControllerFrame,
  WORKER_LIMITS,
} from "@rakazo/adapters/runtime-worker";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { type ModelEmulatorRequest, startModelEmulator } from "./model-emulator.js";

/** A guest that speaks the wire by hand, so it can do what a conforming guest never would. */
function rawGuest(channel: FrameChannel, capability: string) {
  const worker = capabilityWorker(capability)!;
  const received: ControllerMessageV1[] = [];
  const replies = new Map<number, ReplyBody[]>();
  let notify = () => {};
  const closed = (async () => {
    for await (const frame of channel.frames) {
      const read = readControllerFrame(frame);
      if (!read.ok) continue;
      received.push(read.message);
      if (read.message.kind === "worker.reply") {
        const { re, body } = read.message.payload;
        replies.set(re, [...(replies.get(re) ?? []), body]);
      }
      notify();
    }
  })();
  const until = async <T>(check: () => T | undefined): Promise<T> => {
    while (true) {
      const found = check();
      if (found !== undefined) return found;
      await new Promise<void>((resume) => (notify = resume));
    }
  };
  return {
    received,
    closed,
    hello() {
      void channel.send(
        encodeMessage({
          version: 1,
          kind: "worker.hello",
          worker,
          capability,
          harness: { name: "pi", capabilities: ["subagents", "steering"] },
        }),
      );
      return until(() => received.find((message) => message.kind === "worker.start"));
    },
    send(seq: number, body: GuestBody) {
      void channel.send(
        encodeMessage({ version: 1, kind: "worker.event", worker, payload: { seq, body } }),
      );
    },
    /** Every reply body to `seq`, once one settles it or `count` arrived. */
    replies(seq: number, count = Infinity) {
      return until(() => {
        const bodies = replies.get(seq) ?? [];
        const settled = bodies.some(
          (body) => body.type !== "model.event" && body.type !== "end.refused",
        );
        return settled || bodies.length >= count ? bodies : undefined;
      });
    },
  };
}

/** Hands every launch to the test: it opens the guest's connections itself. */
function manualLauncher() {
  const launched = new Map<string, { capability: string; connect(): FrameChannel }>();
  const waiting = new Map<string, () => void>();
  return {
    launcher: {
      async launch(worker: WorkerIdentity, capability: string): Promise<LaunchedGuest> {
        const queue: FrameChannel[] = [];
        let wake = () => {};
        launched.set(worker.runId, {
          capability,
          connect() {
            const pair = memoryChannelPair();
            queue.push(pair.controller);
            wake();
            return pair.guest;
          },
        });
        waiting.get(worker.runId)?.();
        return {
          start: {
            version: 1,
            kind: "worker.start",
            worker,
            workspace: { cwd: "/workspace", mounts: [] },
            computer: "none",
          },
          connections: (async function* () {
            while (true) {
              const next = queue.shift();
              if (next) yield next;
              else await new Promise<void>((resume) => (wake = resume));
            }
          })(),
          exited: Promise.resolve(),
          release: async () => "released",
          holdsFence: async () => true,
        };
      },
    },
    async launchedFor(runId: string) {
      if (!launched.has(runId)) await new Promise<void>((resume) => waiting.set(runId, resume));
      return launched.get(runId)!;
    },
  };
}

const stillClock = { sleep: () => new Promise<void>(() => {}) };

function request(runId: string, overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId,
    prompt: "Do the thing.",
    instructions: "Be brief.",
    history: [],
    tools: [...GUEST_TOOLS],
    model: { provider: "openai-compatible", id: "unused", apiKey: "controller-only-key" },
    attempt: { id: `${runId}-attempt`, fence: 1 },
    secrets: ["hunter2-secret"],
    ...overrides,
  };
}

function consume(events: AsyncIterable<AgentRuntimeEvent>) {
  const seen: AgentRuntimeEvent[] = [];
  const done = (async () => {
    for await (const event of events) seen.push(event);
  })();
  done.catch(() => undefined);
  return { seen, done };
}

function setup() {
  const manual = manualLauncher();
  const marks: string[] = [];
  const runtime = createWorkerAgentRuntime({
    launcher: manual.launcher,
    stops: { mark: async (_attemptId, phase) => void marks.push(phase) },
    clock: stillClock,
  });
  return { runtime, marks, launchedFor: manual.launchedFor };
}

const bash = (callId: string): GuestBody => ({
  type: "tool",
  name: "bash",
  args: { command: "true" },
  executionId: callId,
});
const callBash = (callId: string): GuestBody => ({
  type: "tool.call",
  agent: "root",
  callId,
  name: "bash",
  args: { command: "true" },
});
const output = (text: string): LocalToolOutput => ({
  text,
  isError: false,
  truncated: false,
  totalBytes: Buffer.byteLength(text),
});

describe("a hostile guest", () => {
  it("cannot use another run's capability, nor reuse its own while it is bound", async () => {
    const { runtime, launchedFor } = setup();
    const callbacks = {
      executeTool: vi.fn(),
      executeLocalTool: vi.fn(),
      claimSteering: vi.fn(),
      startSubagent: vi.fn(),
      resolveModel: vi.fn(),
    };
    const runB = consume(runtime.run(request("run_b")));
    const b = await launchedFor("run_b");
    const runA = consume(runtime.run(request("run_a", callbacks)));
    const a = await launchedFor("run_a");

    const foreign = rawGuest(a.connect(), b.capability);
    void foreign.hello();
    await foreign.closed;
    await expect(runA.done).rejects.toThrow("The worker broke the run protocol: identity");
    expect(foreign.received).toEqual([]);
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();

    const guest = rawGuest(b.connect(), b.capability);
    expect((await guest.hello()).kind).toBe("worker.start");
    const replay = rawGuest(b.connect(), b.capability);
    void replay.hello();
    await replay.closed;
    expect(replay.received).toEqual([]);
    guest.send(1, { type: "text", text: "still bound" });
    await vi.waitFor(() => expect(runB.seen).toEqual([{ type: "text", text: "still bound" }]));
    await runtime.abort("run_b");
  });

  it("ends the run when it calls a tool the run does not expose", async () => {
    const { runtime, launchedFor } = setup();
    const run = consume(runtime.run(request("run_tools")));
    const launched = await launchedFor("run_tools");
    const guest = rawGuest(launched.connect(), launched.capability);
    await guest.hello();

    guest.send(1, { type: "tool", name: "drop_tables", args: {}, executionId: "x" });
    expect(await guest.replies(1)).toEqual([{ type: "refused", reason: "unknown_tool" }]);
    await expect(run.done).rejects.toThrow("The worker broke the run protocol: unknown_tool");
    expect(run.seen).toEqual([]);
  });

  it("cannot end a run while one of its tool calls is still open", async () => {
    const { runtime, launchedFor } = setup();
    const recorded = Promise.withResolvers<LocalToolOutput>();
    const run = consume(
      runtime.run(
        request("run_end", {
          executeLocalTool: async (_name, _args, _id, start) => {
            recorded.resolve(await start(new AbortController().signal));
            return "recorded";
          },
        }),
      ),
    );
    const launched = await launchedFor("run_end");
    const guest = rawGuest(launched.connect(), launched.capability);
    await guest.hello();

    guest.send(1, bash("c1"));
    guest.send(2, callBash("c1"));
    expect(await guest.replies(2)).toEqual([{ type: "tool.grant" }]);
    guest.send(3, { type: "done", text: "All done." });
    expect(await guest.replies(3, 1)).toEqual([{ type: "end.refused", pending: ["c1"] }]);
    expect(run.seen.map((event) => event.type)).toEqual(["tool"]);

    guest.send(4, { type: "tool.done", callId: "c1", output: output("ok") });
    expect(await guest.replies(4)).toEqual([{ type: "tool.recorded" }]);
    await run.done;
    expect(run.seen.map((event) => event.type)).toEqual(["tool", "done"]);
    expect(await guest.replies(3)).toEqual([
      { type: "end.refused", pending: ["c1"] },
      { type: "stop", reason: "done" },
    ]);
  });

  it("gets its tool output cut and redacted with the run's current secrets, and a frame over the limit ends the run", async () => {
    const { runtime, launchedFor } = setup();
    const results: LocalToolOutput[] = [];
    const secrets = ["hunter2-secret"];
    const run = consume(
      runtime.run(
        request("run_big", {
          secrets,
          executeLocalTool: async (_name, _args, _id, start) => {
            results.push(await start(new AbortController().signal));
            return "recorded";
          },
        }),
      ),
    );
    const launched = await launchedFor("run_big");
    const guest = rawGuest(launched.connect(), launched.capability);
    await guest.hello();

    guest.send(1, bash("big"));
    guest.send(2, callBash("big"));
    await guest.replies(2);
    guest.send(3, {
      type: "tool.done",
      callId: "big",
      output: output(`hunter2-secret ${"x".repeat(200 * 1024)}`),
    });
    expect(await guest.replies(3)).toEqual([{ type: "tool.recorded" }]);
    const [result] = results;
    expect(Buffer.byteLength(result!.text)).toBeLessThanOrEqual(
      WORKER_LIMITS.controllerResultBytes,
    );
    expect(result!.text.startsWith("[redacted] xxx")).toBe(true);
    expect(
      result!.text.endsWith(
        `[cut by the controller at ${WORKER_LIMITS.controllerResultBytes} bytes]`,
      ),
    ).toBe(true);

    secrets.push("revealed-later");
    guest.send(4, bash("object"));
    guest.send(5, callBash("object"));
    await guest.replies(5);
    guest.send(6, {
      type: "tool.done",
      callId: "object",
      output: {
        result: { content: "hunter2-secret and revealed-later", lines: ["hunter2-secret"] },
      },
    });
    expect(await guest.replies(6)).toEqual([{ type: "tool.recorded" }]);
    expect(results[1]).toEqual({
      result: { content: "[redacted] and [redacted]", lines: ["[redacted]"] },
    });

    guest.send(7, bash("huge"));
    guest.send(8, callBash("huge"));
    await guest.replies(8);
    guest.send(9, {
      type: "tool.done",
      callId: "huge",
      output: output("y".repeat(2 * 1024 * 1024)),
    });
    await expect(run.done).rejects.toThrow("The worker broke the run protocol: too_large");
    expect(results).toHaveLength(2);
  });

  it("cannot name the model, connection or endpoint its model calls go to", async () => {
    const { runtime, launchedFor } = setup();
    const run = consume(runtime.run(request("run_model_target")));
    const launched = await launchedFor("run_model_target");
    const guest = rawGuest(launched.connect(), launched.capability);
    await guest.hello();

    guest.send(1, {
      type: "model.request",
      agent: "root",
      dialect: "pi-ai",
      call: {
        context: { messages: [{ role: "user", content: "Hi", timestamp: 0 }] },
        options: { model: "other-model", baseUrl: "https://foreign.invalid/v1", apiKey: "k" },
      },
    } as unknown as GuestBody);

    await expect(run.done).rejects.toThrow("The worker broke the run protocol: invalid");
    expect(guest.received.map((message) => message.kind)).toEqual(["worker.start"]);
  });

  it("reaches only the run's own model, key and endpoint, with its live secrets masked", async () => {
    const seen: ModelEmulatorRequest[] = [];
    const server = await startModelEmulator({
      apiKey: "controller-only-key",
      steps: [{ expect: (body) => void seen.push(body), response: { type: "text", text: "Ok." } }],
    });
    onTestFinished(() => server.close());
    const secrets = ["hunter2-secret"];
    const { runtime, launchedFor } = setup();
    const run = consume(runtime.run(request("run_model_relay", { model: server.model, secrets })));
    const launched = await launchedFor("run_model_relay");
    const guest = rawGuest(launched.connect(), launched.capability);
    await guest.hello();
    secrets.push("revealed-later");

    guest.send(1, {
      type: "model.request",
      agent: "root",
      dialect: "pi-ai",
      call: {
        context: {
          messages: [
            { role: "user", content: "Read the env file.", timestamp: 0 },
            {
              role: "assistant",
              content: [
                { type: "toolCall", id: "c1", name: "bash", arguments: { command: "env" } },
              ],
              api: "anthropic-messages",
              provider: "anthropic",
              model: "another-model",
              baseUrl: "https://foreign.invalid/v1",
              headers: { authorization: "Bearer stolen" },
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
              stopReason: "toolUse",
              timestamp: 1,
            },
            {
              role: "toolResult",
              toolCallId: "c1",
              toolName: "bash",
              content: [{ type: "text", text: "TOKEN=hunter2-secret\nOTHER=revealed-later" }],
              isError: false,
              timestamp: 2,
            },
          ],
        },
        options: { sessionId: "thread-of-someone-else" },
      },
    });

    expect((await guest.replies(1)).at(-1)).toEqual({ type: "model.end" });
    server.assertComplete();
    const sent = JSON.stringify(seen[0]?.messages);
    expect(sent).toContain("TOKEN=[redacted]\\nOTHER=[redacted]");
    expect(sent).not.toContain("hunter2-secret");
    expect(sent).not.toContain("revealed-later");
    expect(run.seen).toEqual([
      expect.objectContaining({
        type: "usage",
        provider: "openai-compatible",
        model: "offline-fixture",
      }),
    ]);
    await runtime.abort("run_model_relay");
    await run.done.catch(() => undefined);
  });

  it("relays a large image the guest read untouched, and still masks the text beside it", async () => {
    const seen: ModelEmulatorRequest[] = [];
    const server = await startModelEmulator({
      apiKey: "controller-only-key",
      steps: [{ expect: (body) => void seen.push(body), response: { type: "text", text: "Ok." } }],
    });
    onTestFinished(() => server.close());
    const secrets = ["one", "two", "three", "four", "five", "six"].map((name) => `${name}-secret`);
    const { runtime, launchedFor } = setup();
    const run = consume(
      runtime.run(
        request("run_model_image", { model: { ...server.model, acceptsImages: true }, secrets }),
      ),
    );
    const launched = await launchedFor("run_model_image");
    const guest = rawGuest(launched.connect(), launched.capability);
    await guest.hello();
    const image = "iVBORw0KGgo".padEnd(1.5 * 1024 * 1024, "A");

    guest.send(1, {
      type: "model.request",
      agent: "root",
      dialect: "pi-ai",
      call: {
        context: {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Look: TOKEN=two-secret" },
                { type: "image", data: image, mimeType: "image/png" },
              ],
              timestamp: 0,
            },
          ],
        },
        options: {},
      },
    });

    expect((await guest.replies(1)).at(-1)).toEqual({ type: "model.end" });
    const sent = JSON.stringify(seen[0]?.messages);
    expect(sent).toContain("Look: TOKEN=[redacted]");
    expect(sent).toContain(`data:image/png;base64,${image}`);
    await runtime.abort("run_model_image");
    await run.done.catch(() => undefined);
  });

  it("stops the controller's upstream model call when it aborts the call", async () => {
    const upstream = { opened: Promise.withResolvers<void>(), closed: false };
    const server = await startModelEmulator({
      apiKey: "controller-only-key",
      steps: [
        {
          expect() {},
          response: {
            type: "hold",
            text: "Thinking",
            onOpen: () => upstream.opened.resolve(),
            onClose: () => {
              upstream.closed = true;
            },
          },
        },
      ],
    });
    onTestFinished(() => server.close());
    const { runtime, launchedFor } = setup();
    const run = consume(runtime.run(request("run_model_abort", { model: server.model })));
    const launched = await launchedFor("run_model_abort");
    const guest = rawGuest(launched.connect(), launched.capability);
    await guest.hello();

    guest.send(1, {
      type: "model.request",
      agent: "root",
      dialect: "pi-ai",
      call: { context: { messages: [{ role: "user", content: "Hi", timestamp: 0 }] }, options: {} },
    });
    await upstream.opened.promise;
    expect(upstream.closed).toBe(false);
    guest.send(2, { type: "model.abort", re: 1 });

    expect(await guest.replies(2)).toEqual([{ type: "ack" }]);
    await vi.waitFor(() => expect(upstream.closed).toBe(true));
    const relayed = await guest.replies(1);
    expect(relayed.at(-1)).toEqual({ type: "model.end" });
    expect(relayed.at(-2)).toMatchObject({
      type: "model.event",
      event: { type: "error", reason: "aborted" },
    });
    await runtime.abort("run_model_abort");
    await run.done.catch(() => undefined);
    server.assertComplete();
  });
});
