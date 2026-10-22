import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  AgentSteeringMessage,
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

const systemOf = (request: ModelEmulatorRequest) =>
  String(request.messages.find((message) => message.role === "system")?.content);

/** Pi native in a real guest, behind the real controller session, against the model emulator. */
async function nativeRun(
  steps: ModelEmulatorStep[],
  overrides: Partial<AgentRunRequest> = {},
  modelPatch: Partial<AgentRunRequest["model"]> = {},
) {
  const server = await startModelEmulator({ steps, apiKey: "controller-only-key" });
  onTestFinished(() => server.close());
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-native-run-"));
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
          spoolDir: path.join(root, "spool"),
          root,
          home: path.join(root, "home/user"),
        });
        exits.push(exit);
        return {
          expectedHarness: HARNESSES["pi-native"]!.declaration,
          start: {
            version: 1,
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
    for await (const event of runtime.run({
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
    })) {
      seen.push(event);
    }
  } finally {
    server.assertComplete();
  }
  return { seen, exit: await exits[0], root, requests: server.requests };
}

describe("the pi-native harness through the controller", () => {
  it("keeps Pi's prompt with the Rakazo addendum, and runs its file tools on the volume without a grant", async () => {
    const executeLocalTool = vi.fn();
    const { seen, exit, root } = await nativeRun(
      [
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
      ],
      { executeLocalTool },
    );

    expect(exit).toBe("done");
    expect(await readFile(path.join(root, "workspace/bots/bot/note.txt"), "utf8")).toBe(
      "drafted\n",
    );
    expect(executeLocalTool).not.toHaveBeenCalled();
    expect(seen.filter((event) => event.type === "progress")).toEqual([
      {
        type: "progress",
        text: 'bash {"command":"echo drafted > note.txt && echo ok"}',
        activity: true,
      },
    ]);
    expect(seen.find((event) => event.type === "transcript")).toEqual({
      type: "transcript",
      entries: [
        {
          kind: "call",
          turn: 0,
          callId: "b1",
          name: "bash",
          args: { command: "echo drafted > note.txt && echo ok" },
          output: "ok\n",
          isError: false,
        },
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
    expect(seen.find((event) => event.type === "transcript")).toMatchObject({
      unverifiedCalls: 0,
      entries: expect.arrayContaining([
        { kind: "controller", turn: 1, callId: expect.any(String), name: "mcp_execute_tool" },
      ]),
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
      const transcript = seen.find((event) => event.type === "transcript");
      expect(transcript?.unverifiedCalls).toBe(0);
      expect(transcript?.entries.filter((entry) => entry.kind === "controller")).toEqual([
        {
          kind: "controller",
          turn: deferred ? 1 : 0,
          callId: announced?.type === "tool" ? announced.executionId : undefined,
          name: canonicalName,
        },
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
    expect(seen.find((event) => event.type === "transcript")).toMatchObject({
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
