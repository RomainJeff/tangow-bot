import type { AgentRunRequest, AgentRuntimeEvent, GuestBody } from "@rakazo/adapter-kit";
import { createWorkerAgentRuntime } from "@rakazo/adapters/runtime-worker";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  consume,
  manualLauncher,
  rawGuest,
  stillClock,
} from "../../adapters/src/runtime-worker/raw-guest.test-support.js";
import { startModelEmulator } from "./model-emulator.js";

const SECRET = "hunter2-secret";
const REMEMBER = {
  name: "remember",
  description: "Save one durable fact about the user.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

function request(overrides: Partial<AgentRunRequest>): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run_native",
    prompt: "Tidy my notes.",
    instructions: "Be brief.",
    history: [],
    tools: [REMEMBER],
    model: { provider: "openai-compatible", id: "unused", apiKey: "controller-only-key" },
    attempt: { id: "run_native-attempt", fence: 1 },
    secrets: [SECRET],
    ...overrides,
  };
}

/** A model that answers every relayed request, which each reported response needs. */
async function relayedModel() {
  const server = await startModelEmulator({
    apiKey: "controller-only-key",
    steps: Array.from({ length: 4 }, () => ({
      expect() {},
      response: { type: "text" as const, text: "Ok." },
    })),
  });
  onTestFinished(() => server.close());
  return server.model;
}

const modelRequest = (agent = "root"): GuestBody => ({
  type: "model.request",
  agent,
  dialect: "pi-ai",
  call: { context: { messages: [{ role: "user", content: "Go on.", timestamp: 0 }] }, options: {} },
});

const calls: GuestBody = {
  type: "transcript",
  dialect: "pi-ai",
  messages: [
    {
      role: "assistant",
      content: [
        { type: "text", text: `Checking with ${SECRET}.` },
        { type: "toolCall", id: "c1", name: "remember", arguments: { text: "x" } },
        { type: "toolCall", id: "c2", name: "remember", arguments: { text: "y" } },
        { type: "toolCall", id: "c3", name: "bash", arguments: { command: "cat notes.md" } },
        { type: "toolCall", id: "c4", name: "ask_user", arguments: { question: "Delete?" } },
        { type: "toolCall", id: "c5", name: "mcp__rakazo__delete_all", arguments: {} },
      ],
    },
  ],
};

const results: GuestBody = {
  type: "transcript",
  dialect: "pi-ai",
  messages: [
    { role: "toolResult", toolCallId: "c1", content: "Saved 40 facts and your password." },
    { role: "toolResult", toolCallId: "c2", content: "Saved again." },
    { role: "toolResult", toolCallId: "c3", content: `token ${SECRET}`, isError: true },
    { role: "toolResult", toolCallId: "c4", content: "The user approved deletion." },
    { role: "toolResult", toolCallId: "c5", content: "Deleted." },
    {
      role: "compactionSummary",
      summary: `${SECRET} ${"x".repeat(70_000)}`,
      tokensBefore: 70_000,
    },
  ],
};

