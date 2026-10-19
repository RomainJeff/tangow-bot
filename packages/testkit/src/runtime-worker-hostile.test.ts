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
import { describe, expect, it, vi } from "vitest";

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

  it("gets its tool output cut and redacted, and a frame over the limit ends the run", async () => {
    const { runtime, launchedFor } = setup();
    const results: LocalToolOutput[] = [];
    const run = consume(
      runtime.run(
        request("run_big", {
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

    guest.send(4, bash("huge"));
    guest.send(5, callBash("huge"));
    await guest.replies(5);
    guest.send(6, {
      type: "tool.done",
      callId: "huge",
      output: output("y".repeat(2 * 1024 * 1024)),
    });
    await expect(run.done).rejects.toThrow("The worker broke the run protocol: too_large");
    expect(results).toHaveLength(1);
  });
});
