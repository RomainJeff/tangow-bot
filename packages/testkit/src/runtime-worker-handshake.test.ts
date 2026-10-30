import type { HarnessDeclaration } from "@rakazo/adapter-kit";
import { PI_NATIVE_HARNESS } from "@rakazo/adapter-kit";
import {
  capabilityWorker,
  createWorkerAgentRuntime,
  encodeMessage,
  readGuestFrame,
} from "@rakazo/adapters/runtime-worker";
import { HARNESSES } from "@rakazo/agent-run-worker";
import { expect, it, onTestFinished } from "vitest";
import {
  consume,
  manualLauncher,
  rawGuest,
  stillClock,
} from "../../adapters/src/runtime-worker/raw-guest.test-support.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const marker = "GUEST_PRIVATE_NOTICE_MUST_NOT_PUBLISH";

it.each([
  { name: "pi-native", capabilities: ["native-loop", "steering"] },
  { name: "pi-native", capabilities: ["steering"] },
  { name: "pi-native", capabilities: ["native-loop"] },
  { name: "pi-native", capabilities: [] },
  { name: "pi-native", capabilities: ["native-loop", "steering", "subagents"] },
  PI_NATIVE_HARNESS,
  { name: "hand-written", capabilities: ["steering"] },
] satisfies HarnessDeclaration[])(
  "selected native run with hello $name $capabilities",
  async (hello) => {
    let nativeTranscriptSeen = false;
    const run = await startWorkerRun({
      harness: HARNESSES["pi-native"],
      steps: [{ response: { type: "text", text: "PRIVATE_MODEL_PROSE" } }],
      connector: (provider) => ({
        connect(target, capability) {
          const connected = provider.connect(target, capability);
          return {
            expectedHarness: connected.expectedHarness,
            exited: connected.exited,
            connections: (async function* () {
              for await (const channel of connected.connections) {
                yield {
                  send: (frame: Uint8Array) => channel.send(frame),
                  close: () => channel.close(),
                  frames: (async function* () {
                    for await (const frame of channel.frames) {
                      const parsed = readGuestFrame(frame);
                      if (!parsed.ok) {
                        yield frame;
                        continue;
                      }
                      const message = parsed.message;
                      if (message.kind === "worker.hello") {
                        yield encodeMessage({ ...message, harness: hello });
                      } else if (message.payload.body.type === "transcript") {
                        nativeTranscriptSeen = true;
                        yield encodeMessage({
                          ...message,
                          payload: {
                            ...message.payload,
                            body: {
                              type: "done",
                              runtimeNotice: marker,
                            },
                          },
                        });
                      } else yield frame;
                    }
                  })(),
                };
              }
            })(),
          };
        },
      }),
    });
    onTestFinished(() => run.close());
    const runId = await run.send("Review this privately.");
    await run.continueRun(runId);
    expect(nativeTranscriptSeen).toBe(hello.capabilities.includes("resume"));
    expect(run.model.requests).toHaveLength(nativeTranscriptSeen ? 1 : 0);
    const entries = await run.runEntries(runId);
    const messages = await run.prisma.sessionEntry.findMany({ where: { runId } });
    expect(JSON.stringify({ entries, messages })).not.toContain(marker);
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "failed",
    );
  },
);

