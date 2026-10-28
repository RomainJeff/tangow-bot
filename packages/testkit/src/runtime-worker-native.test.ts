import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  AgentSteeringMessage,
  SubagentLog,
  WorkerIdentity,
} from "@rakazo/adapter-kit";
import type { LaunchedGuest, WorkerClock } from "@rakazo/adapters/runtime-worker";
import {
  createWorkerAgentRuntime,
  memoryChannelPair,
  WORKER_NATIVE_TOOLS,
} from "@rakazo/adapters/runtime-worker";
import { HARNESSES, runGuest } from "@rakazo/agent-run-worker";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "rakazo-native-home-"));
  vi.stubEnv("HOME", home);
  onTestFinished(() => rm(home, { recursive: true, force: true }));
});
afterEach(() => vi.unstubAllEnvs());

const stillClock: WorkerClock = { sleep: () => new Promise<void>(() => {}) };

type TranscriptEvent = Extract<AgentRuntimeEvent, { type: "transcript" }>;

const transcriptOf = (events: readonly AgentRuntimeEvent[]): TranscriptEvent => ({
  type: "transcript",
  entries: events.flatMap((event) => (event.type === "transcript" ? event.entries : [])),
  unverifiedCalls: events.reduce(
    (sum, event) => sum + (event.type === "transcript" ? event.unverifiedCalls : 0),
    0,
  ),
});

const systemOf = (request: ModelEmulatorRequest) =>
  String(request.messages.find((message) => message.role === "system")?.content);

