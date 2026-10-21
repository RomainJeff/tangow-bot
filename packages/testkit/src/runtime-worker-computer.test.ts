import type { ConnectorProvider } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
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
  return {
    run,
    provisions,
    computer,
    leases,
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

  it("starts once for two computer calls racing in one batch", async () => {
    let results: Record<string, unknown> = {};
    const bot = await teamBotRun([
      {
        expect() {},
        response: {
          type: "tool",
          id: "first",
          name: "computer_observe",
          arguments: {},
          also: [{ id: "second", name: "computer_observe", arguments: {} }],
        },
      },
      {
        expect(request) {
          results = toolResults(request);
        },
        response: finish[0]!.response,
      },
      finish[1]!,
    ]);
    const provision = Object.getPrototypeOf(bot.run.sandbox).provision.bind(bot.run.sandbox);
    bot.provisions.mockImplementationOnce(async (request, context) => {
      // Hold the first start until the second call has been made and reached the computer.
      while ((await bot.run.prisma.sessionEntry.count({ where: { type: "tool.call" } })) < 2) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      return provision(request, context);
    });
    const runId = await bot.start();

    const observed = expect.stringMatching(/^computer observed/);
    expect(results).toEqual({ first: observed, second: observed });
    expect(bot.provisions).toHaveBeenCalledTimes(1);
    expect(await bot.leases()).toEqual([{ runId, held: false }]);
  });

  it("answers a computer call with a busy error while another run of the bot holds it, and finishes", async () => {
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
    const runId = await bot.start();

    expect(JSON.parse(String(result))).toEqual({
      error:
        "The computer is busy with another run or starting up. Continue without it or try again later.",
    });
    expect((await bot.run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "completed",
    );
    expect(await bot.computer()).toBe("stopped");
    expect(await bot.leases()).toEqual([{ runId: "other-run", held: true }]);
  });
});