it("a recorded helper transcript cannot satisfy root completion", async () => {
  const launcher = manualLauncher({
    name: "pi-native",
    capabilities: ["native-loop", "subagents"],
  });
  const runtime = createWorkerAgentRuntime({
    launcher: launcher.launcher,
    stops: { mark: async () => undefined },
    clock: stillClock,
  });
  const helperTranscripts: unknown[] = [];
  const running = consume(
    runtime.run({
      botId: "bot",
      threadId: "thread",
      runId: "root",
      prompt: "Work",
      instructions: "Work",
      history: [],
      tools: [
        {
          name: "run_subagent",
          description: "Delegate",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      model: { provider: "openai-compatible", id: "unused", apiKey: "fake" },
      attempt: { id: "attempt", fence: 1 },
      resolveCategory: async () => ({
        model: { provider: "openai-compatible", id: "unused", apiKey: "fake" },
        modelDecision: { mode: "category", provider: "openai-compatible", modelId: "unused" },
      }),
      startSubagent: async () => ({
        executeTool: async () => "Done",
        text: async () => undefined,
        finish: async () => undefined,
        abandon: async () => undefined,
        transcript: async (event) => {
          helperTranscripts.push(event);
        },
      }),
    }),
  );
  const launched = await launcher.launchedFor("root");
  const guest = rawGuest(launched.connect(), launched.capability, {
    name: "pi-native",
    capabilities: ["native-loop", "subagents"],
  });
  await guest.hello();
  guest.send(1, { type: "tool", name: "run_subagent", args: {}, executionId: "helper" });
  guest.send(2, {
    type: "tool.call",
    agent: "root",
    name: "run_subagent",
    callId: "helper",
    args: { name: "Scout", task: "Read notes" },
  });
  expect((await guest.replies(2, 1))[0]).toMatchObject({
    type: "subagent.start",
    agent: "helper:1",
  });
  guest.send(3, { type: "transcript", agent: "helper:1", dialect: "pi-ai", messages: [] });
  expect(await guest.replies(3)).toEqual([{ type: "recorded" }]);
  guest.send(4, {
    type: "subagent.finish",
    agent: "helper:1",
    status: "completed",
    result: "Done",
  });
  expect(await guest.replies(4)).toEqual([{ type: "recorded" }]);
  await guest.replies(2);
  guest.send(5, { type: "done", runtimeNotice: marker });
  await expect(running.done).rejects.toThrow("The worker broke the run protocol: invalid");
  expect(helperTranscripts).toHaveLength(1);
  expect(running.seen.some((event) => event.type === "done" || event.type === "transcript")).toBe(
    false,
  );
});

const request = {
  botId: "bot",
  threadId: "thread",
  runId: "root",
  prompt: "Work",
  instructions: "Work",
  history: [],
  tools: [],
  model: { provider: "openai-compatible", id: "unused", apiKey: "fake" },
  attempt: { id: "attempt", fence: 1 },
};

it("still rejects a missing hello when the selected harness is already known", async () => {
  const launcher = manualLauncher(HARNESSES["pi-native"]!.declaration);
  let deadline = () => {};
  const runtime = createWorkerAgentRuntime({
    launcher: launcher.launcher,
    stops: { mark: async () => undefined },
    clock: {
      sleep: () =>
        new Promise<void>((resolve) => {
          deadline = resolve;
        }),
    },
  });
  const running = consume(runtime.run(request));
  const launched = await launcher.launchedFor("root");
  launched.connect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  deadline();
  await expect(running.done).rejects.toThrow("The worker did not say hello in time");
  expect(running.seen).toEqual([]);
});

it.each([
  { name: "hand-written", capabilities: ["subagents", "steering"] },
  { name: "pi-native", capabilities: ["steering"] },
] satisfies HarnessDeclaration[])(
  "rejects a reconnect that changes hello to $name $capabilities",
  async (hello) => {
    const expected = HARNESSES["pi-native"]!.declaration;
    const launcher = manualLauncher(expected);
    const runtime = createWorkerAgentRuntime({
      launcher: launcher.launcher,
      stops: { mark: async () => undefined },
      clock: stillClock,
    });
    const running = consume(runtime.run(request));
    const launched = await launcher.launchedFor("root");
    const channel = launched.connect();
    const first = rawGuest(channel, launched.capability, expected);
    await first.hello();
    channel.close();
    await first.closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = rawGuest(launched.connect(), launched.capability, hello);
    void second.hello();
    await expect(running.done).rejects.toThrow("undeclared");
    expect(second.received.some((message) => message.kind === "worker.start")).toBe(false);
    expect(running.seen).toEqual([]);
  },
);

it("accepts the selected native harness after reconnect with reordered capabilities", async () => {
  const expected = HARNESSES["pi-native"]!.declaration;
  const launcher = manualLauncher(expected);
  const runtime = createWorkerAgentRuntime({
    launcher: launcher.launcher,
    stops: { mark: async () => undefined },
    clock: stillClock,
  });
  const running = consume(runtime.run(request));
  const launched = await launcher.launchedFor("root");
  const channel = launched.connect();
  const first = rawGuest(channel, launched.capability, expected);
  await first.hello();
  channel.close();
  await first.closed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = rawGuest(launched.connect(), launched.capability, {
    ...expected,
    capabilities: [...expected.capabilities].reverse(),
  });
  await second.hello();
  second.send(1, { type: "transcript", dialect: "pi-ai", messages: [] });
  expect(await second.replies(1)).toEqual([{ type: "recorded" }]);
  second.send(2, { type: "done" });
  await running.done;
  expect(running.seen).toEqual([
    { type: "transcript", entries: [], unverifiedCalls: 0 },
    { type: "done" },
  ]);
});

it("refuses a guest that says hello in the first protocol version", async () => {
  const expected = HARNESSES["pi-native"]!.declaration;
  const launcher = manualLauncher(expected);
  const runtime = createWorkerAgentRuntime({
    launcher: launcher.launcher,
    stops: { mark: async () => undefined },
    clock: stillClock,
  });
  const running = consume(runtime.run(request));
  const launched = await launcher.launchedFor("root");
  const channel = launched.connect();
  const received: Uint8Array[] = [];
  const closed = (async () => {
    for await (const frame of channel.frames) received.push(frame);
  })();

  await channel.send(
    Buffer.from(
      JSON.stringify({
        version: 1,
        kind: "worker.hello",
        worker: capabilityWorker(launched.capability),
        capability: launched.capability,
        harness: expected,
      }),
    ),
  );

  await expect(running.done).rejects.toThrow("The worker broke the run protocol: version");
  await closed;
  expect(received).toEqual([]);
});