/** Pi native in a real guest, behind the real controller session, against the model emulator. */
async function nativeRun(
  steps: ModelEmulatorStep[],
  overrides: Partial<AgentRunRequest> = {},
  modelPatch: Partial<AgentRunRequest["model"]> = {},
  signal?: AbortSignal,
  fixtureRoot?: string,
) {
  const server = await startModelEmulator({ steps, apiKey: "controller-only-key" });
  onTestFinished(() => server.close());
  const root = fixtureRoot ?? (await mkdtemp(path.join(tmpdir(), "rakazo-native-run-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "workspace/bots/bot"), { recursive: true });
  const exits: Array<Promise<string>> = [];
  const runtime = createWorkerAgentRuntime({
    launcher: {
      async launch(worker: WorkerIdentity, capability: string): Promise<LaunchedGuest> {
        const pair = memoryChannelPair();
        const exit = runGuest({
          channels: (async function* () {
            yield pair.guest;
          })(),
          capability,
          harness: HARNESSES["pi-native"]!,
          root,
          home: path.join(root, "home/user"),
        });
        exits.push(exit);
        return {
          expectedHarness: HARNESSES["pi-native"]!.declaration,
          start: {
            version: 2,
            kind: "worker.start",
            worker,
            workspace: {
              cwd: "/workspace/bots/bot",
              mounts: [{ path: "/workspace/bots/bot", scope: "private", access: "rw" }],
            },
            computer: "none",
          },
          connections: (async function* () {
            yield pair.controller;
          })(),
          exited: exit.then(() => undefined),
          release: async () => "released",
          holdsFence: async () => true,
          ownsFence: async () => true,
        };
      },
    },
    stops: { mark: async () => undefined },
    clock: stillClock,
  });
  const seen: AgentRuntimeEvent[] = [];
  try {
    for await (const event of runtime.run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "run_native",
        prompt: "Draft a note.",
        instructions: "Instructions for Rakazo's own loop, never sent to a native harness.",
        harnessAddendum: "You are Ada, the user's bot.",
        history: [],
        tools: WORKER_NATIVE_TOOLS.filter((tool) => ["read", "bash"].includes(tool.name)),
        model: { ...server.model, ...modelPatch },
        attempt: { id: "run_native-attempt", fence: 1 },
        ...overrides,
      },
      signal
        ? {
            operationId: "native-test",
            traceId: "native-test",
            spaceId: "space",
            userId: "user",
            signal,
          }
        : undefined,
    )) {
      seen.push(event);
    }
  } finally {
    server.assertComplete();
  }
  return { seen, exit: await exits[0], root, requests: server.requests, launches: exits.length };
}

describe("the pi-native harness through the controller", () => {
  it.each([
    { status: "success", suffix: "", isError: false },
    { status: "failure", suffix: "; exit 7", isError: true },
    { status: "timeout", suffix: "; sleep 30", isError: true },
  ])(
    "keeps literal bash output after $status for a later native read",
    async ({ status, suffix, isError }) => {
      const expected = Array.from({ length: 900_000 }, (_, i) => `${i + 1}\n`).join("");
      let shown = "";
      const first = await nativeRun([
        {
          expect() {},
          response: {
            type: "tool",
            id: "long",
            name: "bash",
            arguments: {
              command: `ln -s /tmp .rakazo; seq 1 900000${suffix}`,
              ...(status === "timeout" ? { timeout: 0.2 } : {}),
            },
          },
        },
        {
          expect(request) {
            shown = String(
              request.messages.findLast((message) => message.role === "tool")?.content,
            );
            expect(shown.length).toBeLessThanOrEqual(12_000);
          },
          response: { type: "text", text: "Saved." },
        },
      ]);
      expect(first.exit).toBe("done");
      expect(
        transcriptOf(first.seen).entries.find((entry) => entry.kind === "result"),
      ).toMatchObject({ callId: "long", isError });
      if (status === "failure") expect(shown).toContain("Command exited with code 7");
      if (status === "timeout") expect(shown).toContain("Command timed out after 0.2 seconds");
      const outputPath = /it is in ([^\]\n]+)/.exec(shown)?.[1];
      expect(outputPath).toBeTruthy();
      expect(path.dirname(outputPath!)).toBe(path.join(first.root, "workspace/bots/bot"));
      expect(await readFile(outputPath!, "utf8")).toBe(expected);
      await rm(path.join(first.root, "spool"), { recursive: true, force: true });
      await rm(path.join(first.root, "home"), { recursive: true, force: true });
      const next = await nativeRun([
        {
          expect() {},
          response: {
            type: "tool",
            id: "read",
            name: "read",
            arguments: { path: outputPath!, offset: 899_999, limit: 2 },
          },
        },
        {
          expect(request) {
            expect(
              String(request.messages.findLast((message) => message.role === "tool")?.content),
            ).toContain("899999\n900000");
          },
          response: { type: "text", text: "Read." },
        },
      ]);
      expect(next.exit).toBe("done");
    },
  );

  it("retains the complete stream when native bash is cancelled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-native-cancel-"));
    const volume = path.join(root, "workspace/bots/bot");
    const cancel = new AbortController();
    const pending = nativeRun(
      [
        {
          expect() {},
          response: {
            type: "tool",
            id: "cancel",
            name: "bash",
            arguments: { command: "seq 1 900000; touch ready; sleep 30" },
          },
        },
      ],
      {},
      {},
      cancel.signal,
      root,
    );
    const rejected = expect(pending).rejects.toThrow("cancelled");
    const expected = Array.from({ length: 900_000 }, (_, i) => `${i + 1}\n`).join("");
    await expect
      .poll(async () => {
        const files = await readdir(volume).catch(() => []);
        const spool = files.find((file) => file.startsWith(".rakazo-bash-"));
        return spool ? (await readFile(path.join(volume, spool))).byteLength : 0;
      })
      .toBe(Buffer.byteLength(expected));
    cancel.abort();
    await rejected;
    const spool = (await readdir(volume)).find((file) => file.startsWith(".rakazo-bash-"));
    expect(await readFile(path.join(volume, spool!), "utf8")).toBe(expected);
  });

  it("keeps concurrent native helpers' retained output separate on the same mount", async () => {
    let arrivals = 0;
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paths: string[] = [];
    const child: ModelEmulatorStep = {
      async expect() {
        if (++arrivals === 2) release();
        await ready;
      },
      response(request) {
        const peer = JSON.stringify(request.messages).includes("peer-task");
        return {
          type: "tool",
          id: peer ? "peer-bash" : "slow-bash",
          name: "bash",
          arguments: { command: peer ? "seq 4001 8000" : "seq 1 4000" },
        };
      },
    };
    const finishChild: ModelEmulatorStep = {
      expect(request) {
        const text = String(
          request.messages.findLast((message) => message.role === "tool")?.content,
        );
        const file = /it is in ([^\]\n]+)/.exec(text)?.[1];
        expect(file).toBeTruthy();
        paths.push(file!);
      },
      response: { type: "text", text: "Child saved." },
    };
    const result = await nativeRun(
      [
        {
          expect() {},
          response: {
            type: "tool",
            id: "one",
            name: "mcp__rakazo__run_subagent",
            arguments: { name: "slow", task: "slow-task" },
            siblings: [
              {
                id: "two",
                name: "mcp__rakazo__run_subagent",
                arguments: { name: "peer", task: "peer-task" },
              },
            ],
          },
        },
        child,
        child,
        finishChild,
        finishChild,
        { expect() {}, response: { type: "text", text: "Done." } },
      ],
      {
        tools: [
          "run_subagent",
          ...WORKER_NATIVE_TOOLS.filter((tool) => ["bash", "read"].includes(tool.name)),
        ].map((tool) =>
          typeof tool === "string"
            ? { name: tool, description: tool, inputSchema: { type: "object", properties: {} } }
            : tool,
        ),
        startSubagent: async () => ({
          executeTool: async () => "unused",
          finish: async () => {},
          abandon: async () => {},
          transcript: async () => {},
        }),
      },
    );
    expect(result.exit).toBe("done");
    expect(new Set(paths).size).toBe(2);
    expect(
      paths.every((file) => path.dirname(file) === path.join(result.root, "workspace/bots/bot")),
    ).toBe(true);
    const outputs = await Promise.all(paths.map((file) => readFile(file, "utf8")));
    expect(outputs.sort()).toEqual([
      Array.from({ length: 4000 }, (_, i) => `${i + 1}\n`).join(""),
      Array.from({ length: 4000 }, (_, i) => `${i + 4001}\n`).join(""),
    ]);
  });

  it("does not retain output files for ordinary native bash text", async () => {
    const result = await nativeRun([
      {
        expect() {},
        response: {
          type: "tool",
          id: "short",
          name: "bash",
          arguments: { command: "printf 'hello\\n'" },
        },
      },
      {
        expect(request) {
          expect(request.messages.findLast((message) => message.role === "tool")?.content).toBe(
            "hello\n",
          );
        },
        response: { type: "text", text: "Done." },
      },
    ]);
    expect(await readdir(path.join(result.root, "workspace/bots/bot"))).toEqual([]);
  });

  it("keeps Pi's prompt with the Rakazo addendum, and runs its file tools on the volume without a grant", async () => {
    const { seen, exit, root } = await nativeRun([
      {
        expect(request) {
          const system = systemOf(request);
          expect(system.indexOf("operating inside pi")).toBeGreaterThanOrEqual(0);
          expect(system.indexOf("<addendum>\nYou are Ada, the user's bot.")).toBeGreaterThan(
            system.indexOf("operating inside pi"),
          );
          expect(system).not.toContain("never sent to a native harness");
          expect((request.tools ?? []).map((tool) => tool.function.name).sort()).toEqual([
            "bash",
            "read",
          ]);
        },
        response: {
          type: "tool",
          id: "b1",
          name: "bash",
          arguments: { command: "echo drafted > note.txt && echo ok" },
        },
      },
      {
        expect(request) {
          expect(request.messages.at(-1)).toMatchObject({ role: "tool", content: "ok\n" });
        },
        response: { type: "text", text: "Drafted." },
      },
    ]);

    expect(exit).toBe("done");
    expect(await readFile(path.join(root, "workspace/bots/bot/note.txt"), "utf8")).toBe(
      "drafted\n",
    );
    expect(seen.filter((event) => event.type === "progress")).toEqual([
      {
        type: "progress",
        text: "Working the terminal",
        activity: true,
      },
    ]);
    expect(transcriptOf(seen)).toEqual({
      type: "transcript",
      entries: [
        {
          kind: "call",
          turn: 0,
          callId: "b1",
          name: "bash",
          args: { command: "echo drafted > note.txt && echo ok" },
        },
        { kind: "result", callId: "b1", output: "ok\n", isError: false },
        { kind: "text", turn: 1, text: "Drafted." },
      ],
      unverifiedCalls: 0,
    });
    expect(seen.at(-1)).toEqual({ type: "done", text: "Drafted." });
  });

  it("discovers a deferred connector with Pi tool_search and invokes it through the real MCP adapter", async () => {
    const executeTool = vi.fn(
      async (_name: string, _args: Record<string, unknown>) => "published-on-controller",
    );
    const schema = { type: "object", properties: { title: { type: "string" } } };
    const { seen } = await nativeRun(
      [
        {
          expect(request) {
            const names = request.tools?.map((tool) => tool.function.name) ?? [];
            expect(names).toContain("tool_search");
            expect(names).not.toContain("mcp__rakazo__publish_note");
          },
          response: {
            type: "tool",
            id: "search",
            name: "tool_search",
            arguments: { query: "publish_note", limit: 1 },
          },
        },
        {
          expect(request) {
            expect(request.tools?.map((tool) => tool.function.name)).toContain(
              "mcp__rakazo__publish_note",
            );
          },
          response: {
            type: "tool",
            id: "publish",
            name: "mcp__rakazo__publish_note",
            arguments: { title: "Plan" },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("published-on-controller");
          },
          response: { type: "text", text: "Done." },
        },
      ],
      {
        tools: [
          {
            name: "mcp_execute_tool",
            description: "Execute a connector tool",
            inputSchema: schema,
            route: { connectorId: "notes", toolName: "__catalog_execute" },
            catalog: Array.from({ length: 30 }, (_, index) => ({
              id: `notes:${index}`,
              tool: {
                name: index === 29 ? "publish_note" : `lookup_${index}`,
                description: index === 29 ? "Publish a note" : "Lookup",
                inputSchema: schema,
              },
            })),
          },
        ],
        executeTool,
      },
    );
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0]?.[0]).toBe("mcp_execute_tool");
    expect(executeTool.mock.calls[0]?.[1]).toEqual({
      id: "notes:29",
      arguments: { title: "Plan" },
    });
    expect(transcriptOf(seen)).toMatchObject({
      unverifiedCalls: 0,
      entries: expect.arrayContaining([{ kind: "controller", turn: 1, name: "mcp_execute_tool" }]),
    });
  });

  it.each([
    ...(
      [
        ["short", "publish_note", "lookup_note"],
        ["long", `publish_${"note_".repeat(16)}`, "lookup_note"],
        ["collision", "notes.write", "notes_write"],
        ["reverse collision", "notes_write", "notes.write"],
      ] as const
    ).flatMap(([label, name, other]) => [
      { label, name, other, deferred: true, reverseCatalog: false },
      { label, name, other, deferred: false, reverseCatalog: false },
    ]),
    ...[false, true].flatMap((reverseCatalog) =>
      ["mcp__rakazo__remember", "remember"].map((name) => ({
        label: `canonical alias overlap ${name}, reversed=${reverseCatalog}`,
        name,
        other: name === "remember" ? "mcp__rakazo__remember" : "remember",
        deferred: false,
        reverseCatalog,
      })),
    ),
  ])(
    "preserves controller identity and replay for $label MCP names, deferred=$deferred",
    async ({ name, other, deferred, reverseCatalog }) => {
      const executeTool = vi.fn(async () => "published-on-controller");
      let assigned = "";
      const schema = { type: "object", properties: { title: { type: "string" } } };
      const tools: AgentRunRequest["tools"] = deferred
        ? [
            {
              name: "mcp_execute_tool",
              description: "Execute a connector tool",
              inputSchema: schema,
              route: { connectorId: "notes", toolName: "__catalog_execute" },
              catalog: [name, other, ...Array.from({ length: 28 }, (_, i) => `lookup_${i}`)].map(
                (tool, i) => ({
                  id: i === 0 ? "notes:target" : `notes:${i}`,
                  tool: { name: tool, description: tool, inputSchema: schema },
                }),
              ),
            },
          ]
        : [name, other].map((tool) => ({
            name: tool,
            description: tool,
            inputSchema: schema,
            route: { connectorId: "notes", toolName: tool },
          }));
      if (reverseCatalog) tools.reverse();
      const canonicalName = deferred ? "mcp_execute_tool" : name;
      const args = (title: string) =>
        deferred ? { id: "notes:target", arguments: { title } } : { title };
      const { seen } = await nativeRun(
        [
          ...(deferred
            ? [
                {
                  expect(request: ModelEmulatorRequest) {
                    expect(
                      request.tools?.some((tool) => tool.function.name === "tool_search"),
                    ).toBe(true);
                  },
                  response: {
                    type: "tool" as const,
                    id: "search",
                    name: "tool_search",
                    arguments: { query: name, limit: 10 },
                  },
                },
              ]
            : []),
          {
            expect(request) {
              const loaded = request.tools?.map((tool) => tool.function.name) ?? [];
              assigned =
                loaded.find((tool) =>
                  ["remember", "mcp__rakazo__remember"].includes(name)
                    ? tool === `mcp__rakazo__${name}`
                    : tool.startsWith("mcp__rakazo__"),
                ) ?? "";
              expect(assigned).toBeTruthy();
            },
            response: () => ({
              type: "tool",
              id: "publish",
              name: assigned,
              arguments: { title: "Plan" },
            }),
          },
          { expect() {}, response: { type: "text", text: "Done." } },
        ],
        {
          tools,
          executeTool,
        },
      );
      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(executeTool.mock.calls[0]?.slice(0, 2)).toEqual([canonicalName, args("Plan")]);
      const announced = seen.find((event) => event.type === "tool" && event.name === canonicalName);
      expect(announced).toMatchObject({ type: "tool", args: args("Plan") });
      const transcript = transcriptOf(seen);
      expect(transcript.unverifiedCalls).toBe(0);
      expect(transcript.entries.filter((entry) => entry.kind === "controller")).toEqual([
        { kind: "controller", turn: deferred ? 1 : 0, name: canonicalName },
      ]);
      await nativeRun(
        [
          {
            expect(request) {
              const replay = request.messages.flatMap((message) => message.tool_calls ?? []);
              expect(replay).toEqual([
                {
                  id: "prior",
                  type: "function",
                  function: {
                    name: assigned,
                    arguments: JSON.stringify({ title: "Earlier" }),
                  },
                },
              ]);
              expect(
                request.messages.find((message) => message.tool_call_id === "prior"),
              ).toMatchObject({
                role: "tool",
                content: "previous-result",
              });
            },
            response: { type: "text", text: "Already done." },
          },
        ],
        {
          tools,
          executeTool,
          history: [
            { role: "user", content: "Publish earlier." },
            {
              role: "assistant",
              content: "",
              parts: [
                {
                  type: "toolCalls",
                  calls: [
                    {
                      id: "prior",
                      name: canonicalName,
                      args: args("Earlier"),
                      output: "previous-result",
                    },
                  ],
                },
              ],
            },
          ],
        },
      );
      expect(executeTool).toHaveBeenCalledTimes(1);
    },
  );

  describe("a new attempt of a run that loaded deferred tools", () => {
    const schema = { type: "object", properties: { title: { type: "string" } } };
    const names = ["called_note", "searched_note", "untouched_note"];
    const tools: AgentRunRequest["tools"] = [
      {
        name: "mcp_execute_tool",
        description: "Execute a connector tool",
        inputSchema: schema,
        route: { connectorId: "notes", toolName: "__catalog_execute" },
        catalog: [...names, ...Array.from({ length: 27 }, (_, i) => `lookup_${i}`)].map(
          (name, i) => ({
            id: `notes:${i}`,
            tool: { name, description: name, inputSchema: schema },
          }),
        ),
      },
    ];
    const declared = (request: ModelEmulatorRequest) =>
      (request.tools ?? []).map((tool) => tool.function.name);
    // The run's own turn alone, as the oldest kept turn that the projection renders as prose.
    const earlier = (calls: { id: string; name: string; args: object; output: string }[]) => [
      {
        role: "assistant" as const,
        content: "",
        parts: [{ type: "toolCalls" as const, calls }],
      },
    ];

    it("declares the catalog tool its history called, from the first request", async () => {
      const executeTool = vi.fn(async () => "published-on-controller");
      await nativeRun(
        [
          {
            expect(request) {
              expect(declared(request)).toContain("mcp__rakazo__called_note");
              expect(declared(request)).not.toContain("mcp__rakazo__untouched_note");
              expect(declared(request)).not.toContain("mcp__rakazo__searched_note");
            },
            response: {
              type: "tool",
              id: "again",
              name: "mcp__rakazo__called_note",
              arguments: { title: "Plan" },
            },
          },
          { expect() {}, response: { type: "text", text: "Done." } },
        ],
        {
          tools,
          executeTool,
          history: earlier([
            {
              id: "prior",
              name: "mcp_execute_tool",
              args: { id: "notes:0", arguments: { title: "Earlier" } },
              output: "previous-result",
            },
          ]),
        },
      );
      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(executeTool.mock.calls[0]?.slice(0, 2)).toEqual([
        "mcp_execute_tool",
        { id: "notes:0", arguments: { title: "Plan" } },
      ]);
    });

    it.each([
      { label: "an exact name", query: "searched_note" },
      { label: "pi's own search", query: "searched" },
    ])("declares a tool its history only loaded through $label", async ({ query }) => {
      let result = "";
      await nativeRun(
        [
          {
            expect() {},
            response: {
              type: "tool",
              id: "search",
              name: "tool_search",
              arguments: { query, limit: 1 },
            },
          },
          {
            expect(request) {
              result = String(request.messages.find((m) => m.tool_call_id === "search")?.content);
            },
            response: { type: "text", text: "Found it." },
          },
        ],
        { tools },
      );
      expect(result).toContain("Loaded 1 tool");
      await nativeRun(
        [
          {
            expect(request) {
              expect(declared(request)).toContain("mcp__rakazo__searched_note");
              expect(declared(request)).not.toContain("mcp__rakazo__called_note");
              expect(declared(request)).not.toContain("mcp__rakazo__untouched_note");
            },
            response: { type: "text", text: "Done." },
          },
        ],
        {
          tools,
          history: earlier([{ id: "prior", name: "tool_search", args: { query }, output: result }]),
        },
      );
    });
  });

  it.each(["completed", "unsaved", "paused"] as const)(
    "runs a real native helper in its own session and settles its parent: %s",
    async (outcome) => {
      const transcripts: Parameters<NonNullable<SubagentLog["transcript"]>>[0][] = [];
      const finished: Parameters<SubagentLog["finish"]>[0][] = [];
      const abandoned: string[] = [];
      const childText: string[] = [];
      const helperTool = vi.fn(async () =>
        outcome === "paused"
          ? {
              kind: "agent_tool_result",
              content: [{ type: "text", text: "Waiting for approval." }],
              details: { approval: "paused" },
              terminate: true,
            }
          : "child-only-result",
      );
      const executeTool = vi.fn(async () => "wrong-parent-handler");
      const startSubagent = vi.fn<NonNullable<AgentRunRequest["startSubagent"]>>(async () => ({
        executeTool: helperTool,
        text: async (text) => {
          childText.push(text);
        },
        transcript: async (event) => {
          transcripts.push(event);
        },
        finish: async (result) => {
          if (outcome === "unsaved") throw new Error("history unavailable");
          finished.push(result);
        },
        abandon: async (result) => {
          abandoned.push(result);
        },
      }));
      const tool = (name: string) => ({
        name,
        description: name,
        inputSchema: { type: "object", properties: {} },
      });
      const { seen, exit, launches } = await nativeRun(
        [
          {
            expect(request) {
              expect(JSON.stringify(request.messages)).toContain("parent-private-context");
              expect(request.tools?.map((tool) => tool.function.name)).toContain(
                "mcp__rakazo__run_subagent",
              );
            },
            response: {
              type: "tool",
              id: "delegate",
              name: "mcp__rakazo__run_subagent",
              arguments: { name: "scout", task: "Find the child note." },
            },
          },
          {
            expect(request) {
              const context = JSON.stringify(request.messages);
              expect(context).toContain("Find the child note.");
              expect(context).not.toContain("parent-private-context");
              expect(context).not.toContain("Draft a note.");
              expect(systemOf(request)).toContain('named "scout"');
              expect(request.tools?.map((tool) => tool.function.name)).toEqual([
                "mcp__rakazo__remember",
              ]);
            },
            response: { type: "tool", id: "save", name: "mcp__rakazo__remember", arguments: {} },
          },
          ...(outcome === "paused"
            ? []
            : [
                {
                  expect(request: ModelEmulatorRequest) {
                    expect(JSON.stringify(request.messages)).toContain("child-only-result");
                  },
                  response: { type: "text" as const, text: "Found the child note." },
                },
              ]),
          {
            expect(request) {
              const context = JSON.stringify(request.messages);
              expect(context).toContain(
                outcome === "completed"
                  ? "Found the child note."
                  : outcome === "unsaved"
                    ? "Subagent failed: history unavailable"
                    : "Stopped: the run is waiting for the user.",
              );
              expect(context).not.toContain("child-only-result");
              expect(context).not.toContain('"name":"mcp__rakazo__remember"');
            },
            response: { type: "text", text: "Parent finished." },
          },
        ],
        {
          tools: [tool("run_subagent"), tool("remember"), tool("message_user")],
          history: [{ role: "user", content: "parent-private-context" }],
          executeTool,
          startSubagent,
        },
      );
      expect(launches).toBe(1);
      expect(exit).toBe(outcome === "paused" ? "paused" : "done");
      expect(startSubagent).toHaveBeenCalledTimes(1);
      expect(helperTool).toHaveBeenCalledTimes(1);
      expect(executeTool).not.toHaveBeenCalled();
      expect(transcriptOf(transcripts)).toMatchObject({
        unverifiedCalls: 0,
        entries: expect.arrayContaining([{ kind: "controller", turn: 0, name: "remember" }]),
      });
      expect(
        seen
          .filter((event) => event.type === "text")
          .map((event) => event.text)
          .join(""),
      ).not.toContain("Found the child note.");
      expect(transcriptOf(seen)).toMatchObject({
        unverifiedCalls: 0,
        entries: expect.arrayContaining([{ kind: "controller", turn: 0, name: "run_subagent" }]),
      });
      if (outcome === "unsaved") expect(abandoned).toEqual(["history unavailable"]);
      else
        expect(finished).toEqual([
          expect.objectContaining({
            status: "completed",
            result:
              outcome === "paused"
                ? "Stopped: the run is waiting for the user."
                : "Found the child note.",
            usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
          }),
        ]);
      if (outcome === "completed") expect(childText.join("")).toBe("Found the child note.");
    },
  );

  it.each(["completed", "paused", "cancelled"] as const)(
    "keeps concurrent native helpers separate on %s",
    async (mode) => {
      const paused = mode === "paused";
      const cancelled = mode === "cancelled";
      const cancel = new AbortController();
      let held = 0;
      let closed = 0;
      let opened = () => {};
      const slowOpened = new Promise<void>((resolve) => {
        opened = resolve;
      });
      let slowClosed = false;
      const logs = new Map<
        string,
        {
          text: string;
          transcripts: Parameters<NonNullable<SubagentLog["transcript"]>>[0][];
          finished: Parameters<SubagentLog["finish"]>[0][];
        }
      >();
      const startSubagent: NonNullable<AgentRunRequest["startSubagent"]> = async (call) => {
        const log = {
          text: "",
          transcripts: [] as Parameters<NonNullable<SubagentLog["transcript"]>>[0][],
          finished: [] as Parameters<SubagentLog["finish"]>[0][],
        };
        logs.set(call.name, log);
        return {
          executeTool: async () => ({
            kind: "agent_tool_result",
            content: [{ type: "text", text: "Waiting." }],
            details: { approval: "paused" },
            terminate: true,
          }),
          text: async (text) => {
            log.text += text;
          },
          transcript: async (event) => {
            log.transcripts.push(event);
          },
          finish: async (outcome) => {
            log.finished.push(outcome);
          },
          abandon: async () => {},
        };
      };
      const childStep: ModelEmulatorStep = {
        async expect(request) {
          const text = JSON.stringify(request.messages);
          expect(text.includes("slow-task") !== text.includes("peer-task")).toBe(true);
          if (paused && text.includes("peer-task")) await slowOpened;
        },
        response(request) {
          const slow = JSON.stringify(request.messages).includes("slow-task");
          if (cancelled)
            return {
              type: "hold",
              onOpen: () => {
                held += 1;
                if (held === 2) setImmediate(() => cancel.abort());
              },
              onClose: () => {
                closed += 1;
              },
            };
          if (!paused) return { type: "text", text: slow ? "slow-result" : "peer-result" };
          return slow
            ? {
                type: "hold",
                onOpen: opened,
                onClose: () => {
                  slowClosed = true;
                },
              }
            : { type: "tool", id: "pause", name: "mcp__rakazo__remember", arguments: {} };
        },
      };
      const pending = nativeRun(
        [
          {
            expect() {},
            response: {
              type: "tool",
              id: "slow",
              name: "mcp__rakazo__run_subagent",
              arguments: { name: "slow", task: "slow-task" },
              siblings: [
                {
                  id: "peer",
                  name: "mcp__rakazo__run_subagent",
                  arguments: { name: "peer", task: "peer-task" },
                },
              ],
            },
          },
          childStep,
          childStep,
          ...(cancelled
            ? []
            : [
                {
                  expect(request) {
                    const text = JSON.stringify(request.messages);
                    expect(text).toContain(
                      paused ? "Stopped: the run is waiting for the user." : "slow-result",
                    );
                    if (!paused) expect(text).toContain("peer-result");
                  },
                  response: { type: "text", text: "Parent closed." },
                } satisfies ModelEmulatorStep,
              ]),
        ],
        {
          tools: ["run_subagent", "remember"].map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object", properties: {} },
          })),
          startSubagent,
        },
        {},
        cancel.signal,
      );
      if (cancelled) {
        await expect(pending).rejects.toThrow("The run was cancelled");
        await expect.poll(() => closed).toBe(2);
        expect([...logs.keys()].sort()).toEqual(["peer", "slow"]);
        for (const log of logs.values()) {
          expect(log.text).toBe("");
          expect(log.finished).toEqual([
            expect.objectContaining({ status: "failed", result: "The worker stopped" }),
          ]);
        }
        return;
      }
      const { exit, launches, seen } = await pending;
      expect(launches).toBe(1);
      expect(exit).toBe(paused ? "paused" : "done");
      expect([...logs.keys()].sort()).toEqual(["peer", "slow"]);
      for (const log of logs.values()) {
        expect(transcriptOf(log.transcripts).unverifiedCalls).toBe(0);
        expect(log.finished).toHaveLength(1);
      }
      if (paused) {
        await expect.poll(() => slowClosed).toBe(true);
        expect(
          transcriptOf(logs.get("slow")?.transcripts ?? [])
            .entries.flatMap((entry) => (entry.kind === "text" ? [entry.text] : []))
            .join(""),
        ).toBe("");
      } else {
        expect(logs.get("slow")?.text).toBe("slow-result");
        expect(logs.get("peer")?.text).toBe("peer-result");
      }
      expect(
        seen
          .filter((event) => event.type === "text")
          .map((event) => event.text)
          .join(""),
      ).toBe(paused ? "" : "Parent closed.");
    },
  );

  it("compacts with Pi's own compaction, whose summary request goes through the relay", async () => {
    const isSummary = (request: ModelEmulatorRequest) => systemOf(request).includes("summar");
    const kinds: string[] = [];
    const step: ModelEmulatorStep = {
      expect: (request) => void kinds.push(isSummary(request) ? "summary" : "turn"),
      response: (request) =>
        isSummary(request)
          ? { type: "text", text: "## Goal\nKeep the notes.\n## Progress\n- [x] Read them" }
          : { type: "text", text: "Done." },
    };
    const history: AgentRunRequest["history"] = [];
    for (let turn = 0; turn < 20; turn += 1) {
      history.push({ role: "user", content: `Note ${turn}: ${"x".repeat(8_000)}` });
      history.push({ role: "assistant", content: `Kept note ${turn}.` });
    }

    const { exit, requests, seen } = await nativeRun(
      [step, step],
      { history },
      { contextWindow: 48_000 },
    );

    expect(exit).toBe("done");
    expect(kinds).toEqual(["summary", "turn"]);
    expect(transcriptOf(seen)).toMatchObject({
      type: "transcript",
      entries: [
        {
          kind: "summary",
          turn: 0,
          summary: "## Goal\nKeep the notes.\n## Progress\n- [x] Read them",
          tokensBefore: expect.any(Number),
        },
        { kind: "text", turn: 0, text: "Done." },
      ],
      unverifiedCalls: 0,
    });
    const turn = JSON.stringify(requests.at(-1)?.messages);
    expect(turn).toContain("Keep the notes.");
    expect(turn).not.toContain("Note 0:");
  });

  it("hands a message sent during the attempt to the model between two turns", async () => {
    const steering: AgentSteeringMessage = {
      id: "steer_1",
      messageId: "message_1",
      text: "Also give it a title.",
    };
    const claimSteering = async (seenIds: string[]) =>
      seenIds.includes(steering.id) ? [] : [steering];
    const { exit } = await nativeRun(
      [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).not.toContain(steering.text);
          },
          response: { type: "tool", id: "b1", name: "bash", arguments: { command: "echo ok" } },
        },
        {
          expect(request) {
            expect(request.messages.slice(-2)).toMatchObject([
              { role: "tool", content: "ok\n" },
              { role: "user", content: [{ type: "text", text: steering.text }] },
            ]);
          },
          response: { type: "tool", id: "b2", name: "bash", arguments: { command: "echo title" } },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages).split(steering.text)).toHaveLength(2);
          },
          response: { type: "text", text: "Titled." },
        },
      ],
      { claimSteering },
    );

    expect(exit).toBe("done");
  });
});
