import type {
  AgentRunRequest,
  ConnectorTool,
  GuestBody,
  SubagentCall,
  SubagentLog,
} from "@rakazo/adapter-kit";
import { createWorkerAgentRuntime, WORKER_LIMITS } from "@rakazo/adapters/runtime-worker";
import { describe, expect, it, onTestFinished } from "vitest";
import { startModelEmulator } from "./model-emulator.js";
import { consume, manualLauncher, rawGuest, stillClock } from "./worker-raw-guest.js";

const tool = (name: string): ConnectorTool => ({
  name,
  description: `${name} tool.`,
  inputSchema: { type: "object", properties: {} },
});

const PAUSED = {
  kind: "agent_tool_result",
  content: [{ type: "text", text: "Waiting for approval." }],
  details: { approval: "paused" },
  terminate: true,
};

/** A run whose helpers write to a log the test reads back. */
function helperRun(
  runId: string,
  helperTool: SubagentLog["executeTool"],
  model?: AgentRunRequest["model"],
) {
  const opened: SubagentCall[] = [];
  const helperCalls: string[] = [];
  const finished: Parameters<SubagentLog["finish"]>[0][] = [];
  const launcher = manualLauncher();
  const runtime = createWorkerAgentRuntime({
    launcher: launcher.launcher,
    stops: { mark: async () => undefined },
    clock: stillClock,
  });
  const run = consume(
    runtime.run({
      botId: "bot",
      threadId: "thread",
      runId,
      prompt: "Sort my notes.",
      instructions: "Be brief.",
      history: [{ role: "user", content: "Earlier turn." }],
      tools: [tool("remember"), tool("run_subagent"), tool("message_user")],
      model: model ?? { provider: "openai-compatible", id: "unused", apiKey: "controller-only" },
      attempt: { id: `${runId}-attempt`, fence: 1 },
      executeTool: async (name) => `parent ran ${name}`,
      resolveModel: async () => {
        throw new Error("This test names no other model");
      },
      startSubagent: async (call) => {
        opened.push(call);
        return {
          executeTool: async (name, args, executionId, route, trace) => {
            helperCalls.push(name);
            return helperTool(name, args, executionId, route, trace);
          },
          text: async () => undefined,
          finish: async (outcome) => void finished.push(outcome),
          abandon: async () => undefined,
        };
      },
    }),
  );
  return {
    run,
    opened,
    helperCalls,
    finished,
    async guest() {
      const launched = await launcher.launchedFor(runId);
      const guest = rawGuest(launched.connect(), launched.capability, {
        name: "pi-native",
        capabilities: ["native-loop", "subagents"],
      });
      await guest.hello();
      return guest;
    },
  };
}

const callHelper = (callId: string): GuestBody => ({
  type: "tool.call",
  agent: "root",
  callId,
  name: "run_subagent",
  args: { name: "scout", task: "Find the notes." },
});

