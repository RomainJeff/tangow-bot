import type {
  AgentRunRequest,
  ConnectorTool,
  GuestBody,
  HarnessCapability,
  SubagentCall,
  SubagentLog,
} from "@rakazo/adapter-kit";
import { createWorkerAgentRuntime, WORKER_LIMITS } from "@rakazo/adapters/runtime-worker";
import type { HelperProfile } from "@rakazo/core";
import { describe, expect, it, onTestFinished } from "vitest";
import { catalogEntries, lazyCatalogTools } from "../../adapters/src/lazy-tool-catalog.js";
import {
  consume,
  manualLauncher,
  rawGuest,
  stillClock,
} from "../../adapters/src/runtime-worker/raw-guest.test-support.js";
import { startModelEmulator } from "./model-emulator.js";

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
  options: {
    helperTool?: SubagentLog["executeTool"];
    finish?: SubagentLog["finish"];
    model?: AgentRunRequest["model"];
    tools?: ConnectorTool[];
    blockedTools?: string[];
    helperProfiles?: HelperProfile[];
    capabilities?: HarnessCapability[];
    /** Holds `startSubagent` open until it settles. */
    opening?: Promise<void>;
    /** How many first starts `startSubagent` refuses. */
    refusals?: number;
    /** Runs as this background helper instead of the bot. */
    helper?: AgentRunRequest["helper"];
  } = {},
) {
  const opened: SubagentCall[] = [];
  const helperCalls: string[] = [];
  const finished: Parameters<SubagentLog["finish"]>[0][] = [];
  const abandoned: string[] = [];
  let calledStart = () => {};
  const startCalled = new Promise<void>((resolve) => {
    calledStart = resolve;
  });
  const harness = {
    name: "pi-native",
    capabilities: options.capabilities ?? ["native-loop", "subagents"],
  };
  const launcher = manualLauncher(harness);
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
      tools: options.tools ?? [tool("remember"), tool("run_subagent"), tool("message_user")],
      blockedTools: options.blockedTools,
      helperProfiles: options.helperProfiles,
      helper: options.helper,
      startHelper: async (call) => {
        opened.push(call);
        return { helperId: "run_background" };
      },
      model: options.model ?? {
        provider: "openai-compatible",
        id: "unused",
        apiKey: "controller-only",
      },
      attempt: { id: `${runId}-attempt`, fence: 1 },
      resolveModel: async (provider, id) => ({ provider, id, apiKey: "controller-only" }),
      executeTool: async (name) => `parent ran ${name}`,
      startSubagent: async (call) => {
        opened.push(call);
        calledStart();
        await options.opening;
        if (opened.length <= (options.refusals ?? 0)) {
          throw new Error("computer is held by helper run_holder (operator)");
        }
        return {
          executeTool: async (name, args, executionId, route, trace) => {
            helperCalls.push(name);
            return (options.helperTool ?? (async () => "Saved."))(
              name,
              args,
              executionId,
              route,
              trace,
            );
          },
          text: async () => undefined,
          finish: options.finish ?? (async (outcome) => void finished.push(outcome)),
          abandon: async (result) => void abandoned.push(result),
        };
      },
    }),
  );
  return {
    run,
    runtime,
    opened,
    startCalled,
    helperCalls,
    finished,
    abandoned,
    async guest() {
      const launched = await launcher.launchedFor(runId);
      const guest = rawGuest(launched.connect(), launched.capability, harness);
      await guest.hello();
      return guest;
    },
  };
}

type Guest = Awaited<ReturnType<ReturnType<typeof helperRun>["guest"]>>;

/** Announces and calls `run_subagent` as frames `seq` and `seq + 1`. */
function callHelper(guest: Guest, seq: number, callId: string, args: Record<string, unknown> = {}) {
  guest.send(seq, { type: "tool", name: "run_subagent", args: {}, executionId: callId });
  guest.send(seq + 1, {
    type: "tool.call",
    agent: "root",
    callId,
    name: "run_subagent",
    args: { name: "scout", task: "Find the notes.", ...args },
  });
}

