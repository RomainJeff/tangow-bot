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
  server.assertComplete();
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
