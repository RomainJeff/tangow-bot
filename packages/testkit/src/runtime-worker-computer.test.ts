import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ConnectorProvider } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import type { Seen } from "./worker-channel-tap.js";
import { tapConnector } from "./worker-channel-tap.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const recap = JSON.stringify({ version: 1, results: ["Answered"], references: [] });
const finish: ModelEmulatorStep[] = [
  {
    expect() {},
    response: { type: "tool", id: "say", name: "message_user", arguments: { message: "Done." } },
  },
  { expect() {}, response: { type: "text", text: recap } },
];
const lookup: ConnectorProvider = {
  describe: () => ({
    id: "fixture",
    contractVersion: "1",
    adapterVersion: "1",
    capabilities: { discover: true, oauth: false, secretsBrokered: true },
  }),
  discoverTools: async () => [
    {
      name: "mcp_lookup",
      description: "Lookup",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    },
  ],
  async *execute() {
    yield { type: "result", data: { found: "it" } };
  },
};
const toolResults = (request: ModelEmulatorRequest) =>
  Object.fromEntries(
    request.messages
      .filter((message) => message.role === "tool")
      .map((message) => [message.tool_call_id, message.content]),
  );

/** A worker run of a bot on a team computer, with a vision model so it may observe the screen. */
async function teamBotRun(steps: ModelEmulatorStep[]) {
  const run = await startWorkerRun({
    steps,
    computerScope: "team",
    protocol: "anthropic",
    tools: lookup,
  });
  cleanups.push(() => run.close());
  const provisions = vi.spyOn(run.sandbox, "provision");
  const computer = async () =>
    (
      await run.prisma.computer.findUniqueOrThrow({
        where: { id: run.bot.computerId! },
        select: { state: true },
      })
    ).state;
  const leases = async () =>
    (
      await run.prisma.computerExecutionLease.findMany({ select: { runId: true, expiresAt: true } })
    ).map((lease) => ({ runId: lease.runId, held: lease.expiresAt > new Date() }));
  const toolEntries = async (runId: string) =>
    (
      await run.prisma.sessionEntry.findMany({
        where: { runId, type: { in: ["tool.call", "tool.result"] } },
        orderBy: { seq: "asc" },
        select: { type: true, payload: true },
      })
    ).map((entry) => ({ type: entry.type, callId: (entry.payload as { callId: string }).callId }));
  return {
    run,
    provisions,
    computer,
    leases,
    toolEntries,
    async start() {
      const runId = await run.send("Hello.");
      await run.continueRun(runId);
      run.model.assertComplete();
      return runId;
    },
  };
}