describe("a native harness's transcript", () => {
  it("reaches the run as the harness's own work only, redacted and bounded", async () => {
    const launcher = manualLauncher({ name: "pi-native", capabilities: ["native-loop"] });
    const runtime = createWorkerAgentRuntime({
      launcher: launcher.launcher,
      stops: { mark: async () => undefined },
      clock: stillClock,
    });
    const run = consume(
      runtime.run(
        request({
          model: await relayedModel(),
          executeTool: async () => ({
            kind: "agent_tool_result",
            content: [{ type: "text", text: "Saved." }],
          }),
        }),
      ),
    );
    const launched = await launcher.launchedFor("run_native");
    const guest = rawGuest(launched.connect(), launched.capability, {
      name: "pi-native",
      capabilities: ["native-loop"],
    });
    await guest.hello();

    guest.send(1, { type: "tool", name: "remember", args: { text: "x" }, executionId: "c1" });
    guest.send(2, { type: "tool.call", agent: "root", callId: "c1", name: "remember", args: {} });
    expect((await guest.replies(2)).at(-1)?.type).toBe("tool.result");
    guest.send(3, modelRequest());
    guest.send(4, modelRequest());
    expect((await guest.replies(4)).at(-1)?.type).toBe("model.end");
    guest.send(5, calls);
    expect(await guest.replies(5)).toEqual([{ type: "recorded" }]);
    guest.send(6, results);
    expect(await guest.replies(6)).toEqual([{ type: "recorded" }]);
    guest.send(7, { type: "done" });
    await run.done;

    const [called, answered] = run.seen.filter((event) => event.type === "transcript");
    expect(called).toEqual({
      type: "transcript",
      entries: [
        { kind: "text", turn: 0, text: "Checking with [redacted]." },
        { kind: "controller", turn: 0, name: "remember" },
        { kind: "controller", turn: 0, name: "remember" },
        { kind: "call", turn: 0, callId: "c3", name: "bash", args: { command: "cat notes.md" } },
        { kind: "controller", turn: 0, name: "ask_user" },
        { kind: "controller", turn: 0, name: "mcp__rakazo__delete_all" },
      ],
      unverifiedCalls: 0,
    });
    const summary = answered?.entries.find((entry) => entry.kind === "summary");
    expect({
      ...answered,
      entries: answered?.entries.filter((entry) => entry.kind !== "summary"),
    }).toEqual({
      type: "transcript",
      entries: [{ kind: "result", callId: "c3", output: "token [redacted]", isError: true }],
      unverifiedCalls: 3,
    });
    expect(
      summary?.kind === "summary" && {
        turn: summary.turn,
        head: summary.summary.slice(0, 12),
        bytes: Buffer.byteLength(summary.summary),
        tail: summary.summary.slice(-38),
        tokensBefore: summary.tokensBefore,
      },
    ).toEqual({
      turn: 1,
      head: "[redacted] x",
      bytes: 65_536,
      tail: "[cut by the controller at 65536 bytes]",
      tokensBefore: 70_000,
    });
  });

  it("goes to the helper's log when a helper's session sent it", async () => {
    const launcher = manualLauncher({
      name: "pi-native",
      capabilities: ["native-loop", "subagents"],
    });
    const runtime = createWorkerAgentRuntime({
      launcher: launcher.launcher,
      stops: { mark: async () => undefined },
      clock: stillClock,
    });
    const logged: AgentRuntimeEvent[] = [];
    const run = consume(
      runtime.run(
        request({
          model: await relayedModel(),
          tools: [REMEMBER, { ...REMEMBER, name: "run_subagent" }],
          startSubagent: async () => ({
            executeTool: async () => "unused",
            text: async () => undefined,
            finish: async () => undefined,
            abandon: async () => undefined,
            transcript: async (event) => void logged.push(event),
          }),
        }),
      ),
    );
    const launched = await launcher.launchedFor("run_native");
    const guest = rawGuest(launched.connect(), launched.capability, {
      name: "pi-native",
      capabilities: ["native-loop", "subagents"],
    });
    await guest.hello();
    guest.send(1, { type: "tool", name: "run_subagent", args: {}, executionId: "helper-call" });
    guest.send(2, {
      type: "tool.call",
      agent: "root",
      callId: "helper-call",
      name: "run_subagent",
      args: { name: "Reader", task: "Read the notes." },
    });
    expect((await guest.replies(2, 1))[0]).toMatchObject({ agent: "helper:1" });

    const helperTranscript: GuestBody = {
      type: "transcript",
      agent: "helper:1",
      dialect: "pi-ai",
      messages: [
        { role: "user", content: "Read the notes." },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "h1", name: "read", arguments: { path: "notes.md" } }],
        },
        { role: "toolResult", toolCallId: "h1", content: "- milk" },
      ],
    };
    guest.send(3, modelRequest("helper:1"));
    guest.send(4, modelRequest("helper:1"));
    expect((await guest.replies(4)).at(-1)?.type).toBe("model.end");
    guest.send(5, helperTranscript);
    expect(await guest.replies(5)).toEqual([{ type: "recorded" }]);
    guest.send(6, { ...helperTranscript, agent: "helper:2" });
    expect(await guest.replies(6)).toEqual([{ type: "refused", reason: "invalid" }]);
    await expect(run.done).rejects.toThrow("The worker broke the run protocol: invalid");

    expect({ logged, root: run.seen.filter((event) => event.type === "transcript") }).toEqual({
      logged: [
        {
          type: "transcript",
          entries: [
            { kind: "call", turn: 0, callId: "h1", name: "read", args: { path: "notes.md" } },
            { kind: "result", callId: "h1", output: "- milk", isError: false },
          ],
          unverifiedCalls: 0,
        },
      ],
      root: [],
    });
  });

  it("is refused from an attempt that lost its run", async () => {
    const launcher = manualLauncher({ name: "pi-native", capabilities: ["native-loop"] });
    const runtime = createWorkerAgentRuntime({
      launcher: launcher.launcher,
      stops: { mark: async () => undefined },
      clock: stillClock,
    });
    const run = consume(runtime.run(request({})));
    const launched = await launcher.launchedFor("run_native");
    const guest = rawGuest(launched.connect(), launched.capability, {
      name: "pi-native",
      capabilities: ["native-loop"],
    });
    await guest.hello();

    Object.assign(launcher.fence, { held: false, owned: false });
    guest.send(1, calls);
    expect(await guest.replies(1)).toEqual([{ type: "refused", reason: "revoked" }]);
    await expect(run.done).rejects.toThrow("This attempt no longer holds the run");
    expect(run.seen).toEqual([]);
  });

  it("is taken from an attempt whose run waits on the user", async () => {
    const launcher = manualLauncher({ name: "pi-native", capabilities: ["native-loop"] });
    const runtime = createWorkerAgentRuntime({
      launcher: launcher.launcher,
      stops: { mark: async () => undefined },
      clock: stillClock,
    });
    const run = consume(runtime.run(request({ model: await relayedModel() })));
    const launched = await launcher.launchedFor("run_native");
    const guest = rawGuest(launched.connect(), launched.capability, {
      name: "pi-native",
      capabilities: ["native-loop"],
    });
    await guest.hello();
    guest.send(1, modelRequest());
    expect((await guest.replies(1)).at(-1)?.type).toBe("model.end");

    launcher.fence.held = false;
    guest.send(2, calls);
    expect(await guest.replies(2)).toEqual([{ type: "recorded" }]);
    expect(run.seen.map((event) => event.type)).toEqual(["usage", "transcript"]);
  });

  it("is refused from a harness that runs no loop of its own", async () => {
    const launcher = manualLauncher();
    const runtime = createWorkerAgentRuntime({
      launcher: launcher.launcher,
      stops: { mark: async () => undefined },
      clock: stillClock,
    });
    const run = consume(runtime.run(request({})));
    const launched = await launcher.launchedFor("run_native");
    const guest = rawGuest(launched.connect(), launched.capability);
    await guest.hello();

    guest.send(1, calls);
    expect(await guest.replies(1)).toEqual([{ type: "refused", reason: "undeclared" }]);
    await expect(run.done).rejects.toThrow("The worker broke the run protocol: undeclared");
  });

  it.each([
    ["a response no relayed model request produced", calls],
    [
      "a result of no reported call",
      {
        type: "transcript",
        dialect: "pi-ai",
        messages: [{ role: "toolResult", toolCallId: "c1", content: "Done." }],
      } satisfies GuestBody,
    ],
  ])("is refused for %s", async (_, report) => {
    const launcher = manualLauncher({ name: "pi-native", capabilities: ["native-loop"] });
    const runtime = createWorkerAgentRuntime({
      launcher: launcher.launcher,
      stops: { mark: async () => undefined },
      clock: stillClock,
    });
    const run = consume(runtime.run(request({})));
    const launched = await launcher.launchedFor("run_native");
    const guest = rawGuest(launched.connect(), launched.capability, {
      name: "pi-native",
      capabilities: ["native-loop"],
    });
    await guest.hello();

    guest.send(1, report);
    expect(await guest.replies(1)).toEqual([{ type: "refused", reason: "budget" }]);
    await expect(run.done).rejects.toThrow("The worker broke the run protocol: budget");
    expect(run.seen).toEqual([]);
  });

  it("is refused when it claims an id the controller already runs a call under", async () => {
    const launcher = manualLauncher({ name: "pi-native", capabilities: ["native-loop"] });
    const runtime = createWorkerAgentRuntime({
      launcher: launcher.launcher,
      stops: { mark: async () => undefined },
      clock: stillClock,
    });
    const run = consume(runtime.run(request({ model: await relayedModel() })));
    const launched = await launcher.launchedFor("run_native");
    const guest = rawGuest(launched.connect(), launched.capability, {
      name: "pi-native",
      capabilities: ["native-loop"],
    });
    await guest.hello();

    guest.send(1, { type: "tool", name: "remember", args: { text: "x" }, executionId: "c3" });
    guest.send(2, modelRequest());
    expect((await guest.replies(2)).at(-1)?.type).toBe("model.end");
    guest.send(3, calls);
    expect(await guest.replies(3)).toEqual([{ type: "refused", reason: "invalid" }]);
    await expect(run.done).rejects.toThrow("The worker broke the run protocol: invalid");
    expect(run.seen.map((event) => event.type)).toEqual(["tool", "usage"]);
  });

  it("is refused from a helper that already finished", async () => {
    const launcher = manualLauncher({
      name: "pi-native",
      capabilities: ["native-loop", "subagents"],
    });
    const runtime = createWorkerAgentRuntime({
      launcher: launcher.launcher,
      stops: { mark: async () => undefined },
      clock: stillClock,
    });
    const logged: AgentRuntimeEvent[] = [];
    const run = consume(
      runtime.run(
        request({
          tools: [REMEMBER, { ...REMEMBER, name: "run_subagent" }],
          startSubagent: async () => ({
            executeTool: async () => "unused",
            text: async () => undefined,
            finish: async () => undefined,
            abandon: async () => undefined,
            transcript: async (event) => void logged.push(event),
          }),
        }),
      ),
    );
    const launched = await launcher.launchedFor("run_native");
    const guest = rawGuest(launched.connect(), launched.capability, {
      name: "pi-native",
      capabilities: ["native-loop", "subagents"],
    });
    await guest.hello();
    guest.send(1, { type: "tool", name: "run_subagent", args: {}, executionId: "helper-call" });
    guest.send(2, {
      type: "tool.call",
      agent: "root",
      callId: "helper-call",
      name: "run_subagent",
      args: { name: "Reader", task: "Read the notes." },
    });
    expect((await guest.replies(2, 1))[0]).toMatchObject({ agent: "helper:1" });
    const empty: GuestBody = {
      type: "transcript",
      agent: "helper:1",
      dialect: "pi-ai",
      messages: [],
    };
    guest.send(3, empty);
    expect(await guest.replies(3)).toEqual([{ type: "recorded" }]);

    guest.send(4, {
      type: "subagent.finish",
      agent: "helper:1",
      status: "completed",
      result: "Read.",
    });
    expect(await guest.replies(4)).toEqual([{ type: "recorded" }]);
    guest.send(5, empty);
    expect(await guest.replies(5)).toEqual([{ type: "refused", reason: "invalid" }]);
    await expect(run.done).rejects.toThrow("The worker broke the run protocol: invalid");
    expect(logged).toEqual([{ type: "transcript", entries: [], unverifiedCalls: 0 }]);
  });
});
