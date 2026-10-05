import type { AdapterContext, ConnectorTool, ToolCallTrace } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  mode: "dispatch" as
    | "dispatch"
    | "empty"
    | "two-boundaries"
    | "silent-continuation"
    | "scripted-turns"
    | "unstreamed-final"
    | "idle-without-final"
    | "subagent-limit"
    | "parent-limit"
    | "parent-parallel"
    | "ask-pause"
    | "nested-ask-pause",
  emitFinalAfterFollowUp: true,
  answerOnNudge: false,
  abortCount: 0,
  tools: [] as Array<{
    name: string;
    prepareArguments?: (args: unknown) => Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }>,
  invoke: {
    name: "destination_write",
    args: { collection: "notes", title: "Result", body: "Done" } as Record<string, unknown>,
  },
  /** Turns the "scripted-turns" mode plays, then an empty turn. Tool calls are not executed. */
  turns: [] as Array<{
    text?: string;
    calls: Array<{ name: string; details?: Record<string, unknown> }>;
  }>,
  preparedMessages: [] as unknown[],
  steeredMessages: [] as unknown[],
  followUpMessages: [] as unknown[],
  initialMessages: [] as unknown[],
  promptInputs: [] as string[],
  promptImages: [] as unknown[][],
  toolResult: undefined as unknown,
  beforeToolCall: undefined as ((context: unknown) => Promise<unknown>) | undefined,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined as string | undefined, messages: [] as unknown[] };
    private readonly tools: typeof fakeAgentState.tools;
    private readonly listeners: Array<(event: Record<string, unknown>) => void> = [];
    private readonly prepareNextTurnWithContext?: (input: {
      context: { messages: unknown[] };
    }) => Promise<{ context?: { messages: unknown[] } } | undefined>;
    private aborted = false;

    constructor(options: {
      initialState: { tools: typeof fakeAgentState.tools; messages: unknown[] };
      beforeToolCall?: (context: unknown) => Promise<unknown>;
      prepareNextTurnWithContext?: (input: {
        context: { messages: unknown[] };
      }) => Promise<{ context?: { messages: unknown[] } } | undefined>;
    }) {
      this.tools = options.initialState.tools;
      fakeAgentState.beforeToolCall = options.beforeToolCall;
      this.prepareNextTurnWithContext = options.prepareNextTurnWithContext;
      fakeAgentState.tools = this.tools;
      fakeAgentState.initialMessages = options.initialState.messages;
    }

    subscribe(listener: (event: Record<string, unknown>) => void) {
      this.listeners.push(listener);
    }

    async prompt(prompt: string, images?: unknown[]) {
      fakeAgentState.promptInputs.push(prompt);
      fakeAgentState.promptImages.push(images ?? []);
      if (fakeAgentState.mode === "empty" || fakeAgentState.mode === "two-boundaries") {
        await this.prepareNextTurnWithContext?.({ context: { messages: [] } });
        if (fakeAgentState.mode === "two-boundaries") {
          await this.prepareNextTurnWithContext?.({ context: { messages: [] } });
        }
        fakeAgentState.preparedMessages = [...fakeAgentState.steeredMessages];
        return;
      }

      if (fakeAgentState.mode === "dispatch") {
        const target =
          this.tools.find((tool) => tool.name === fakeAgentState.invoke.name) ?? this.tools[0];
        if (!target) throw new Error("expected tool was not exposed");
        const rawArgs = fakeAgentState.invoke.args;
        const args = target.prepareArguments?.(rawArgs) ?? rawArgs;
        this.emit({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: target.name,
          args,
        });
        fakeAgentState.toolResult = await target.execute("call-1", args);
        return;
      }

      if (fakeAgentState.mode === "idle-without-final") {
        // Tool work, then idle. Only a reply nudge (a later prompt) can make it answer.
        if (fakeAgentState.promptInputs.length > 1) {
          if (fakeAgentState.answerOnNudge) {
            const text = "Here is what happened.";
            this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
            this.emit({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text }] },
            });
            this.emit({
              type: "turn_end",
              message: { role: "assistant", content: [{ type: "text", text }] },
              toolResults: [],
            });
          }
          return;
        }
        const target =
          this.tools.find((tool) => tool.name === fakeAgentState.invoke.name) ?? this.tools[0];
        if (!target) throw new Error("expected tool was not exposed");
        const args =
          target.prepareArguments?.(fakeAgentState.invoke.args) ?? fakeAgentState.invoke.args;
        this.emit({ type: "tool_execution_start", toolName: target.name, args });
        const executed = (await target.execute("call-1", args)) as { details?: unknown };
        this.emit({
          type: "turn_end",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: target.name, arguments: args }],
          },
          toolResults: [{ toolCallId: "call-1", result: { ok: true }, details: executed?.details }],
        });
        this.emit({
          type: "turn_end",
          message: { role: "assistant", content: [] },
          toolResults: [],
        });
        return;
      }

      if (fakeAgentState.mode === "unstreamed-final") {
        const target =
          this.tools.find((tool) => tool.name === fakeAgentState.invoke.name) ?? this.tools[0];
        if (!target) throw new Error("expected tool was not exposed");
        const args =
          target.prepareArguments?.(fakeAgentState.invoke.args) ?? fakeAgentState.invoke.args;
        const narration = "I will check the destination first.";
        const text = "The final answer.";
        this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
        this.emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: narration },
        });
        this.emit({ type: "tool_execution_start", toolName: target.name, args });
        const executed = (await target.execute("call-1", args)) as { details?: unknown };
        this.emit({
          type: "turn_end",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: narration },
              { type: "toolCall", id: "call-1", name: target.name, arguments: args },
            ],
          },
          toolResults: [{ toolCallId: "call-1", result: { ok: true }, details: executed?.details }],
        });
        // The final message carries its text only in message_end: no text_delta streamed.
        this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
        this.emit({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
        this.emit({
          type: "turn_end",
          message: { role: "assistant", content: [{ type: "text", text }] },
          toolResults: [],
        });
        return;
      }

      if (fakeAgentState.mode === "scripted-turns") {
        // A reply nudge is a later prompt: the scripted turns only play on the first.
        if (fakeAgentState.promptInputs.length > 1) return;
        let callCount = 0;
        for (const turn of fakeAgentState.turns) {
          if (turn.text) {
            this.emit({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: turn.text },
            });
          }
          const calls = turn.calls.map((call) => ({
            ...call,
            id: `call-${++callCount}`,
          }));
          for (const call of calls) {
            this.emit({ type: "tool_execution_start", toolName: call.name, args: {} });
          }
          this.emit({
            type: "turn_end",
            message: {
              role: "assistant",
              content: [
                ...(turn.text ? [{ type: "text", text: turn.text }] : []),
                ...calls.map((call) => ({
                  type: "toolCall",
                  id: call.id,
                  name: call.name,
                  arguments: {},
                })),
              ],
            },
            toolResults: calls.map((call) => ({
              toolCallId: call.id,
              result: { ok: true },
              details: call.details ?? { ok: true },
            })),
          });
        }
        this.emit({
          type: "turn_end",
          message: { role: "assistant", content: [] },
          toolResults: [],
        });
        return;
      }

      if (fakeAgentState.mode === "silent-continuation") {
        // A reply nudge is a later prompt: the scripted tool step only runs on the first.
        if (fakeAgentState.promptInputs.length > 1) return;
        const target =
          this.tools.find((tool) => tool.name === fakeAgentState.invoke.name) ?? this.tools[0];
        if (!target) throw new Error("expected tool was not exposed");
        const rawArgs = fakeAgentState.invoke.args;
        const args = target.prepareArguments?.(rawArgs) ?? rawArgs;
        const narration = "I will check the destination first.";
        this.emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: narration },
        });
        this.emit({ type: "tool_execution_start", toolName: target.name, args });
        const executed = (await target.execute("call-1", args)) as { details?: unknown };
        this.emit({
          type: "turn_end",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: narration },
              {
                type: "toolCall",
                id: "call-1",
                name: target.name,
                arguments: args,
              },
            ],
          },
          toolResults: [{ toolCallId: "call-1", result: { ok: true }, details: executed?.details }],
        });
        this.emit({
          type: "turn_end",
          message: { role: "assistant", content: [] },
          toolResults: [],
        });
        if (fakeAgentState.followUpMessages.length > 0 && fakeAgentState.emitFinalAfterFollowUp) {
          const text = "The final answer.";
          this.emit({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: text },
          });
          this.emit({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text }] },
          });
          this.emit({
            type: "turn_end",
            message: { role: "assistant", content: [{ type: "text", text }] },
            toolResults: [],
          });
        }
        return;
      }

      if (fakeAgentState.mode === "parent-limit") {
        const shell = this.tools.find((tool) => tool.name === "shell");
        if (!shell) throw new Error("shell was not exposed");
        for (let index = 0; index < 100; index += 1) {
          const args = { command: `echo ${index}` };
          this.emit({ type: "tool_execution_start", toolName: shell.name, args });
          if (this.aborted) break;
          await shell.execute(`shell-${index}`, args);
        }
        return;
      }

      if (fakeAgentState.mode === "parent-parallel") {
        const shell = this.tools.find((tool) => tool.name === "shell");
        if (!shell) throw new Error("shell was not exposed");
        const batch = Array.from({ length: 4 }, (_, index) => ({
          args: { command: `echo ${index}` },
        }));
        for (const item of batch) {
          this.emit({ type: "tool_execution_start", toolName: shell.name, args: item.args });
        }
        await Promise.all(
          batch.map((item, index) =>
            this.aborted ? Promise.resolve() : shell.execute(`shell-${index}`, item.args),
          ),
        );
        return;
      }

      if (fakeAgentState.mode === "ask-pause" || fakeAgentState.mode === "nested-ask-pause") {
        if (fakeAgentState.mode === "nested-ask-pause") {
          const delegation = this.tools.find((tool) => tool.name === "run_subagent");
          if (delegation) {
            const args = { name: "helper", task: "ask the user" };
            this.emit({ type: "tool_execution_start", toolName: delegation.name, args });
            await delegation.execute("delegate-1", args);
            return;
          }
        }
        const shell = this.tools.find((tool) => tool.name === "shell");
        const askUser = this.tools.find((tool) => tool.name === "ask_user");
        if (!shell) throw new Error("shell was not exposed");
        if (!askUser) throw new Error("ask_user was not exposed");
        for (let index = 0; index < 2; index += 1) {
          const args = { command: `echo ${index}` };
          this.emit({ type: "tool_execution_start", toolName: shell.name, args });
          if (this.aborted) return;
          await shell.execute(`shell-pause-${index}`, args);
        }
        const askArgs = {
          question: "Which option?",
          options: ["Keep going", "Stop here"],
        };
        this.emit({ type: "tool_execution_start", toolName: askUser.name, args: askArgs });
        if (!this.aborted) await askUser.execute("ask-1", askArgs);
        return;
      }

      const delegation = this.tools.find((tool) => tool.name === "run_subagent");
      if (delegation) {
        const args = { name: "loop", task: "keep calling shell" };
        this.emit({ type: "tool_execution_start", toolName: delegation.name, args });
        await delegation.execute("delegate-1", args);
        return;
      }

      const shell = this.tools.find((tool) => tool.name === "shell");
      if (!shell) throw new Error("shell was not exposed to the subagent");
      for (let index = 0; index < 100; index += 1) {
        const args = { command: `echo ${index}` };
        this.emit({ type: "tool_execution_start", toolName: shell.name, args });
        if (this.aborted) break;
        await shell.execute(`shell-${index}`, args);
      }
    }

    async waitForIdle() {}

    steer(message: unknown) {
      fakeAgentState.steeredMessages.push(message);
    }

    followUp(message: unknown) {
      fakeAgentState.followUpMessages.push(message);
    }

    abort() {
      this.aborted = true;
      // Mirror pi-agent-core: abort settles the run with an errorMessage that
      // would otherwise make PiAgentRuntime throw and skip a final reply.
      this.state.errorMessage = "Request aborted by user";
      fakeAgentState.abortCount += 1;
    }

    private emit(event: Record<string, unknown>) {
      for (const listener of this.listeners) listener(event);
    }
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "dispatch-test-model" ? { provider: "test", id: modelId } : undefined,
    streamSimple: () => {
      throw new Error("the fake agent must not call a provider");
    },
  }),
}));

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));

vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { decideWithin } from "./decision.js";
import { FakeDecisionProvider } from "./fake-decision.js";
import {
  maxToolCallsPerTurn,
  PiAgentRuntime,
  REPLY_NUDGE_PROMPT,
  refuseBatchedTakeover,
  TAKEOVER_ALONE_MESSAGE,
} from "./pi-runtime.js";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";
import { TraceExporter } from "./trace-export.js";

const destinationTool: ConnectorTool = {
  name: "destination.write",
  description: "Write a record to the connected destination",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
    },
  },
  route: { connectorId: "destination", toolName: "destination.write" },
};

const writeFileTool: ConnectorTool = {
  name: "write_file",
  description: "Write a UTF-8 file into this bot's home.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
  },
};

const shellTool = {
  name: "shell",
  description: "Run a command",
  inputSchema: { type: "object", properties: { command: { type: "string" } } },
};

const previousMaxToolCalls = process.env.MAX_TOOL_CALLS_PER_TURN;

describe("Pi connector tool dispatch", () => {
  beforeEach(() => {
    fakeAgentState.mode = "dispatch";
    fakeAgentState.abortCount = 0;
    fakeAgentState.tools = [];
    fakeAgentState.preparedMessages = [];
    fakeAgentState.steeredMessages = [];
    fakeAgentState.followUpMessages = [];
    fakeAgentState.turns = [];
    fakeAgentState.emitFinalAfterFollowUp = true;
    fakeAgentState.answerOnNudge = false;
    fakeAgentState.initialMessages = [];
    fakeAgentState.promptInputs = [];
    fakeAgentState.promptImages = [];
    fakeAgentState.toolResult = undefined;
    fakeAgentState.beforeToolCall = undefined;
    fakeAgentState.invoke = {
      name: "destination_write",
      args: { collection: "notes", title: "Result", body: "Done" },
    };
    delete process.env.MAX_TOOL_CALLS_PER_TURN;
  });

  describe("request_takeover alone in its turn", () => {
    const call = (name: string, id: string) => ({
      type: "toolCall" as const,
      id,
      name,
      arguments: {},
    });
    const contextFor = (toolName: string, ...names: string[]) =>
      ({
        assistantMessage: { role: "assistant", content: names.map((n, i) => call(n, `c${i}`)) },
        toolCall: call(toolName, "c0"),
        args: {},
        context: { systemPrompt: "", messages: [], tools: [] },
      }) as unknown as Parameters<typeof refuseBatchedTakeover>[0];

    it("blocks a takeover batched with another tool call", async () => {
      await expect(
        refuseBatchedTakeover(
          contextFor("request_takeover", "browser_navigate", "request_takeover"),
        ),
      ).resolves.toEqual({ block: true, reason: TAKEOVER_ALONE_MESSAGE });
    });

    it("lets a takeover alone in its turn run", async () => {
      await expect(
        refuseBatchedTakeover(contextFor("request_takeover", "request_takeover")),
      ).resolves.toBeUndefined();
    });

    it("leaves other tools in a batch alone", async () => {
      await expect(
        refuseBatchedTakeover(
          contextFor("browser_navigate", "browser_navigate", "request_takeover"),
        ),
      ).resolves.toBeUndefined();
    });

    it("wires the refusal into the agent", async () => {
      fakeAgentState.mode = "empty";
      const runtime = new PiAgentRuntime();
      for await (const _event of runtime.run(
        {
          botId: "b",
          threadId: "t",
          runId: "takeover-batch",
          prompt: "go",
          instructions: "Use tools.",
          history: [],
          tools: [],
          model: { provider: "test", id: "dispatch-test-model" },
          executeTool: vi.fn(),
        },
        {
          operationId: "tb",
          traceId: "tb",
          spaceId: "w",
          userId: "u",
          signal: new AbortController().signal,
        },
      )) {
        // drain
      }
      expect(fakeAgentState.beforeToolCall).toBeDefined();
      await expect(
        fakeAgentState.beforeToolCall?.(
          contextFor("request_takeover", "browser_navigate", "request_takeover"),
        ),
      ).resolves.toEqual({ block: true, reason: TAKEOVER_ALONE_MESSAGE });
    });
  });

  it("injects durable steering at Pi's next safe turn boundary", async () => {
    fakeAgentState.mode = "empty";
    let claimCount = 0;
    const claimSteering = vi.fn(async () => {
      claimCount += 1;
      return claimCount === 1
        ? []
        : [
            { id: "steering-1", messageId: "message-1", text: "Use the newer customer totals." },
            { id: "steering-2", messageId: "message-2", text: "Keep the original date range." },
          ];
    });
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "prepare the report",
        instructions: "Follow the user's instructions.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        claimSteering,
      },
      { signal: new AbortController().signal },
    )) {
      // Exhaust the runtime event stream.
    }

    expect(claimSteering).toHaveBeenNthCalledWith(1, []);
    expect(claimSteering).toHaveBeenNthCalledWith(2, []);
    expect(fakeAgentState.preparedMessages).toEqual([
      expect.objectContaining({ role: "user", content: "Use the newer customer totals." }),
      expect.objectContaining({ role: "user", content: "Keep the original date range." }),
    ]);
  });

  it("defers steering arriving during a continuation to the following boundary", async () => {
    fakeAgentState.mode = "two-boundaries";
    let claimCount = 0;
    const claimSteering = vi.fn(async () => {
      claimCount += 1;
      if (claimCount === 1) return [];
      return claimCount === 2
        ? [{ id: "steering-1", messageId: "message-1", text: "First boundary context." }]
        : [{ id: "steering-2", messageId: "message-2", text: "Next boundary context." }];
    });
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "continue",
        instructions: "Follow the user's instructions.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        claimSteering,
      },
      { signal: new AbortController().signal },
    )) {
      // Exhaust the runtime event stream.
    }

    expect(claimSteering).toHaveBeenNthCalledWith(1, []);
    expect(claimSteering).toHaveBeenNthCalledWith(2, []);
    expect(claimSteering).toHaveBeenNthCalledWith(3, ["steering-1"]);
    expect(fakeAgentState.preparedMessages).toEqual([
      expect.objectContaining({ content: "First boundary context." }),
      expect.objectContaining({ content: "Next boundary context." }),
    ]);
  });

  it("consumes pending continuation steering once in the first prompt", async () => {
    fakeAgentState.mode = "empty";
    const steering = [
      { id: "steering-1", messageId: "message-1", text: "Use the newer customer totals." },
      { id: "steering-2", messageId: "message-2", text: "Keep the original date range." },
    ];
    const claimSteering = vi.fn(async (seenIds: string[]) => (seenIds.length ? [] : steering));
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "continuation",
        prompt: "Respond to the user's steering context.",
        instructions: "Follow the user's instructions.",
        history: [
          { id: steering[0]!.messageId, role: "user", content: steering[0]!.text },
          { id: steering[1]!.messageId, role: "user", content: steering[1]!.text },
          { role: "assistant", content: "Here is the first result." },
        ],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        claimSteering,
      },
      { signal: new AbortController().signal },
    )) {
      // Exhaust the runtime event stream.
    }

    expect(fakeAgentState.promptInputs).toHaveLength(1);
    for (const item of steering) {
      expect(fakeAgentState.promptInputs[0]?.split(item.text)).toHaveLength(2);
      expect(JSON.stringify(fakeAgentState.initialMessages)).not.toContain(item.text);
    }
    expect(fakeAgentState.steeredMessages).toEqual([]);
  });

  it("delivers images attached to initial and boundary steering", async () => {
    fakeAgentState.mode = "empty";
    let claimCount = 0;
    const claimSteering = vi.fn(async () => {
      claimCount += 1;
      if (claimCount === 1) {
        return [
          {
            id: "initial-image",
            messageId: "initial-image-message",
            text: "Inspect the first image.",
            images: [
              {
                name: "first.png",
                mimeType: "image/png" as const,
                data: new Uint8Array([1, 2, 3]),
              },
            ],
          },
        ];
      }
      return [
        {
          id: "boundary-image",
          messageId: "boundary-image-message",
          text: "Compare the second image.",
          images: [
            { name: "second.png", mimeType: "image/png" as const, data: new Uint8Array([4, 5, 6]) },
          ],
        },
      ];
    });
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "image-steering",
        prompt: "continue",
        instructions: "Inspect attached images.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        claimSteering,
      },
      { signal: new AbortController().signal },
    )) {
      // Exhaust the runtime event stream.
    }

    expect(fakeAgentState.promptImages).toEqual([
      [{ type: "image", data: "AQID", mimeType: "image/png" }],
    ]);
    expect(fakeAgentState.steeredMessages).toContainEqual({
      role: "user",
      content: [
        { type: "text", text: "Compare the second image." },
        { type: "image", data: "BAUG", mimeType: "image/png" },
      ],
      timestamp: expect.any(Number),
    });
  });

  afterEach(() => {
    if (previousMaxToolCalls === undefined) delete process.env.MAX_TOOL_CALLS_PER_TURN;
    else process.env.MAX_TOOL_CALLS_PER_TURN = previousMaxToolCalls;
  });

  it.each([undefined, "", ".", "/home/rakazo", "subdir"])(
    "preserves executor-owned shell cwd defaults (%j)",
    async (cwd) => {
      const command = "printf WORKSPACE_OK > roundtrip.txt";
      fakeAgentState.invoke = {
        name: "shell",
        args: cwd === undefined ? { command } : { command, cwd },
      };
      const executeTool = vi.fn(async () => ({ ok: true }));
      const runtime = new PiAgentRuntime();
      for await (const _event of runtime.run(
        {
          botId: "b",
          threadId: "t",
          runId: "r",
          prompt: "write the workspace test file",
          instructions: "Use shell.",
          history: [],
          tools: [shellTool],
          model: { provider: "test", id: "dispatch-test-model" },
          executeTool,
        },
        { signal: new AbortController().signal },
      )) {
        // Exercise Pi argument preparation and execution, not just path helpers.
      }
      expect(executeTool.mock.calls).toStrictEqual([
        ["shell", cwd ? { command, cwd } : { command }, "call-1"],
      ]);
    },
  );

  it("exposes a provider-safe name while executing the original connector name", async () => {
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "write the result",
        instructions: "Use destination_write for connected destination records.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "1",
        traceId: "1",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust the runtime event stream so tool execution completes.
    }

    expect(fakeAgentState.tools.map((tool) => tool.name)).toEqual(["destination_write"]);
    expect(executeTool).toHaveBeenCalledWith(
      "destination.write",
      { collection: "notes", title: "Result", body: "Done" },
      "call-1",
      { connectorId: "destination", toolName: "destination.write" },
    );
  });

  it("does not claim a tool-only turn finished work the model never described", async () => {
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "tool-only",
        prompt: "send the update",
        instructions: "Use the destination tool.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "tool-only",
        traceId: "tool-only",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "progress",
      text: "Using destination_write",
      activity: true,
    });
    expect(events).not.toContainEqual({ type: "text", text: "I finished the work." });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("continues after narration is followed by a silent tool result turn", async () => {
    fakeAgentState.mode = "silent-continuation";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];
    const onToolCompleted = vi.fn();

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "silent-continuation",
        prompt: "send the update and report back",
        instructions: "Use the destination tool, then tell the user what happened.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
        onToolCompleted,
      },
      {
        operationId: "silent-continuation",
        traceId: "silent-continuation",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(fakeAgentState.followUpMessages).toHaveLength(1);
    expect(fakeAgentState.followUpMessages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Continue"),
      }),
    );
    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "destination.write",
        executionId: "call-1",
        result: expect.objectContaining({ content: expect.any(Array) }),
        durationMs: expect.any(Number),
      }),
    );
    expect(events).toContainEqual({ type: "text", text: "The final answer." });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "I will check the destination first.The final answer.",
    });
  });

  it("does not wait for a slow tool completion hook", async () => {
    let resolveAudit!: () => void;
    const audit = new Promise<void>((resolve) => {
      resolveAudit = resolve;
    });
    const onToolCompleted = vi.fn(() => audit);
    let settled = false;
    const runtime = new PiAgentRuntime();
    const run = (async () => {
      for await (const _event of runtime.run(
        {
          botId: "b",
          threadId: "t",
          runId: "non-blocking-audit",
          prompt: "send the update",
          instructions: "Use the destination tool.",
          history: [],
          tools: [destinationTool],
          model: { provider: "test", id: "dispatch-test-model" },
          executeTool: vi.fn(async () => ({ ok: true })),
          onToolCompleted,
        },
        {
          operationId: "non-blocking-audit",
          traceId: "non-blocking-audit",
          spaceId: "w",
          userId: "u",
          signal: new AbortController().signal,
        },
      )) {
        // Exhaust the runtime event stream.
      }
    })().finally(() => {
      settled = true;
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(true);
      expect(onToolCompleted).toHaveBeenCalledOnce();
    } finally {
      resolveAudit();
      await run;
    }
  });

  it("makes an unfinished tool turn visible instead of completing silently", async () => {
    fakeAgentState.mode = "silent-continuation";
    fakeAgentState.emitFinalAfterFollowUp = false;
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "silent-fallback",
        prompt: "send the update and report back",
        instructions: "Use the destination tool, then tell the user what happened.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "silent-fallback",
        traceId: "silent-fallback",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "text",
      text: "I completed the tool step but could not produce a final response. Please ask me to continue.",
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "I completed the tool step but could not produce a final response. Please ask me to continue.",
    });
  });

  it("ends silently when the tool turn closed on a delivered message_user bubble", async () => {
    fakeAgentState.mode = "silent-continuation";
    fakeAgentState.invoke = { name: "message_user", args: { message: "Here is the answer." } };
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "bubble-then-silence",
        prompt: "what is the answer?",
        instructions: "Answer with message_user bubbles.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "bubble-then-silence",
        traceId: "bubble-then-silence",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(fakeAgentState.followUpMessages).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("could not produce a final response");
  });

  it("still asks for a final reply when the bubble turn also ran tools with results to report", async () => {
    fakeAgentState.mode = "scripted-turns";
    fakeAgentState.turns = [{ calls: [{ name: "web_search" }, { name: "message_user" }] }];
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "search-then-bubble",
        prompt: "look it up",
        instructions: "Search, then answer.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "search-then-bubble",
        traceId: "search-then-bubble",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(fakeAgentState.followUpMessages).toHaveLength(1);
    expect(JSON.stringify(events)).toContain("could not produce a final response");
  });

  it("ends quietly when the bubble turn only added memory writes", async () => {
    fakeAgentState.mode = "scripted-turns";
    fakeAgentState.turns = [{ calls: [{ name: "remember" }, { name: "message_user" }] }];
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "remember-then-bubble",
        prompt: "note this and confirm",
        instructions: "Remember, then answer.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "remember-then-bubble",
        traceId: "remember-then-bubble",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(fakeAgentState.followUpMessages).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("could not produce a final response");
  });

  it("still asks for a final reply when the last message_user bubble was cut off", async () => {
    fakeAgentState.mode = "silent-continuation";
    fakeAgentState.invoke = { name: "message_user", args: { message: "x".repeat(600) } };
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "cut-bubble",
        prompt: "write the full report",
        instructions: "Answer with message_user bubbles.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true, truncated: true })),
      },
      {
        operationId: "cut-bubble",
        traceId: "cut-bubble",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust the runtime event stream.
    }

    expect(fakeAgentState.followUpMessages).toHaveLength(1);
  });

  it("still asks for a final reply when the last message_user bubble was refused", async () => {
    fakeAgentState.mode = "silent-continuation";
    fakeAgentState.emitFinalAfterFollowUp = false;
    fakeAgentState.invoke = { name: "message_user", args: { message: "Here is the answer." } };
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "refused-bubble",
        prompt: "what is the answer?",
        instructions: "Answer with message_user bubbles.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ error: "message is required" })),
      },
      {
        operationId: "refused-bubble",
        traceId: "refused-bubble",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(fakeAgentState.followUpMessages).toHaveLength(1);
    expect(JSON.stringify(events)).toContain("could not produce a final response");
  });

  it("lets a run allowed to stay silent end quietly after its tools", async () => {
    fakeAgentState.mode = "silent-continuation";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "routine-silence",
        prompt: "check the calendar; if nothing is at risk, say nothing",
        instructions: "Use the destination tool.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        allowSilentEmpty: true,
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "routine-silence",
        traceId: "routine-silence",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(fakeAgentState.followUpMessages).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("could not produce a final response");
    // The turn's words are not carried as the run's final text; they are flagged as closing words
    // for the executor, since the run stopped right after the tool turn that wrote them.
    expect(events.at(-1)).toEqual({ type: "done", closingNarration: true });
  });

  it("flags the words written with the last tool call when a silent-capable run then stops", async () => {
    fakeAgentState.mode = "scripted-turns";
    fakeAgentState.turns = [
      { text: "I'll check the calendar.", calls: [{ name: "check_calendar" }] },
      { text: "Two invoices are overdue.", calls: [{ name: "remember" }] },
    ];
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "routine-closing",
        prompt: "check invoices",
        instructions: "Report overdue invoices.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        allowSilentEmpty: true,
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "routine-closing",
        traceId: "routine-closing",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(fakeAgentState.followUpMessages).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "done", closingNarration: true });
  });

  it("does not flag a closing narration when the last tool turn wrote nothing", async () => {
    fakeAgentState.mode = "scripted-turns";
    fakeAgentState.turns = [
      { text: "I'll check the calendar.", calls: [{ name: "check_calendar" }] },
      { calls: [{ name: "remember" }] },
    ];
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "routine-preamble",
        prompt: "check invoices",
        instructions: "Report overdue invoices.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        allowSilentEmpty: true,
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "routine-preamble",
        traceId: "routine-preamble",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("publishes a final answer that arrives without any text delta", async () => {
    fakeAgentState.mode = "unstreamed-final";
    const runtime = new PiAgentRuntime();
    const events: Array<{ type: string; text?: string }> = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "unstreamed-final",
        prompt: "send the update and report back",
        instructions: "Use the destination tool, then tell the user what happened.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "unstreamed-final",
        traceId: "unstreamed-final",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "text", text: "The final answer." });
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    expect(done?.text?.endsWith("The final answer.")).toBe(true);
    expect(fakeAgentState.promptInputs).toHaveLength(1);
  });

  it("nudges twice for a reply when the agent idles after tools, then falls back", async () => {
    fakeAgentState.mode = "idle-without-final";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "idle-without-final",
        prompt: "send the update and report back",
        instructions: "Use the destination tool, then tell the user what happened.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "idle-without-final",
        traceId: "idle-without-final",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(
      fakeAgentState.promptInputs.filter((input) => input === REPLY_NUDGE_PROMPT),
    ).toHaveLength(2);
    expect(events).toContainEqual({
      type: "text",
      text: "I completed the tool step but could not produce a final response. Please ask me to continue.",
    });
  });

  it("stops nudging once the reply arrives", async () => {
    fakeAgentState.mode = "idle-without-final";
    fakeAgentState.answerOnNudge = true;
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "nudge-answers",
        prompt: "send the update and report back",
        instructions: "Use the destination tool, then tell the user what happened.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "nudge-answers",
        traceId: "nudge-answers",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(
      fakeAgentState.promptInputs.filter((input) => input === REPLY_NUDGE_PROMPT),
    ).toHaveLength(1);
    expect(events).toContainEqual({ type: "text", text: "Here is what happened." });
    expect(JSON.stringify(events)).not.toContain("could not produce a final response");
  });

  it("does not nudge a run allowed to stay silent", async () => {
    fakeAgentState.mode = "idle-without-final";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "idle-silent-allowed",
        prompt: "send the update and report back",
        instructions: "Use the destination tool, then tell the user what happened.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        allowSilentEmpty: true,
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "idle-silent-allowed",
        traceId: "idle-silent-allowed",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(fakeAgentState.promptInputs).not.toContain(REPLY_NUDGE_PROMPT);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("keeps FYI bot-message wakes silent when the model produces nothing", async () => {
    fakeAgentState.mode = "empty";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "bot-wake-silent",
        prompt: "[bot] FYI only",
        instructions: "Stay silent when there is nothing to do.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        allowSilentEmpty: true,
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "bot-wake-silent",
        traceId: "bot-wake-silent",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).not.toContainEqual({ type: "text", text: "No response. Try again." });
    expect(events).toEqual([{ type: "done" }]);
  });

  it("still asks the user to retry when a normal empty turn produces nothing", async () => {
    fakeAgentState.mode = "empty";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "user-empty",
        prompt: "hello",
        instructions: "Reply to the user.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "user-empty",
        traceId: "user-empty",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "text", text: "No response. Try again." });
    expect(events.at(-1)).toEqual({ type: "done", text: "No response. Try again." });
  });

  it("surfaces a contextual peer fallback when that run produces nothing", async () => {
    fakeAgentState.mode = "empty";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "peer-result-empty",
        prompt: "[bot] result",
        instructions: "Summarize the result.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        emptyResponseText: "Update from Researcher: The answer is 42.",
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "peer-result-empty",
        traceId: "peer-result-empty",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "text",
      text: "Update from Researcher: The answer is 42.",
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "Update from Researcher: The answer is 42.",
    });
  });

  it("normalizes a blank contextual fallback", async () => {
    fakeAgentState.mode = "empty";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "peer-result-blank",
        prompt: "[bot] result",
        instructions: "Summarize the result.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        emptyResponseText: "   ",
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "peer-result-blank",
        traceId: "peer-result-blank",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "done", text: "No response. Try again." });
  });

  it("allows more than 80 tool calls by default when no fuse is configured", async () => {
    fakeAgentState.mode = "parent-limit";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "unlimited",
        prompt: "keep going",
        instructions: "Use shell.",
        history: [],
        tools: [shellTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "2a",
        traceId: "2a",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(100);
    expect(fakeAgentState.abortCount).toBe(0);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "progress",
        text: expect.stringContaining("tool calls in one turn"),
      }),
    );
  });

  it("soft-stops with a final message when MAX_TOOL_CALLS_PER_TURN is set", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "80";
    fakeAgentState.mode = "parent-limit";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "parent-limited",
        prompt: "keep going",
        instructions: "Use shell.",
        history: [],
        tools: [shellTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "2b",
        traceId: "2b",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(80);
    expect(fakeAgentState.abortCount).toBeGreaterThanOrEqual(1);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: more than 80 tool calls in one turn.",
    });
    expect(events).toContainEqual({
      type: "text",
      text: "I stopped after reaching the limit of 80 tool calls in this turn. Send another message to continue.",
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "I stopped after reaching the limit of 80 tool calls in this turn. Send another message to continue.",
    });
  });

  it("shares an optional tool-call fuse with subagents and still emits a final message", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "80";
    fakeAgentState.mode = "subagent-limit";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "limited",
        prompt: "delegate the loop",
        instructions: "Use run_subagent.",
        history: [],
        tools: [
          {
            name: "run_subagent",
            description: "Delegate work",
            inputSchema: { type: "object", properties: {} },
          },
          shellTool,
        ],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "2",
        traceId: "2",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(79);
    expect(fakeAgentState.abortCount).toBeGreaterThanOrEqual(1);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: more than 80 tool calls in one turn.",
    });
    expect(events).toContainEqual({
      type: "text",
      text: "I stopped after reaching the limit of 80 tool calls in this turn. Send another message to continue.",
    });
    expect(events).toContainEqual({
      type: "done",
      text: "I stopped after reaching the limit of 80 tool calls in this turn. Send another message to continue.",
    });
    const subagentEvents = events.filter(
      (event): event is { type: "subagent"; status: string; result?: string } =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        (event as { type?: string }).type === "subagent",
    );
    expect(subagentEvents.some((event) => event.status === "failed")).toBe(false);
    expect(subagentEvents).toContainEqual(
      expect.objectContaining({
        type: "subagent",
        status: "completed",
        result:
          "I stopped after reaching the limit of 80 tool calls in this turn. Send another message to continue.",
      }),
    );
  });

  it("treats unset, empty, and non-positive MAX_TOOL_CALLS_PER_TURN as unlimited", () => {
    expect(maxToolCallsPerTurn({})).toBe(0);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: "" })).toBe(0);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: "0" })).toBe(0);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: "-5" })).toBe(0);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: "abc" })).toBe(0);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: "80" })).toBe(80);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: " 12.9 " })).toBe(12);
  });

  it("lets a parallel tool batch finish before the optional fuse aborts", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "2";
    fakeAgentState.mode = "parent-parallel";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "parallel-fuse",
        prompt: "run them together",
        instructions: "Use shell.",
        history: [],
        tools: [shellTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "2c",
        traceId: "2c",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(fakeAgentState.abortCount).toBeGreaterThanOrEqual(1);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: more than 2 tool calls in one turn.",
    });
  });

  it("keeps an optional tool-call fuse across a second run() for the same runId", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "5";
    fakeAgentState.mode = "parent-limit";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const abort = new AbortController();
    let started = 0;
    executeTool.mockImplementation(async () => {
      started += 1;
      if (started === 2) abort.abort();
      return { ok: true };
    });

    await expect(async () => {
      for await (const _event of runtime.run(
        {
          botId: "b",
          threadId: "t",
          runId: "fuse-resume",
          prompt: "keep going",
          instructions: "Use shell.",
          history: [],
          tools: [shellTool],
          model: { provider: "test", id: "dispatch-test-model" },
          executeTool,
        },
        {
          operationId: "2d",
          traceId: "2d",
          spaceId: "w",
          userId: "u",
          signal: abort.signal,
        },
      )) {
        // Exhaust until abort fails the turn.
      }
    }).rejects.toThrow();

    executeTool.mockImplementation(async () => ({ ok: true }));
    const events: unknown[] = [];
    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "fuse-resume",
        prompt: "keep going",
        instructions: "Use shell.",
        history: [],
        tools: [shellTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "2e",
        traceId: "2e",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(5);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: more than 5 tool calls in one turn.",
    });
  });

  it("keeps an optional tool-call fuse across ask_user pause and continueRun", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "4";
    fakeAgentState.mode = "ask-pause";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];
    const request = {
      botId: "b",
      threadId: "t",
      runId: "fuse-ask-pause",
      prompt: "keep going",
      instructions: "Use shell, then ask.",
      history: [],
      tools: [
        shellTool,
        {
          name: "ask_user",
          description: "Ask a short multiple-choice question",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      model: { provider: "test", id: "dispatch-test-model" },
      executeTool,
    };

    for await (const event of runtime.run(request, {
      operationId: "2f",
      traceId: "2f",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ask",
        text: "Which option?",
      }),
    );

    fakeAgentState.mode = "parent-limit";
    const resumed: unknown[] = [];
    for await (const event of runtime.run(
      {
        ...request,
        tools: [shellTool],
      },
      {
        operationId: "2g",
        traceId: "2g",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      resumed.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(resumed).toContainEqual({
      type: "progress",
      text: "Stopped: more than 4 tool calls in one turn.",
    });
  });

  it("keeps an optional tool-call fuse across nested ask_user pause and continueRun", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "4";
    fakeAgentState.mode = "nested-ask-pause";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];
    const request = {
      botId: "b",
      threadId: "t",
      runId: "fuse-nested-ask-pause",
      prompt: "delegate then ask",
      instructions: "Use a subagent.",
      history: [],
      tools: [
        {
          name: "run_subagent",
          description: "Delegate work",
          inputSchema: { type: "object", properties: {} },
        },
        shellTool,
        {
          name: "ask_user",
          description: "Ask a short multiple-choice question",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      model: { provider: "test", id: "dispatch-test-model" },
      executeTool,
    };

    for await (const event of runtime.run(request, {
      operationId: "2h",
      traceId: "2h",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ask",
        text: "Which option?",
      }),
    );

    fakeAgentState.mode = "parent-limit";
    const resumed: unknown[] = [];
    for await (const event of runtime.run(
      {
        ...request,
        tools: [shellTool],
      },
      {
        operationId: "2i",
        traceId: "2i",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      resumed.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(resumed).toContainEqual({
      type: "progress",
      text: "Stopped: more than 4 tool calls in one turn.",
    });
  });

  it("clips structured tool results to one aggregate text budget", async () => {
    const first = "a".repeat(TOOL_RESULT_TEXT_LIMIT - 5);
    const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" as const };
    fakeAgentState.invoke = {
      name: "destination_write",
      args: { collection: "notes", title: "Result", body: "Done" },
    };
    const executeTool = vi.fn(async () => ({
      kind: "agent_tool_result",
      content: [
        { type: "text" as const, text: first },
        image,
        { type: "text" as const, text: "bbbbbbbbbb" },
        { type: "text" as const, text: "omit me" },
      ],
      details: { ok: true },
    }));
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "clip-multipart",
        prompt: "write it",
        instructions: "Use the destination.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "clip",
        traceId: "2h",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust so the fake agent executes the tool.
    }

    const result = fakeAgentState.toolResult as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(result.content).toHaveLength(3);
    expect(result.content[0]).toEqual({ type: "text", text: first });
    expect(result.content[1]).toEqual(image);
    expect(result.content[2]).toEqual({ type: "text", text: "bbbbb…" });
  });

  it("serialises object content instead of writing [object Object] for write_file", async () => {
    fakeAgentState.invoke = {
      name: "write_file",
      args: { path: "shared/state.json", content: { last_run: 1_787_648_953 } },
    };
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "save the state file",
        instructions: "Use write_file to save state.",
        history: [],
        tools: [writeFileTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "3",
        traceId: "3",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust the runtime event stream so tool execution completes.
    }

    expect(executeTool).toHaveBeenCalledWith(
      "write_file",
      {
        path: "shared/state.json",
        content: '{\n  "last_run": 1787648953\n}',
      },
      "call-1",
    );
  });

  it("hands a traced tool call a trace that nests its decisions under the tool span", async () => {
    fakeAgentState.invoke = { name: "write_file", args: { path: "a.txt", content: "x" } };
    const sent: unknown[] = [];
    const exporter = new TraceExporter({
      send: async (payload) => {
        sent.push(payload);
      },
    });
    const context: AdapterContext = {
      operationId: "4",
      traceId: "4",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    };
    const traces: Array<ToolCallTrace | undefined> = [];
    const executeTool = vi.fn(
      async (
        _name: string,
        _args: Record<string, unknown>,
        _executionId: string,
        _route?: unknown,
        trace?: ToolCallTrace,
      ) => {
        traces.push(trace);
        await decideWithin(
          new FakeDecisionProvider({
            script: [{ answers: { done: { type: "noul", probability: 0.9 } } }],
          }),
          { state: "s", questions: { done: { type: "noul", instructions: "Done?" } } },
          context,
          { timeoutMs: 1_000, purpose: "run_step", trace },
        );
        return { ok: true };
      },
    );

    for (const runtime of [new PiAgentRuntime(), new PiAgentRuntime({ traceExporter: exporter })]) {
      for await (const _event of runtime.run(
        {
          botId: "b",
          threadId: "t",
          runId: "r",
          prompt: "save",
          instructions: "Use write_file.",
          history: [],
          tools: [writeFileTool],
          model: { provider: "test", id: "dispatch-test-model" },
          executeTool,
        },
        context,
      )) {
        // Exhaust the runtime event stream so tool execution completes.
      }
    }
    await exporter.flush();

    expect(executeTool.mock.calls[0]).toHaveLength(3);
    expect(traces[0]).toBeUndefined();
    const spans = (
      sent[0] as {
        resourceSpans: Array<{
          scopeSpans: Array<{
            spans: Array<{ name: string; spanId: string; parentSpanId?: string }>;
          }>;
        }>;
      }
    ).resourceSpans[0]!.scopeSpans[0]!.spans;
    const tool = spans.find((span) => span.name === "tool write_file");
    const decision = spans.find((span) => span.name === "decision run_step");
    expect(tool).toBeDefined();
    expect(decision?.parentSpanId).toBe(tool?.spanId);
  });
});