describe("a worker run's computer", () => {
  it("stays asleep, with no lease taken, through a run that only calls an MCP tool", async () => {
    const bot = await teamBotRun([
      {
        expect() {},
        response: { type: "tool", id: "mcp", name: "mcp_lookup", arguments: {} },
      },
      ...finish,
    ]);
    const runId = await bot.start();

    expect((await bot.run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "completed",
    );
    expect(bot.run.provider.launches).toHaveLength(1);
    expect(await bot.computer()).toBe("stopped");
    expect(await bot.leases()).toEqual([]);
  });

  it("starts at the first computer call, holds the lease through the run and lets it go at the end", async () => {
    const seen: Array<{ computer: string; leases: unknown }> = [];
    const bot = await teamBotRun([
      {
        async expect() {
          seen.push({ computer: await bot.computer(), leases: await bot.leases() });
        },
        response: { type: "tool", id: "look", name: "computer_observe", arguments: {} },
      },
      {
        async expect() {
          seen.push({ computer: await bot.computer(), leases: await bot.leases() });
        },
        response: finish[0]!.response,
      },
      finish[1]!,
    ]);
    const runId = await bot.start();

    expect(seen).toEqual([
      { computer: "stopped", leases: [] },
      { computer: "running", leases: [{ runId, held: true }] },
    ]);
    expect(bot.provisions).toHaveBeenCalledTimes(1);
    expect(await bot.leases()).toEqual([{ runId, held: false }]);
  });

  it("answers a computer call with a busy error at once while another run of the bot holds it and starts it", async () => {
    let result: unknown;
    const bot = await teamBotRun([
      {
        expect() {},
        response: {
          type: "tool",
          id: "act",
          name: "computer_act",
          arguments: { actions: [{ kind: "wait", ms: 1 }] },
        },
      },
      {
        expect(request) {
          result = toolResults(request).act;
        },
        response: finish[0]!.response,
      },
      finish[1]!,
    ]);
    const held = new Date(Date.now() + 60_000);
    await bot.run.prisma.computerExecutionLease.create({
      data: {
        computerId: bot.run.bot.computerId!,
        botId: bot.run.bot.id,
        runId: "other-run",
        fence: 1,
        expiresAt: held,
      },
    });
    await bot.run.prisma.computer.update({
      where: { id: bot.run.bot.computerId! },
      data: { state: "booting" },
    });
    const runId = await bot.start();

    expect(JSON.parse(String(result))).toEqual({
      error:
        "The computer is busy with another run or starting up. Continue without it or try again later.",
    });
    expect((await bot.run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "completed",
    );
    expect(await bot.computer()).toBe("booting");
    expect(await bot.leases()).toEqual([{ runId: "other-run", held: true }]);
    expect(
      await bot.run.prisma.externalEffect.findMany({
        where: { runId, kind: "computer_act" },
        select: { status: true },
      }),
    ).toEqual([{ status: "intended" }]);
  });

  it("waits out a start someone else began and then answers the call", async () => {
    let result: unknown;
    const bot = await teamBotRun([
      {
        expect() {},
        response: { type: "tool", id: "look", name: "computer_observe", arguments: {} },
      },
      {
        expect(request) {
          result = toolResults(request).look;
        },
        response: finish[0]!.response,
      },
      finish[1]!,
    ]);
    const provision = Object.getPrototypeOf(bot.run.sandbox).provision.bind(bot.run.sandbox);
    bot.provisions.mockImplementationOnce(async (request, context) => {
      // The person's start is still booting when the bot's call reaches the computer.
      while ((await bot.run.prisma.sessionEntry.count({ where: { type: "tool.call" } })) < 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      return provision(request, context);
    });
    const opening = bot.run.startComputer();
    const runId = await bot.start();
    await opening;

    expect(String(result)).toMatch(/^computer observed/);
    expect(await bot.leases()).toEqual([{ runId, held: false }]);
  });

  it("answers a failed start with an error and starts on the next call", async () => {
    let results: Record<string, unknown> = {};
    const bot = await teamBotRun([
      {
        expect() {},
        response: { type: "tool", id: "first", name: "computer_observe", arguments: {} },
      },
      {
        expect() {},
        response: { type: "tool", id: "second", name: "computer_observe", arguments: {} },
      },
      {
        expect(request) {
          results = toolResults(request);
        },
        response: finish[0]!.response,
      },
      finish[1]!,
    ]);
    bot.provisions.mockRejectedValueOnce(new Error("The provider is down"));
    const runId = await bot.start();

    expect(results).toEqual({
      first: JSON.stringify({
        error: "The computer could not start. Continue without it or try again later.",
      }),
      second: expect.stringMatching(/^computer observed/),
    });
    expect(await bot.leases()).toEqual([{ runId, held: false }]);
  });

  it.each([
    ["in a worker", "volumes"],
    ["in process", "snapshot"],
  ])(
    "starts the computer for a takeover %s and holds it for the person, with no tool result logged",
    async (_where, homeStorage) => {
      const bot = await teamBotRun([
        {
          expect() {},
          response: {
            type: "tool",
            id: "hand",
            name: "request_takeover",
            arguments: { reason: "Log in" },
          },
        },
      ]);
      await bot.run.prisma.computer.update({
        where: { id: bot.run.bot.computerId! },
        data: { homeStorage },
      });
      const runId = await bot.start();

      expect((await bot.run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
        "waiting_takeover",
      );
      expect(await bot.computer()).toBe("running");
      expect(await bot.leases()).toEqual([{ runId, held: true }]);
      expect(await bot.toolEntries(runId)).toEqual([]);
    },
  );

  it("answers a takeover with a busy error while another run of the bot holds the computer", async () => {
    let result: unknown;
    const bot = await teamBotRun([
      {
        expect() {},
        response: {
          type: "tool",
          id: "hand",
          name: "request_takeover",
          arguments: { reason: "Log in" },
        },
      },
      {
        expect(request) {
          result = toolResults(request).hand;
        },
        response: finish[0]!.response,
      },
      finish[1]!,
    ]);
    await bot.run.prisma.computerExecutionLease.create({
      data: {
        computerId: bot.run.bot.computerId!,
        botId: bot.run.bot.id,
        runId: "other-run",
        fence: 1,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const runId = await bot.start();

    expect(JSON.parse(String(result))).toEqual({
      error:
        "The computer is busy with another run or starting up. Continue without it or try again later.",
    });
    expect((await bot.run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "completed",
    );
    expect((await bot.toolEntries(runId)).filter((entry) => entry.callId === "hand")).toEqual([
      { type: "tool.call", callId: "hand" },
      { type: "tool.result", callId: "hand" },
    ]);
  });

  it("lets the lease a takeover held go when the resumed run fails before it starts", async () => {
    const bot = await teamBotRun([]);
    const runId = await bot.run.send("Hello.");
    await bot.run.prisma.run.update({ where: { id: runId }, data: { checkpoint: "takeover" } });
    await bot.run.prisma.computerExecutionLease.create({
      data: {
        computerId: bot.run.bot.computerId!,
        botId: bot.run.bot.id,
        runId,
        fence: 1,
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });
    await bot.run.prisma.attempt.createMany({
      data: [101, 102, 103].map((fence) => ({ runId, fence, status: "setting_up" })),
    });
    await bot.run.continueRun(runId);

    expect((await bot.run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "failed",
    );
    expect(await bot.leases()).toEqual([{ runId, held: false }]);
  });
});

describe("a worker run's screens by path", () => {
  it("saves the screen on the bot's volume, never through a link the guest made, and keeps the image off the run channel", async () => {
    const seen: Seen[] = [];
    const results: Record<string, unknown> = {};
    const read = { type: "tool" as const, id: "see", name: "read", arguments: { path: "" } };
    // Stands for another bot's folder that the guest links from its own volume.
    const elsewhere = await mkdtemp(path.join(tmpdir(), "rakazo-other-bot-"));
    cleanups.push(() => rm(elsewhere, { recursive: true, force: true }));
    const run = await startWorkerRun({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "link",
            name: "bash",
            arguments: {
              command: `mkdir -p .rakazo && ln -s ${elsewhere} .rakazo/screens && ln -s ${elsewhere} screens`,
            },
          },
        },
        {
          expect() {},
          response: { type: "tool", id: "look", name: "computer_observe", arguments: {} },
        },
        {
          expect(request) {
            results.look = toolResults(request).look;
            read.arguments.path = /Screen saved at (\S+)\. /.exec(String(results.look))?.[1] ?? "";
          },
          response: read,
        },
        {
          expect(request) {
            results.see = toolResults(request).see;
          },
          response: finish[0]!.response,
        },
        finish[1]!,
      ],
      computerScope: "team",
      protocol: "anthropic",
      screensByPath: true,
      connector: (provider) => tapConnector(provider, seen, []),
    });
    cleanups.push(() => run.close());
    const runId = await run.send("Hello.");
    await run.continueRun(runId);
    run.model.assertComplete();

    expect(await readdir(elsewhere)).toEqual([]);
    const screen = "\\.rakazo-screen-[\\w-]{36}\\.png";
    expect(String(results.look)).toMatch(
      new RegExp(
        `^computer observed\\n\\{"frameId":"[^"]+",.*"width":\\d+,"height":\\d+.*"path":"${screen}"\\}\\nScreen saved at ${screen}\\. Read it to see it\\.$`,
      ),
    );
    expect(String(results.see)).toContain("image/png");
    const fromController = seen
      .filter(({ from }) => from === "controller")
      .map(({ frame }) => Buffer.from(frame).toString());
    expect(fromController.some((frame) => frame.includes("Screen saved at"))).toBe(true);
    expect(fromController.filter((frame) => frame.includes('"type":"image"'))).toEqual([]);
  });
});