/** `agent` calls `name` as frames `seq` and `seq + 1`. */
function helperRemembers(guest: Guest, seq: number, agent: string, name = "remember") {
  guest.send(seq, { type: "tool", name, args: {}, executionId: `${agent}-c` });
  guest.send(seq + 1, {
    type: "tool.call",
    agent,
    callId: `${agent}-c`,
    name,
    args: {},
  });
}

const finish = (agent: string, result: string): GuestBody => ({
  type: "subagent.finish",
  agent,
  status: "completed",
  result,
});

describe("a helper the controller starts for a harness with its own loop", () => {
  it("runs as a session of its own and answers its parent's call with its result", async () => {
    const run = helperRun("run_helper");
    const guest = await run.guest();

    callHelper(guest, 1, "h1");
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

    helperRemembers(guest, 3, "helper:1");
    expect(await guest.replies(4)).toEqual([{ type: "tool.result", output: "Saved." }]);
    guest.send(5, finish("helper:1", "Found 3 notes."));
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

  it("stops at the helper's pause and settles its parent's call at once", async () => {
    const run = helperRun("run_helper_pause", { helperTool: async () => PAUSED });
    const guest = await run.guest();

    callHelper(guest, 1, "h1");
    await guest.replies(2, 1);
    helperRemembers(guest, 3, "helper:1");
    expect(await guest.replies(4)).toEqual([{ type: "tool.result", output: PAUSED }]);

    expect((await guest.replies(2)).at(-1)).toEqual({
      type: "tool.result",
      output: "Stopped: the run is waiting for the user.",
    });
    expect(run.finished).toEqual([]);
    callHelper(guest, 5, "h2");
    expect((await guest.replies(6)).at(-1)).toMatchObject({
      type: "tool.result",
      output: { details: { paused: true } },
    });
    expect(run.opened.map(({ callId }) => callId)).toEqual(["h1"]);
    guest.send(7, { type: "done" });
    await run.run.done;
    expect(run.finished).toEqual([
      {
        status: "completed",
        result: "Stopped: the run is waiting for the user.",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]);
  });

  it("caps the helper's model requests apart from its parent's", async () => {
    const server = await startModelEmulator({
      apiKey: "controller-only-key",
      steps: Array.from({ length: WORKER_LIMITS.modelRequestsPerHelper + 1 }, () => ({
        response: { type: "text", text: "Ok." },
      })),
    });
    onTestFinished(() => server.close());
    const run = helperRun("run_helper_budget", { model: server.model });
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

    callHelper(guest, 1, "h1");
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

  it("runs a bounded number of helpers at once and in all", async () => {
    const run = helperRun("run_helper_bounds");
    const guest = await run.guest();
    let seq = 1;
    const start = async () => {
      callHelper(guest, seq, `h${seq}`);
      seq += 2;
      return (await guest.replies(seq - 1, 1))[0];
    };
    const settle = async (agent: string) => {
      guest.send(seq, finish(agent, "Done."));
      seq += 1;
      await guest.replies(seq - 1);
    };

    const running: unknown[] = [];
    for (let index = 0; index < WORKER_LIMITS.helpersInParallel; index += 1) {
      running.push(await start());
    }
    expect(await start()).toEqual({
      type: "error",
      message: "Wait for a running helper to finish first",
    });
    for (let index = 1; index <= WORKER_LIMITS.helpersInParallel; index += 1) {
      await settle(`helper:${index}`);
    }
    let agents = WORKER_LIMITS.helpersInParallel;
    while (run.opened.length < WORKER_LIMITS.helpersPerAttempt) {
      await start();
      agents += 1;
      await settle(`helper:${agents}`);
    }
    expect(await start()).toEqual({
      type: "error",
      message: `This run already started its ${WORKER_LIMITS.helpersPerAttempt} helpers`,
    });
    expect(running.map((part) => (part as { type: string }).type)).toEqual(
      Array(WORKER_LIMITS.helpersInParallel).fill("subagent.start"),
    );
  });

  it("does not spend the helper budget on refused starts", async () => {
    const run = helperRun("run_helper_refused", { refusals: WORKER_LIMITS.helpersPerAttempt });
    const guest = await run.guest();
    let seq = 1;
    for (; seq < WORKER_LIMITS.helpersPerAttempt * 2; seq += 2) {
      callHelper(guest, seq, `h${seq}`);
      expect((await guest.replies(seq + 1, 1))[0]).toEqual({
        type: "error",
        message: "computer is held by helper run_holder (operator)",
      });
    }
    callHelper(guest, seq, `h${seq}`);
    expect((await guest.replies(seq + 1, 1))[0]).toMatchObject({
      type: "subagent.start",
      agent: "helper:1",
    });
  });

  it("holds the parent's end while the helper is still opening", async () => {
    let open = () => {};
    const run = helperRun("run_helper_opening", {
      opening: new Promise<void>((resolve) => {
        open = resolve;
      }),
    });
    const guest = await run.guest();

    callHelper(guest, 1, "h1");
    await run.startCalled;
    guest.send(3, { type: "done" });
    expect(await guest.replies(3, 1)).toEqual([{ type: "end.refused", pending: ["h1"] }]);
    open();
    await guest.replies(2, 1);
    guest.send(4, { type: "transcript", dialect: "pi-ai", messages: [] });
    expect(await guest.replies(4)).toEqual([{ type: "recorded" }]);
    guest.send(5, finish("helper:1", "Found 3 notes."));
    expect((await guest.replies(2)).at(-1)).toEqual({
      type: "tool.result",
      output: "Found 3 notes.",
    });
    expect((await guest.replies(3)).at(-1)).toEqual({ type: "stop", reason: "done" });
  });

  it("closes a helper that finished opening after the run stopped", async () => {
    let open = () => {};
    const run = helperRun("run_helper_stopped", {
      opening: new Promise<void>((resolve) => {
        open = resolve;
      }),
    });
    const guest = await run.guest();

    callHelper(guest, 1, "h1");
    await run.startCalled;
    await run.runtime.abort("run_helper_stopped");
    open();
    await expect(run.run.done).rejects.toThrow("The run was cancelled");
    await expect
      .poll(() => run.finished)
      .toEqual([
        {
          status: "failed",
          result: "The worker stopped",
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      ]);
  });

  it("answers its parent with what its log kept", async () => {
    const run = helperRun("run_helper_unsaved", {
      finish: async () => {
        throw new Error("history unavailable");
      },
    });
    const guest = await run.guest();

    callHelper(guest, 1, "h1");
    await guest.replies(2, 1);
    guest.send(3, finish("helper:1", "Found 3 notes."));

    expect((await guest.replies(2)).at(-1)).toEqual({
      type: "tool.result",
      output: "Subagent failed: history unavailable",
    });
    expect(run.abandoned).toEqual(["history unavailable"]);
  });

  it("cannot start a helper of its own", async () => {
    const run = helperRun("run_helper_nested");
    const guest = await run.guest();

    callHelper(guest, 1, "h1");
    await guest.replies(2, 1);
    guest.send(3, { type: "tool", name: "run_subagent", args: {}, executionId: "h2" });
    guest.send(4, {
      type: "tool.call",
      agent: "helper:1",
      callId: "h2",
      name: "run_subagent",
      args: { name: "scout", task: "Find the notes." },
    });
    expect(await guest.replies(4)).toEqual([{ type: "refused", reason: "unknown_tool" }]);
    expect(run.opened.map(({ callId }) => callId)).toEqual(["h1"]);
  });

  it("is never opened by the harness itself", async () => {
    const run = helperRun("run_helper_open");
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

const RESEARCHER: HelperProfile = {
  name: "researcher",
  description: "Finds sources.",
  allow: ["rem*", "run_subagent"],
  block: ["bash"],
  model: { provider: "openai-compatible", id: "research-model" },
  instructions: "Cite every source.",
};

const startOf = (guest: Guest) =>
  guest.received.find((message) => message.kind === "worker.start")!.run;

describe("a helper the call names by profile", () => {
  it("runs with its profile's tools, instructions and model, and nothing else", async () => {
    const run = helperRun("run_profiled", {
      tools: ["bash", "read", "remember", "forget", "run_subagent", "message_user"].map(tool),
      helperProfiles: [RESEARCHER],
    });
    const guest = await run.guest();
    const parent = startOf(guest);
    expect(parent.instructions).toBe(
      "Be brief.\n\n<available_helpers>\n- researcher: Finds sources.\n</available_helpers>",
    );
    expect(
      parent.tools.find((offered) => offered.name === "run_subagent")?.inputSchema.properties,
    ).toMatchObject({ helper: { type: "string", enum: ["researcher"] } });

    callHelper(guest, 1, "h1", { helper: "researcher", instructions: "Be quick." });
    const [start] = await guest.replies(2, 1);
    expect(start).toEqual({
      type: "subagent.start",
      agent: "helper:1",
      run: {
        botId: "bot",
        threadId: "thread",
        prompt: "Find the notes.",
        instructions:
          'You are a Rakazo subagent named "scout". You work for the parent bot — you are not a separate bot chat. Complete the task and return a concise result. Do not spawn bots or further subagents. Cite every source. Be quick.',
        history: [],
        images: [],
        tools: [
          { ...tool("read"), where: "guest" },
          { ...tool("remember"), where: "controller" },
        ],
        model: { provider: "openai-compatible", id: "research-model" },
      },
    });
    expect(run.opened.map(({ model }) => model)).toEqual([
      { provider: "openai-compatible", id: "research-model" },
    ]);

    helperRemembers(guest, 3, "helper:1", "forget");
    expect(await guest.replies(4)).toEqual([{ type: "refused", reason: "unknown_tool" }]);
    expect(run.helperCalls).toEqual([]);
  });

  it("answers a background call with the helper's id at once", async () => {
    const run = helperRun("run_starts_background", { helperProfiles: [RESEARCHER] });
    const guest = await run.guest();

    callHelper(guest, 1, "h1", { helper: "researcher", background: true });
    expect(await guest.replies(2)).toEqual([
      { type: "tool.result", output: { helperId: "run_background" } },
    ]);
    expect(run.opened).toMatchObject([
      {
        callId: "h1",
        task: "Find the notes.",
        model: { provider: "openai-compatible", id: "research-model" },
        profile: { name: "researcher" },
      },
    ]);
  });

  it("starts a background helper as its attempt's root, on its brief, profile and own session's history", async () => {
    const run = helperRun("run_background_root", {
      tools: ["bash", "read", "remember", "forget", "run_subagent", "message_user"].map(tool),
      helperProfiles: [RESEARCHER],
      helper: {
        name: "scout",
        task: "Find the notes.",
        instructions: "Be quick.",
        profile: "researcher",
      },
    });
    const guest = await run.guest();

    expect(startOf(guest)).toEqual({
      botId: "bot",
      threadId: "thread",
      prompt: "Find the notes.",
      instructions:
        'You are a Rakazo subagent named "scout". You work for the parent bot — you are not a separate bot chat. Complete the task and return a concise result. Do not spawn bots or further subagents. Cite every source. Be quick.',
      // A background helper's run reads its own session, which it resumes on.
      history: [{ role: "user", content: "Earlier turn." }],
      images: [],
      tools: [
        { ...tool("read"), where: "guest" },
        { ...tool("remember"), where: "controller" },
      ],
      model: { provider: "openai-compatible", id: "unused" },
    });
    helperRemembers(guest, 1, "root", "forget");
    expect(await guest.replies(2)).toEqual([{ type: "refused", reason: "unknown_tool" }]);
  });

  it("takes the call's model over its profile's", async () => {
    const run = helperRun("run_profiled_model", { helperProfiles: [RESEARCHER] });
    const guest = await run.guest();

    callHelper(guest, 1, "h1", {
      helper: "researcher",
      model_provider: "openai-compatible",
      model_id: "call-model",
    });
    expect(await guest.replies(2, 1)).toMatchObject([
      { type: "subagent.start", run: { model: { id: "call-model" } } },
    ]);
  });

  it("names the available profiles when the call names another", async () => {
    const run = helperRun("run_profiled_unknown", { helperProfiles: [RESEARCHER] });
    const guest = await run.guest();

    callHelper(guest, 1, "h1", { helper: "writer" });
    expect(await guest.replies(2)).toEqual([
      { type: "error", message: 'Unknown helper "writer". Available helpers: researcher' },
    ]);
    expect(run.opened).toEqual([]);
  });

  it("keeps a tool the main bot blocks for the helper whose profile allows it", async () => {
    const run = helperRun("run_main_blocked", {
      tools: ["bash", "computer_observe", "run_subagent", "message_user"].map(tool),
      blockedTools: ["computer_*"],
      helperProfiles: [
        {
          name: "operator",
          description: "Uses the computer.",
          allow: ["computer_*"],
          instructions: "",
        },
      ],
    });
    const guest = await run.guest();
    expect(startOf(guest).tools.map((offered) => offered.name)).toEqual([
      "bash",
      "run_subagent",
      "message_user",
    ]);

    callHelper(guest, 1, "h1", { helper: "operator" });
    const [start] = await guest.replies(2, 1);
    expect(start).toMatchObject({
      run: {
        tools: [
          { name: "bash", where: "guest" },
          { name: "computer_observe", where: "controller" },
        ],
      },
    });
    helperRemembers(guest, 3, "helper:1", "computer_observe");
    expect(await guest.replies(4)).toEqual([{ type: "tool.result", output: "Saved." }]);
    guest.send(5, finish("helper:1", "Looked."));
    expect((await guest.replies(2)).at(-1)).toEqual({ type: "tool.result", output: "Looked." });

    helperRemembers(guest, 6, "root", "computer_observe");
    expect(await guest.replies(7)).toEqual([{ type: "refused", reason: "unknown_tool" }]);
    expect(run.helperCalls).toEqual(["computer_observe"]);
  });
});

describe("a tool rule", () => {
  it("gives a helper without a profile the main bot's block list", async () => {
    const run = helperRun("run_unprofiled_blocked", {
      tools: ["bash", "computer_observe", "run_subagent", "message_user"].map(tool),
      blockedTools: ["computer_*"],
    });
    const guest = await run.guest();

    callHelper(guest, 1, "h1");
    const [start] = await guest.replies(2, 1);
    expect(start).toMatchObject({ run: { tools: [{ name: "bash", where: "guest" }] } });
    helperRemembers(guest, 3, "helper:1", "computer_observe");
    expect(await guest.replies(4)).toEqual([{ type: "refused", reason: "unknown_tool" }]);
  });

  it("names no helpers to a bot that cannot start one", async () => {
    const run = helperRun("run_no_helpers", {
      blockedTools: ["run_subagent"],
      helperProfiles: [RESEARCHER],
    });
    const guest = await run.guest();
    expect(startOf(guest).instructions).toBe("Be brief.");
  });

  it("refuses run_subagent to a harness without the subagents capability", async () => {
    const run = helperRun("run_no_subagents", { capabilities: ["native-loop"] });
    const guest = await run.guest();
    expect(startOf(guest).tools.map((offered) => offered.name)).toEqual([
      "remember",
      "message_user",
    ]);

    callHelper(guest, 1, "h1");
    expect(await guest.replies(2)).toEqual([{ type: "refused", reason: "unknown_tool" }]);
  });

  it("applies the block list to the entries of a lazy catalog", async () => {
    const entry = (name: string): ConnectorTool => ({
      ...tool(name),
      route: { connectorId: "mcp", resourceId: "srv", toolName: name },
    });
    const run = helperRun("run_blocked_entry", {
      tools: [
        ...lazyCatalogTools(
          "mcp",
          "mcp",
          "MCP",
          catalogEntries([entry("read_doc"), entry("delete_doc")]),
        ),
        tool("message_user"),
      ],
      blockedTools: ["delete_doc"],
    });
    const guest = await run.guest();
    expect(
      startOf(guest)
        .tools.filter((offered) => typeof offered.catalog === "object")
        .map(({ name, catalog }) => ({ name, catalog })),
    ).toEqual([{ name: "read_doc", catalog: { via: "mcp_execute_tool", id: "srv:read_doc" } }]);

    const execute = (seq: number, callId: string, id: string) => {
      const args = { id, arguments: {} };
      guest.send(seq, { type: "tool", name: "mcp_execute_tool", args, executionId: callId });
      guest.send(seq + 1, {
        type: "tool.call",
        agent: "root",
        callId,
        name: "mcp_execute_tool",
        args,
      });
    };
    execute(1, "c1", "srv:delete_doc");
    expect(await guest.replies(2)).toEqual([{ type: "refused", reason: "unknown_tool" }]);
    execute(3, "c2", "srv:read_doc");
    expect(await guest.replies(4)).toEqual([
      { type: "tool.result", output: "parent ran mcp_execute_tool" },
    ]);
  });
});
