import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { PiAgentRuntime } from "@rakazo/adapters";
import { SessionEntrySchema } from "@rakazo/contracts";
import { projectInferenceTurns } from "@rakazo/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ModelEmulatorRequest,
  type ModelEmulatorResponse,
  type ModelEmulatorStep,
  startModelEmulator,
} from "./model-emulator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const writeTool: ConnectorTool = {
  name: "write_file",
  description: "Save a UTF-8 file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

const publishTool: ConnectorTool = {
  name: "publish_note",
  description: "Publish a note to the connected workspace",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
};

const subagentTool: ConnectorTool = {
  name: "run_subagent",
  description: "Run a helper",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, task: { type: "string" } },
    required: ["name", "task"],
  },
};

function pausingPublish(calls: string[]): AgentRunRequest["executeTool"] {
  return async (name) => {
    calls.push(name);
    if (name !== "publish_note") return { path: "notes.txt", bytes: 5 };
    return {
      kind: "agent_tool_result",
      content: [{ type: "text", text: "Waiting for approval." }],
      details: { approval: "paused" },
      terminate: true,
    };
  };
}

function runRequest(
  model: AgentRunRequest["model"],
  overrides: Partial<AgentRunRequest> = {},
): AgentRunRequest {
  return {
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId: randomUUID(),
    prompt: "Save hello to notes.txt.",
    instructions: "Complete the requested task.",
    history: [],
    tools: [writeTool],
    model,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<AgentRuntimeEvent>, events: AgentRuntimeEvent[] = []) {
  for await (const event of stream) events.push(event);
  return events;
}

function latestToolResult(request: ModelEmulatorRequest) {
  return request.messages.findLast((message) => message.role === "tool");
}

describe("real Pi against an offline model HTTP endpoint", () => {
  it("assembles fragmented tool arguments, executes the write, and sends its result back", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-pi-offline-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const calls: Array<{ name: string; args: Record<string, unknown>; id?: string }> = [];
    const server = await startModelEmulator({
      apiKey: "fixture-only-key",
      steps: [
        {
          expect(request) {
            expect(request.messages.at(-1)).toMatchObject({
              role: "user",
              content: [{ type: "text", text: "Save hello to notes.txt." }],
            });
            expect(request.tools).toContainEqual(
              expect.objectContaining({
                function: expect.objectContaining({ name: "write_file" }),
              }),
            );
          },
          response: {
            type: "tool",
            id: "write-1",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hello\n" },
            argumentChunks: ['{"pa', 'th":"notes.', 'txt","content":"hel', "lo\\", 'n"}'],
          },
        },
        {
          expect(request) {
            expect(
              request.messages.find((message) => message.role === "assistant")?.tool_calls,
            ).toEqual([
              {
                id: "write-1",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "notes.txt", content: "hello\n" }),
                },
              },
            ]);
            expect(latestToolResult(request)).toMatchObject({ tool_call_id: "write-1" });
            expect(JSON.parse(String(latestToolResult(request)?.content))).toEqual({
              path: "notes.txt",
              bytes: 6,
            });
          },
          response: { type: "text", text: "Saved notes.txt." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          async executeTool(name, args, id) {
            calls.push({ name, args, id });
            expect(name).toBe("write_file");
            expect(args.path).toBe("notes.txt");
            await writeFile(path.join(dir, "notes.txt"), String(args.content));
            return { path: "notes.txt", bytes: Buffer.byteLength(String(args.content)) };
          },
        }),
      ),
    ).catch((error) => {
      try {
        server.assertComplete();
      } catch (fixtureError) {
        throw new AggregateError(
          [error, fixtureError],
          "Pi failed and model fixture validation also failed",
        );
      }
      throw error;
    });
    server.assertComplete();
    expect(calls).toEqual([
      {
        name: "write_file",
        args: { path: "notes.txt", content: "hello\n", overwrite: false },
        id: "write-1",
      },
    ]);
    expect(await readFile(path.join(dir, "notes.txt"), "utf8")).toBe("hello\n");
    expect(events.at(-1)).toEqual({ type: "done", text: "Saved notes.txt." });
  });

  it("sends the run's source once as the prompt and its claimed steering once, by the entry ids history turns carry", async () => {
    const entry = (seq: number, body: object) =>
      SessionEntrySchema.parse({
        id: `entry-${seq}`,
        sessionId: "ses_dedup",
        seq,
        parentId: seq === 0 ? null : `entry-${seq - 1}`,
        ts: new Date(Date.UTC(2026, 9, 11, 9, 0, seq)).toISOString(),
        ...body,
      });
    const said = (seq: number, text: string) =>
      entry(seq, {
        type: "user.message",
        payload: { blocks: [{ kind: "text", text }], source: "app" },
      });
    const history = projectInferenceTurns(
      [
        said(0, "What changed?"),
        entry(1, {
          botId: "fixture-bot",
          runId: "run-before",
          type: "assistant.text",
          payload: { blocks: [{ kind: "text", text: "Two files." }] },
        }),
        said(2, "Summarize them."),
        said(3, "Also the tests."),
      ],
      { selfBotId: "fixture-bot" },
    );
    const prompt = "Current date and time: Sunday.\n\nSummarize them.";
    const textOf = (content: unknown) =>
      typeof content === "string"
        ? content
        : (content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
    const server = await startModelEmulator({
      steps: [
        {
          expect(request) {
            expect(
              request.messages
                .filter((message) => message.role !== "system")
                .map((message) => ({ role: message.role, text: textOf(message.content) })),
            ).toEqual([
              { role: "user", text: "What changed?" },
              { role: "assistant", text: "Two files." },
              { role: "user", text: `${prompt}\n\nAdditional user context:\nAlso the tests.` },
            ]);
          },
          response: { type: "text", text: "Two files changed, tests included." },
        },
      ],
    });
    cleanups.push(() => server.close());
    let claims = 0;

    await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          prompt,
          history,
          tools: [],
          sourceMessageId: "entry-2",
          claimSteering: async () =>
            claims++ === 0
              ? [{ id: "steering-1", messageId: "entry-3", text: "Also the tests." }]
              : [],
        }),
      ),
    );

    server.assertComplete();
  });

  it("returns tool failure to the model and continues without claiming a successful write", async () => {
    let calls = 0;
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "denied-write",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            expect(latestToolResult(request)).toMatchObject({ tool_call_id: "denied-write" });
            expect(String(latestToolResult(request)?.content)).toContain("Fixture write denied");
          },
          response: { type: "text", text: "The file could not be saved." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          executeTool: async () => {
            calls++;
            throw new Error("Fixture write denied");
          },
        }),
      ),
    );
    server.assertComplete();
    expect(calls).toBe(1);
    expect(events.at(-1)).toEqual({ type: "done", text: "The file could not be saved." });
  });

  const publishCall = { id: "publish", name: "publish_note", arguments: { title: "Plan" } };
  const writeCall = {
    id: "write",
    name: "write_file",
    arguments: { path: "notes.txt", content: "hello" },
  };

  it.each([
    ["before", publishCall, writeCall, ["publish_note"]],
    ["after", writeCall, publishCall, ["write_file", "publish_note"]],
  ])(
    "stops a tool batch at an approval pause with a local write %s it, without another inference",
    async (_order, first, sibling, expected) => {
      const calls: string[] = [];
      const server = await startModelEmulator({
        steps: [{ expect() {}, response: { type: "tool", ...first, siblings: [sibling] } }],
      });
      cleanups.push(() => server.close());
      const events = await collect(
        new PiAgentRuntime().run(
          runRequest(server.model, {
            tools: [writeTool, publishTool],
            executeTool: pausingPublish(calls),
          }),
        ),
      );
      server.assertComplete();
      expect(server.requests).toHaveLength(1);
      expect(calls).toEqual(expected);
      expect(events.at(-1)).toEqual({ type: "done" });
    },
  );

  it("ends a helper at its approval pause, and its parent with it", async () => {
    const calls: string[] = [];
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "helper",
            name: "run_subagent",
            arguments: { name: "helper", task: "Save and publish the plan." },
          },
        },
        {
          expect() {},
          response: { type: "tool", ...writeCall, siblings: [publishCall] },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          tools: [writeTool, publishTool, subagentTool],
          executeTool: pausingPublish(calls),
        }),
      ),
    );
    server.assertComplete();
    expect(server.requests).toHaveLength(2);
    expect(calls).toEqual(["write_file", "publish_note"]);
    expect(events.filter((event) => event.type === "subagent").at(-1)).toMatchObject({
      status: "completed",
      result: "Waiting for approval.",
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  const helperCall = (index: number, task: string) => ({
    id: `helper-${index}`,
    name: "run_subagent",
    arguments: { name: `helper-${index}`, task },
  });
  const helperReplies = (
    count: number,
    reply: (task: string) => ModelEmulatorResponse,
  ): ModelEmulatorStep[] =>
    Array.from({ length: count }, () => ({
      expect() {},
      response: (request) => reply(JSON.stringify(request.messages.at(-1)?.content)),
    }));
  const helperOutcomes = (events: AgentRuntimeEvent[]) =>
    Object.fromEntries(
      events.flatMap((event) =>
        event.type === "subagent" && event.status !== "running"
          ? [[event.agentId, `${event.status}: ${event.result}`]]
          : [],
      ),
    );
  const stoppedHelper = "completed: Stopped: the run is waiting for the user.";

  it("stops running and queued helpers without inference once one helper pauses", async () => {
    const calls: string[] = [];
    let holding = 0;
    let siblingsHeld = () => {};
    const held = new Promise<void>((resolve) => {
      siblingsHeld = resolve;
    });
    const [first, ...siblings] = [
      helperCall(1, "Publish the plan."),
      helperCall(2, "Wait."),
      helperCall(3, "Wait."),
      helperCall(4, "Wait."),
      helperCall(5, "Save the notes."),
    ];
    const server = await startModelEmulator({
      steps: [
        { expect() {}, response: { type: "tool", ...first!, siblings } },
        ...helperReplies(4, (task) => {
          if (task.includes("Publish")) return { type: "tool", ...publishCall };
          if (task.includes("Wait")) {
            return {
              type: "hold",
              onOpen: () => {
                holding += 1;
                if (holding === 3) siblingsHeld();
              },
            };
          }
          return { type: "tool", ...writeCall };
        }),
      ],
    });
    cleanups.push(() => server.close());
    const publish = pausingPublish(calls)!;
    const executeTool: AgentRunRequest["executeTool"] = async (name, args, executionId) => {
      if (name === "publish_note") await held;
      return publish(name, args, executionId);
    };
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          tools: [writeTool, publishTool, subagentTool],
          executeTool,
          startSubagent: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              executeTool,
              text: async () => {},
              finish: async () => {},
              abandon: async () => {},
            };
          },
        }),
      ),
    );
    server.assertComplete();
    expect(calls).toEqual(["publish_note"]);
    expect(helperOutcomes(events)).toEqual({
      "helper-1": "completed: Waiting for approval.",
      "helper-2": stoppedHelper,
      "helper-3": stoppedHelper,
      "helper-4": stoppedHelper,
      "helper-5": stoppedHelper,
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("stops a sibling helper's later calls and inference at another helper's pause", async () => {
    const calls: string[] = [];
    let writing = () => {};
    const writeStarted = new Promise<void>((resolve) => {
      writing = resolve;
    });
    let pause = () => {};
    const paused = new Promise<void>((resolve) => {
      pause = resolve;
    });
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            ...helperCall(1, "Publish the plan."),
            siblings: [helperCall(2, "Save the notes.")],
          },
        },
        ...helperReplies(2, (task) =>
          task.includes("Publish")
            ? { type: "tool", ...publishCall }
            : { type: "tool", ...writeCall, siblings: [{ ...writeCall, id: "write-again" }] },
        ),
      ],
    });
    cleanups.push(() => server.close());
    const publish = pausingPublish(calls)!;
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          tools: [writeTool, publishTool, subagentTool],
          executeTool: async (name, args, executionId) => {
            if (name === "publish_note") await writeStarted;
            else {
              writing();
              await paused;
            }
            return publish(name, args, executionId);
          },
          onToolCompleted: (completion) => {
            if (completion.paused) pause();
          },
        }),
      ),
    );
    server.assertComplete();
    expect(calls.sort()).toEqual(["publish_note", "write_file"]);
    expect(helperOutcomes(events)).toEqual({
      "helper-1": "completed: Waiting for approval.",
      "helper-2": stoppedHelper,
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("propagates a provider rejection without dispatching tools or emitting done", async () => {
    let calls = 0;
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: { type: "error", status: 400, message: "Fixture request rejected" },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events: AgentRuntimeEvent[] = [];
    await expect(
      collect(
        new PiAgentRuntime().run(
          runRequest(server.model, {
            executeTool: async () => {
              calls++;
              return {};
            },
          }),
        ),
        events,
      ),
    ).rejects.toThrow(/Fixture request rejected/);
    server.assertComplete();
    expect(calls).toBe(0);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("rejects an interrupted SSE response without emitting successful completion", async () => {
    const server = await startModelEmulator({
      steps: [{ expect() {}, response: { type: "disconnect", text: "Working" } }],
    });
    cleanups.push(() => server.close());
    const events: AgentRuntimeEvent[] = [];
    await expect(
      collect(new PiAgentRuntime().run(runRequest(server.model)), events),
    ).rejects.toThrow();
    server.assertComplete();
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("cancels a quiet HTTP stream and closes the provider connection", async () => {
    const opened = deferred();
    const closed = deferred();
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "hold",
            onOpen: opened.resolve,
            onClose: closed.resolve,
          },
        },
      ],
    });
    cleanups.push(() => server.close());
    const controller = new AbortController();
    const events: AgentRuntimeEvent[] = [];
    const work = collect(
      new PiAgentRuntime().run(runRequest(server.model), { signal: controller.signal }),
      events,
    );
    // Attach the rejection handler before aborting to avoid an unhandled rejection.
    const outcome = work.then(
      () => undefined,
      (error: unknown) => error,
    );
    await opened.promise;
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    await closed.promise;
    server.assertComplete();
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("keeps two model connections and their responses isolated", async () => {
    const first = await startModelEmulator({
      modelId: "fixture-first",
      apiKey: "first-fixture-key",
      steps: [{ expect() {}, response: { type: "text", text: "First connection" } }],
    });
    const second = await startModelEmulator({
      modelId: "fixture-second",
      apiKey: "second-fixture-key",
      steps: [{ expect() {}, response: { type: "text", text: "Second connection" } }],
    });
    cleanups.push(
      () => first.close(),
      () => second.close(),
    );
    const runtime = new PiAgentRuntime();
    const results = await Promise.all(
      [first, second].map((server) => collect(runtime.run(runRequest(server.model)))),
    );
    expect(results.map((events) => events.at(-1))).toEqual([
      { type: "done", text: "First connection" },
      { type: "done", text: "Second connection" },
    ]);
    first.assertComplete();
    second.assertComplete();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
