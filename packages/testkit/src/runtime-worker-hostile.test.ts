import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  ControllerMessageV1,
  GuestBody,
  LocalToolOutput,
  ReplyBody,
  WorkerIdentity,
} from "@rakazo/adapter-kit";
import type { WorkerClock } from "@rakazo/adapters/runtime-worker";
import {
  capabilityWorker,
  createWorkerAgentRuntime,
  encodeMessage,
  type FrameChannel,
  type LaunchedGuest,
  memoryChannelPair,
  readControllerFrame,
  WORKER_LIMITS,
  WORKER_NATIVE_TOOLS,
} from "@rakazo/adapters/runtime-worker";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { type ModelEmulatorRequest, startModelEmulator } from "./model-emulator.js";

/** A guest that speaks the wire by hand, so it can do what a conforming guest never would. */
function rawGuest(channel: FrameChannel, capability: string) {
  const worker = capabilityWorker(capability)!;
  const received: ControllerMessageV1[] = [];
  const replies = new Map<number, ReplyBody[]>();
  const waiting = new Set<() => void>();
  const closed = (async () => {
    for await (const frame of channel.frames) {
      const read = readControllerFrame(frame);
      if (!read.ok) continue;
      received.push(read.message);
      if (read.message.kind === "worker.reply") {
        const { re, body } = read.message.payload;
        replies.set(re, [...(replies.get(re) ?? []), body]);
      }
      for (const resume of waiting) resume();
      waiting.clear();
    }
  })();
  const until = async <T>(check: () => T | undefined): Promise<T> => {
    while (true) {
      const found = check();
      if (found !== undefined) return found;
      await new Promise<void>((resume) => waiting.add(resume));
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
  const fence: { standing: "executing" | "paused" | "lost" } = { standing: "executing" };
  const launched = new Map<string, { capability: string; connect(): FrameChannel }>();
  const waiting = new Map<string, () => void>();
  return {
    fence,
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
          holdsFence: async () => fence.standing === "executing",
          ownsFence: async () => fence.standing !== "lost",
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
    tools: [...WORKER_NATIVE_TOOLS],
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

function setup(clock: WorkerClock = stillClock) {
  const manual = manualLauncher();
  const marks: string[] = [];
  const runtime = createWorkerAgentRuntime({
    launcher: manual.launcher,
    stops: { mark: async (_attemptId, phase) => void marks.push(phase) },
    clock,
  });
  return { runtime, marks, launchedFor: manual.launchedFor, fence: manual.fence };
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

const PAUSED = {
  kind: "agent_tool_result",
  content: [{ type: "text", text: "Waiting for approval." }],
  details: { approval: "paused" },
  terminate: true,
};
const pausedTools = [
  ...WORKER_NATIVE_TOOLS,
  ...["remember", "send_email"].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
  })),
];
const announce = (name: string, callId: string): GuestBody => ({
  type: "tool",
  name,
  args: {},
  executionId: callId,
});
const call = (name: string, callId: string): GuestBody => ({
  type: "tool.call",
  agent: "root",
  callId,
  name,
  args: {},
});
const modelRequest: GuestBody = {
  type: "model.request",
  agent: "root",
  dialect: "pi-ai",
  call: { context: { messages: [{ role: "user", content: "Go on.", timestamp: 0 }] }, options: {} },
};
const notRun = {
  type: "tool.result",
  output: expect.objectContaining({ details: { paused: true } }),
};

async function startGuest(
  runtime: ReturnType<typeof setup>["runtime"],
  launchedFor: ReturnType<typeof setup>["launchedFor"],
  runId: string,
  overrides: Partial<AgentRunRequest>,
) {
  const run = consume(runtime.run(request(runId, { tools: pausedTools, ...overrides })));
  const launched = await launchedFor(runId);
  const guest = rawGuest(launched.connect(), launched.capability);
  await guest.hello();
  let seq = 0;
  const ask = async (body: GuestBody) => {
    guest.send(++seq, body);
    return (await guest.replies(seq)).at(-1);
  };
  return { run, ask };
}

async function pauseOnTool(ask: (body: GuestBody) => Promise<ReplyBody | undefined>) {
  await ask(announce("send_email", "pause"));
  expect(await ask(call("send_email", "pause"))).toEqual({ type: "tool.result", output: PAUSED });
}

describe("the controller's pause guard, against a hostile harness", () => {
  it("answers every call after a pause without running it, and drops what the harness still says", async () => {
    const executeTool = vi.fn(async (name: string) => (name === "send_email" ? PAUSED : "saved"));
    const claimSteering = vi.fn(async () => [{ id: "s1", messageId: "m1", text: "Also this." }]);
    const { runtime, launchedFor } = setup();
    const { run, ask } = await startGuest(runtime, launchedFor, "run_calls", {
      executeTool,
      claimSteering,
      startSubagent: vi.fn(),
      resolveModel: vi.fn(),
    });
    await pauseOnTool(ask);

    for (const callId of ["after1", "after2"]) {
      expect(await ask(announce("remember", callId))).toEqual({ type: "ack" });
      expect(await ask(call("remember", callId))).toEqual(notRun);
    }
    expect(await ask({ type: "text", text: "Sent it anyway!" })).toEqual({ type: "ack" });
    expect(await ask({ type: "progress", text: "Sending more" })).toEqual({ type: "ack" });
    expect(
      await ask({
        type: "subagent",
        agentId: "helper",
        name: "helper",
        task: "Send it again.",
        status: "running",
      }),
    ).toEqual({ type: "ack" });
    expect(await ask({ type: "ask", text: "Send it twice?" })).toEqual({ type: "recorded" });
    expect(await ask({ type: "takeover", reason: "Log in for me." })).toEqual({
      type: "recorded",
    });
    expect(await ask({ type: "steering.claim", seenIds: [] })).toEqual({
      type: "steering",
      messages: [],
    });
    expect(
      await ask({
        type: "subagent.open",
        callId: "helper",
        name: "helper",
        task: "Send it again.",
        args: {},
        model: { provider: "openai-compatible", id: "unused" },
      }),
    ).toEqual({ type: "error", message: "This run is paused until the user answers." });
    expect(await ask({ type: "done", text: "All sent!" })).toEqual({
      type: "stop",
      reason: "paused",
    });

    await run.done;
    expect(run.seen).toEqual([
      { type: "tool", name: "send_email", args: {}, executionId: "pause" },
    ]);
    expect(executeTool.mock.calls.map(([name]) => name)).toEqual(["send_email"]);
  });

  it("pauses on a question to the user, and stops a harness that keeps calling tools", async () => {
    const executeTool = vi.fn(async () => "saved");
    const { runtime, launchedFor } = setup();
    const { run, ask } = await startGuest(runtime, launchedFor, "run_ask", { executeTool });
    expect(await ask({ type: "ask", text: "Which address?" })).toEqual({ type: "recorded" });

    for (let index = 1; index <= WORKER_LIMITS.pausedToolCalls; index += 1) {
      await ask(announce("remember", `c${index}`));
      expect(await ask(call("remember", `c${index}`))).toEqual(notRun);
    }
    await ask(announce("remember", "over"));
    expect(await ask(call("remember", "over"))).toEqual({ type: "stop", reason: "paused" });

    await run.done;
    expect(run.seen).toEqual([{ type: "ask", text: "Which address?" }]);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("does not grant a native call whose authorization ends after the pause", async () => {
    const authorized = Promise.withResolvers<void>();
    const started = Promise.withResolvers<string>();
    const { runtime, launchedFor } = setup();
    const { run, ask } = await startGuest(runtime, launchedFor, "run_late_grant", {
      executeLocalTool: async (_name, _args, _id, start) => {
        await authorized.promise;
        return start(new AbortController().signal).then(
          () => started.resolve("started"),
          (error: Error) => started.resolve(error.message),
        );
      },
    });
    await ask(bash("late"));
    const reply = ask(callBash("late"));
    expect(await ask({ type: "ask", text: "Which address?" })).toEqual({ type: "recorded" });
    authorized.resolve();

    expect(await reply).toEqual(notRun);
    expect(await started.promise).toBe("This run is paused until the user answers.");
    expect(await ask({ type: "done" })).toEqual({ type: "stop", reason: "paused" });
    await run.done;
  });

  it("pauses when a native call's authorization pauses the run", async () => {
    const executeTool = vi.fn(async () => "saved");
    const { runtime, launchedFor } = setup();
    const { run, ask } = await startGuest(runtime, launchedFor, "run_native_pause", {
      executeTool,
      executeLocalTool: async () => PAUSED,
    });
    await ask(bash("native"));
    expect(await ask(callBash("native"))).toEqual({ type: "tool.result", output: PAUSED });

    await ask(announce("remember", "after"));
    expect(await ask(call("remember", "after"))).toEqual(notRun);
    expect(await ask({ type: "text", text: "Ran it anyway!" })).toEqual({ type: "ack" });
    expect(await ask({ type: "done" })).toEqual({ type: "stop", reason: "paused" });

    await run.done;
    expect(run.seen).toEqual([
      { type: "tool", name: "bash", args: { command: "true" }, executionId: "native" },
    ]);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("pauses on a helper's pausing call, keeps its text out of the log after, and still closes it", async () => {
    const texts: string[] = [];
    const results: string[] = [];
    const { runtime, launchedFor } = setup();
    const { run, ask } = await startGuest(runtime, launchedFor, "run_helper", {
      executeTool: vi.fn(async () => "saved"),
      resolveModel: async () => request("run_helper").model,
      startSubagent: async () => ({
        executeTool: async () => PAUSED,
        text: async (text) => void texts.push(text),
        finish: async (outcome) => void results.push(outcome.result),
        abandon: async () => undefined,
      }),
    });
    expect(
      await ask({
        type: "subagent.open",
        callId: "helper",
        name: "helper",
        task: "Look around.",
        args: {},
        model: { provider: "openai-compatible", id: "unused" },
      }),
    ).toMatchObject({ type: "subagent.opened", agent: "helper:1" });
    await ask({ type: "subagent.text", agent: "helper:1", text: "Looking." });
    await ask(announce("send_email", "helper-send"));
    expect(
      await ask({ ...call("send_email", "helper-send"), agent: "helper:1" } as GuestBody),
    ).toEqual({ type: "tool.result", output: PAUSED });
    await ask(announce("remember", "root-after"));
    expect(await ask(call("remember", "root-after"))).toEqual(notRun);

    expect(await ask({ type: "subagent.text", agent: "helper:1", text: "Sent it!" })).toEqual({
      type: "recorded",
    });
    expect(
      await ask({
        type: "subagent.finish",
        agent: "helper:1",
        status: "completed",
        result: "Done.",
      }),
    ).toEqual({ type: "recorded" });
    expect(texts).toEqual(["Looking."]);
    expect(results).toEqual(["Done."]);
    await ask({ type: "done" });
    await run.done;
  });

  it("lets a paused attempt that still owns its run conclude, and refuses it once superseded", async () => {
    const server = await startModelEmulator({
      apiKey: "controller-only-key",
      steps: [{ expect() {}, response: { type: "text", text: "Waiting for your approval." } }],
    });
    onTestFinished(() => server.close());
    const { runtime, launchedFor, fence } = setup();
    const { run, ask } = await startGuest(runtime, launchedFor, "run_paused_fence", {
      executeTool: async () => PAUSED,
      model: server.model,
    });
    await pauseOnTool(ask);
    fence.standing = "paused";

    expect(await ask(modelRequest)).toEqual({ type: "model.end" });
    await ask(announce("remember", "after"));
    expect(await ask(call("remember", "after"))).toEqual(notRun);

    fence.standing = "lost";
    expect(await ask(modelRequest)).toEqual({ type: "refused", reason: "revoked" });
    await expect(run.done).rejects.toThrow("This attempt no longer holds the run");
    server.assertComplete();
  });

  it("relays two model requests so the harness can close its turn, then turns it away, then stops it", async () => {
    const server = await startModelEmulator({
      apiKey: "controller-only-key",
      steps: [
        { expect() {}, response: { type: "text", text: "Waiting for your approval." } },
        { expect() {}, response: { type: "text", text: "Still waiting." } },
      ],
    });
    onTestFinished(() => server.close());
    const { runtime, launchedFor } = setup();
    const { run, ask } = await startGuest(runtime, launchedFor, "run_model", {
      executeTool: async () => PAUSED,
      model: server.model,
    });
    await pauseOnTool(ask);

    expect(await ask(modelRequest)).toEqual({ type: "model.end" });
    expect(await ask(modelRequest)).toEqual({ type: "model.end" });
    const turnedAway = { type: "error", message: "This run is paused until the user answers." };
    expect(await ask(modelRequest)).toEqual(turnedAway);
    expect(await ask(modelRequest)).toEqual(turnedAway);
    expect(await ask(modelRequest)).toEqual({ type: "stop", reason: "paused" });

    await run.done;
    server.assertComplete();
    expect(run.seen.filter((event) => event.type === "usage")).toHaveLength(2);
  });

  it("ends paused, not failed, when the harness fails its turn after the pause", async () => {
    const { runtime, launchedFor } = setup();
    const { run, ask } = await startGuest(runtime, launchedFor, "run_failed", {
      executeTool: async () => PAUSED,
    });
    await pauseOnTool(ask);
    expect(await ask({ type: "failed", message: "The model relay refused" })).toEqual({
      type: "stop",
      reason: "paused",
    });
    await expect(run.done).resolves.toBeUndefined();
  });

  it("ends a paused attempt that goes silent at the deadline", async () => {
    const sleeps = new Map<number, () => void>();
    const clock: WorkerClock = {
      sleep: (ms) => new Promise<void>((resume) => sleeps.set(ms, resume)),
    };
    const { runtime, launchedFor } = setup(clock);
    const { run, ask } = await startGuest(runtime, launchedFor, "run_silent", {
      executeTool: async () => PAUSED,
    });
    await pauseOnTool(ask);
    let ended = false;
    void run.done.then(() => (ended = true));
    await new Promise((resume) => setTimeout(resume, 20));
    expect(ended).toBe(false);

    sleeps.get(WORKER_LIMITS.pausedGraceMs)!();
    await expect(run.done).resolves.toBeUndefined();
  });

  it("relays no model request once the attempt lost its run", async () => {
    const server = await startModelEmulator({
      apiKey: "controller-only-key",
      steps: [{ expect() {}, response: { type: "text", text: "Ok." } }],
    });
    onTestFinished(() => server.close());
    const { runtime, launchedFor, fence } = setup();
    const { run, ask } = await startGuest(runtime, launchedFor, "run_fence", {
      model: server.model,
    });
    expect(await ask(modelRequest)).toEqual({ type: "model.end" });

    fence.standing = "lost";
    expect(await ask(modelRequest)).toEqual({ type: "refused", reason: "revoked" });
    await expect(run.done).rejects.toThrow("This attempt no longer holds the run");
    server.assertComplete();
  });

  it("refuses the model request past the attempt's budget and ends the run", async () => {
    // An unknown model fails at the relay at once: each request is cheap and offline.
    const { runtime, launchedFor } = setup();
    const { run, ask } = await startGuest(runtime, launchedFor, "run_budget", {});
    for (let sent = 0; sent < WORKER_LIMITS.modelRequestsPerAttempt; sent += 1) {
      expect(await ask(modelRequest)).toEqual({ type: "model.end" });
    }
    expect(await ask(modelRequest)).toEqual({ type: "refused", reason: "budget" });
    await expect(run.done).rejects.toThrow("The worker broke the run protocol: budget");
  });
});

describe("untrusted skill reports", () => {
  it.each(["skills.index.end", "skills.index"] as const)(
    "rejects an unmounted shared source in %s",
    async (type) => {
      const setupRun = setup();
      const onSkillIndex = vi.fn();
      const run = consume(setupRun.runtime.run(request("unmounted", { onSkillIndex })));
      const launch = await setupRun.launchedFor("unmounted");
      const guest = rawGuest(launch.connect(), launch.capability);
      await guest.hello();
      guest.send(
        1,
        type === "skills.index.end"
          ? { type, sources: ["shared"] }
          : {
              type,
              skill: {
                source: "shared",
                name: "fake",
                description: "Fake",
                path: "/workspace/shared/skills/fake/SKILL.md",
                content: "fake",
                contentHash: "0".repeat(64),
                files: [],
              },
            },
      );
      expect(await guest.replies(1)).toEqual([{ type: "refused", reason: "invalid" }]);
      await expect(run.done).rejects.toThrow("invalid");
      expect(onSkillIndex).not.toHaveBeenCalled();
    },
  );

  it.each(["skills.used", "skills.collision"] as const)(
    "bounds %s events over the entire attempt",
    async (type) => {
      const setupRun = setup();
      const record = vi.fn();
      const run = consume(
        setupRun.runtime.run(request(type, { onSkillUsed: record, onSkillCollision: record })),
      );
      const launch = await setupRun.launchedFor(type);
      const guest = rawGuest(launch.connect(), launch.capability);
      await guest.hello();
      const body: GuestBody =
        type === "skills.used"
          ? { type, name: "guide" }
          : { type, collision: { name: "guide", kept: "managed", ignored: "managed" } };
      for (let seq = 1; seq <= 513; seq++) {
        guest.send(seq, body);
        expect(await guest.replies(seq)).toEqual([
          seq === 513 ? { type: "refused", reason: "budget" } : { type: "recorded" },
        ]);
      }
      await expect(run.done).rejects.toThrow("budget");
      expect(record).toHaveBeenCalledTimes(512);
    },
  );
});
