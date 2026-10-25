import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ConnectorProvider,
  ConnectorTool,
  MemoryStore,
  SemanticMemoryProvider,
} from "@rakazo/adapter-kit";
import { createWorkerAgentRuntime, memoryChannelPair } from "@rakazo/adapters/runtime-worker";
import { HARNESSES, runGuest } from "@rakazo/agent-run-worker";
import { describe, expect, it, onTestFinished } from "vitest";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const text = (request: ModelEmulatorRequest) => JSON.stringify(request.messages);
const tail = (request: ModelEmulatorRequest) => JSON.stringify(request.messages.at(-1));
const prefix = (request: ModelEmulatorRequest) =>
  JSON.stringify({ system: request.messages[0], tools: request.tools });
/** Wrapped in the characters the prompt escapes, so its escaped form must be masked too. */
const SECRET = "<fake-secret>&";

describe("prompt bytes at the provider boundary", () => {
  it("keeps the prefix and retained history stable while replacing scoped volatile context", async () => {
    let memory = `DURABLE_FIRST ${SECRET}`;
    let recalled = `RECALL_FIRST ${SECRET}`;
    // Connector tools arrive in another order each run; they are declared sorted.
    let lookups = ["z_lookup", "a_lookup"];
    const tools: ConnectorProvider = {
      describe: () => ({
        id: "records",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { discover: true, oauth: false, secretsBrokered: true },
      }),
      discoverTools: async () =>
        lookups.map(
          (name): ConnectorTool => ({
            name,
            description: "Look up a record.",
            inputSchema: { type: "object", properties: {} },
            route: { connectorId: "records", resourceId: "records-server", toolName: name },
          }),
        ),
      execute() {
        throw new Error("Unexpected call");
      },
    };
    const store: MemoryStore = {
      describe: () => ({
        id: "fixture",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { search: false, revisions: false, markdownPortable: false },
      }),
      read: async ({ scope }) => ({
        documents:
          scope === "bot"
            ? [{ path: "facts.md", content: memory, revision: 1, updatedAt: "" }]
            : [],
      }),
      search: async () => [],
      commit: async () => {
        throw new Error("Unexpected write");
      },
      async *exportMarkdown() {},
      importMarkdown: async () => {
        throw new Error("Unexpected import");
      },
    };
    const semantic: SemanticMemoryProvider = {
      describe: () => ({
        id: "fixture",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { recall: true, save: true, purgeHistory: true, sharedScope: true },
      }),
      recall: async () => ({ ok: true, value: [{ memory: recalled, score: 1 }] }),
      save: async () => ({ ok: true, value: undefined }),
      purgeHistory: async () => ({ ok: true, value: undefined }),
    };
    // A VM's absolute mount paths remain the same across attempts. The local volume fixture
    // otherwise embeds a different host directory in Pi's cwd and skill catalog each time.
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-prefix-guest-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "workspace/bots/bot"), { recursive: true });
    let launches = 0;
    const harness = HARNESSES["pi-native"]!;
    const workerRuntime = createWorkerAgentRuntime({
      launcher: {
        async launch(worker, capability) {
          launches++;
          const pair = memoryChannelPair();
          const exit = runGuest({
            channels: (async function* () {
              yield pair.guest;
            })(),
            capability,
            harness,
            root,
            home: path.join(root, "home/user"),
          });
          return {
            expectedHarness: harness.declaration,
            start: {
              version: 2,
              kind: "worker.start",
              worker,
              computer: "none",
              workspace: {
                cwd: "/workspace/bots/bot",
                mounts: [{ path: "/workspace/bots/bot", scope: "private", access: "rw" }],
              },
            },
            connections: (async function* () {
              yield pair.controller;
            })(),
            exited: exit.then(() => undefined),
            holdsFence: async () => true,
            ownsFence: async () => true,
            release: async () => "released",
          };
        },
      },
      stops: { mark: async () => undefined },
    });
    const finishing: ModelEmulatorStep[] = [
      {
        expect() {},
        response: {
          type: "tool",
          id: "say",
          name: "message_user",
          arguments: { message: "Done." },
        },
      },
      {
        expect() {},
        response: {
          type: "text",
          text: JSON.stringify({ version: 1, results: ["Done"], references: [] }),
        },
      },
    ];
    const run = await startWorkerRun({
      steps: [...finishing, ...finishing, ...finishing],
      memory: store,
      memoryProviders: {
        resolve: async () => ({ provider: semantic, defaultScope: "isolated" }),
      },
      tools,
      secrets: [SECRET],
      workers: (workers) => ({ ...workers, runtime: () => workerRuntime }),
    });
    onTestFinished(() => run.close());
    const item = await run.prisma.scratchpadItem.create({
      data: {
        spaceId: run.spaceId,
        botId: run.bot.id,
        userId: run.userId,
        title: `WORK_FIRST ${SECRET}`,
      },
    });
    const firstRun = await run.send("Plan the launch.");
    await run.continueRun(firstRun);
    memory = `DURABLE_SECOND ${SECRET}`;
    recalled = `RECALL_SECOND ${SECRET}`;
    lookups = lookups.toReversed();
    await run.prisma.scratchpadItem.update({
      where: { id: item.id },
      data: { title: `WORK_SECOND ${SECRET}` },
    });
    const secondRun = await run.send("And the deadline?");
    await run.continueRun(secondRun);
    const otherBot = await run.prisma.bot.create({
      data: {
        spaceId: run.spaceId,
        userId: run.userId,
        name: "Other",
        color: "#000000",
        modelProvider: run.bot.modelProvider,
        modelId: run.bot.modelId,
      },
    });
    // A different bot and thread must not inherit previously rendered context.
    const otherThread = await run.prisma.thread.create({
      data: {
        spaceId: run.spaceId,
        userId: run.userId,
        botId: otherBot.id,
      },
    });
    memory = "DURABLE_OTHER";
    recalled = "RECALL_OTHER";
    const sent = await run.events.sendUserMessage({
      spaceId: run.spaceId,
      userId: run.userId,
      botId: otherBot.id,
      threadId: otherThread.id,
      blocks: [{ kind: "text", text: "A separate task." }],
      prompt: "A separate task.",
      trigger: "user",
    });
    await run.continueRun(sent.runId!);
    run.model.assertComplete();
    const first = run.model.requests[0];
    const second = run.model.requests[finishing.length];
    const other = run.model.requests[finishing.length * 2];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(other).toBeDefined();
    expect(prefix(second!)).toBe(prefix(first!));
    expect(second!.messages.slice(1, 3)).toEqual([
      { role: "user", content: "Plan the launch." },
      expect.objectContaining({ role: "assistant" }),
    ]);
    for (const [request, values] of [
      [first!, ["DURABLE_FIRST", "RECALL_FIRST", "WORK_FIRST"]],
      [second!, ["DURABLE_SECOND", "RECALL_SECOND", "WORK_SECOND"]],
    ] as const) {
      for (const value of values) {
        expect(text(request).split(value)).toHaveLength(2);
        expect(tail(request)).toContain(value);
        expect(prefix(request)).not.toContain(value);
      }
      expect(tail(request)).toContain("[redacted]");
      expect(text(request)).not.toContain("<fake-secret>");
      expect(text(request)).not.toContain("&lt;fake-secret&gt;");
    }
    expect(first!.tools?.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining(["mcp__rakazo__a_lookup", "mcp__rakazo__z_lookup"]),
    );
    for (const stale of ["DURABLE_FIRST", "RECALL_FIRST", "WORK_FIRST"]) {
      expect(text(second!)).not.toContain(stale);
      expect(text(other!)).not.toContain(stale);
    }
    expect(text(other!)).not.toContain("WORK_SECOND");
    expect(text(other!)).not.toContain("Plan the launch.");
    expect(text(other!)).not.toContain("And the deadline?");
    expect(tail(other!)).toContain("DURABLE_OTHER");
    expect(tail(other!)).toContain("RECALL_OTHER");
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: secondRun } })).status).toBe(
      "completed",
    );
    expect(launches).toBe(3);
  });
});