describe("a helper the controller starts for a harness with its own loop", () => {
  it("runs as a session of its own and answers its parent's call with its result", async () => {
    const run = helperRun("run_helper", async () => "Saved.");
    const guest = await run.guest();

    guest.send(1, { type: "tool", name: "run_subagent", args: {}, executionId: "h1" });
    guest.send(2, callHelper("h1"));
    const [start] = await guest.replies(2, 1);
    expect(start).toEqual({
      type: "subagent.start",
      agent: "helper:1",
      run: {
        botId: "bot",
        threadId: "thread",
        prompt: "Find the notes.",
        instructions: expect.stringContaining('named "scout"'),
        history: [],
        images: [],
        tools: [{ ...tool("remember"), where: "controller" }],
        model: { provider: "openai-compatible", id: "unused" },
      },
    });

    guest.send(3, { type: "tool", name: "remember", args: {}, executionId: "c1" });
    guest.send(4, {
      type: "tool.call",
      agent: "helper:1",
      callId: "c1",
      name: "remember",
      args: {},
    });
    expect(await guest.replies(4)).toEqual([{ type: "tool.result", output: "Saved." }]);
    guest.send(5, {
      type: "subagent.finish",
      agent: "helper:1",
      status: "completed",
      result: "Found 3 notes.",
    });
    expect(await guest.replies(5)).toEqual([{ type: "recorded" }]);

    expect((await guest.replies(2)).at(-1)).toEqual({
      type: "tool.result",
      output: "Found 3 notes.",
    });
    expect(run.opened.map(({ callId, name, task }) => ({ callId, name, task }))).toEqual([
      { callId: "h1", name: "scout", task: "Find the notes." },
    ]);
    expect(run.helperCalls).toEqual(["remember"]);
    expect(run.finished).toEqual([
      { status: "completed", result: "Found 3 notes.", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("passes a pause in the helper to its parent's call", async () => {
    const run = helperRun("run_helper_pause", async () => PAUSED);
    const guest = await run.guest();

    guest.send(1, { type: "tool", name: "run_subagent", args: {}, executionId: "h1" });
    guest.send(2, callHelper("h1"));
    await guest.replies(2, 1);
    guest.send(3, { type: "tool", name: "remember", args: {}, executionId: "c1" });
    guest.send(4, {
      type: "tool.call",
      agent: "helper:1",
      callId: "c1",
      name: "remember",
      args: {},
    });
    expect(await guest.replies(4)).toEqual([{ type: "tool.result", output: PAUSED }]);
    guest.send(5, {
      type: "subagent.finish",
      agent: "helper:1",
      status: "completed",
      result: "Waiting on the user.",
    });

    expect((await guest.replies(2)).at(-1)).toEqual({ type: "tool.result", output: PAUSED });
  });

  it("caps the helper's model requests apart from its parent's", async () => {
    const server = await startModelEmulator({
      apiKey: "controller-only-key",
      steps: Array.from({ length: WORKER_LIMITS.modelRequestsPerHelper + 1 }, () => ({
        response: { type: "text", text: "Ok." },
      })),
    });
    onTestFinished(() => server.close());
    const run = helperRun("run_helper_budget", async () => "Saved.", server.model);
    const guest = await run.guest();
    const ask = (agent: string): GuestBody => ({
      type: "model.request",
      agent,
      dialect: "pi-ai",
      call: {
        context: { messages: [{ role: "user", content: "Hi", timestamp: 0 }] },
        options: {},
      },
    });

    guest.send(1, { type: "tool", name: "run_subagent", args: {}, executionId: "h1" });
    guest.send(2, callHelper("h1"));
    await guest.replies(2, 1);
    let seq = 3;
    for (let index = 0; index < WORKER_LIMITS.modelRequestsPerHelper; index += 1, seq += 1) {
      guest.send(seq, ask("helper:1"));
      expect((await guest.replies(seq)).at(-1)).toEqual({ type: "model.end" });
    }
    guest.send(seq, ask("helper:1"));
    expect(await guest.replies(seq)).toEqual([
      {
        type: "error",
        message: `This helper used its ${WORKER_LIMITS.modelRequestsPerHelper} model requests`,
      },
    ]);
    guest.send(seq + 1, ask("root"));
    expect((await guest.replies(seq + 1)).at(-1)).toEqual({ type: "model.end" });
  });

  it("cannot start a helper of its own", async () => {
    const run = helperRun("run_helper_nested", async () => "Saved.");
    const guest = await run.guest();

    guest.send(1, { type: "tool", name: "run_subagent", args: {}, executionId: "h1" });
    guest.send(2, callHelper("h1"));
    await guest.replies(2, 1);
    guest.send(3, { type: "tool", name: "run_subagent", args: {}, executionId: "h2" });
    guest.send(4, { ...callHelper("h2"), agent: "helper:1" } as GuestBody);
    expect(await guest.replies(4)).toEqual([{ type: "refused", reason: "unknown_tool" }]);
    expect(run.opened.map(({ callId }) => callId)).toEqual(["h1"]);
  });

  it("is never opened by the harness itself", async () => {
    const run = helperRun("run_helper_open", async () => "Saved.");
    const guest = await run.guest();

    guest.send(1, {
      type: "subagent.open",
      callId: "h1",
      name: "scout",
      task: "Find the notes.",
      args: {},
      model: { provider: "openai-compatible", id: "unused" },
    });
    expect(await guest.replies(1)).toEqual([{ type: "refused", reason: "invalid" }]);
    await expect(run.run.done).rejects.toThrow("The worker broke the run protocol: invalid");
    expect(run.opened).toEqual([]);
  });
});
