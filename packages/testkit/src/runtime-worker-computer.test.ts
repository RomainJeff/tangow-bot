import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

/** A worker run of a bot, on a team computer by default, with a vision model that sees the screen. */
async function botRun(
  steps: ModelEmulatorStep[],
  computerScope: "team" | "dedicated" | "none" = "team",
) {
  const run = await startWorkerRun({
    steps,
    computerScope,
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
    const bot = await botRun([
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
    const bot = await botRun([
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
    const bot = await botRun([
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
    const bot = await botRun([
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
    const bot = await botRun([
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
      const bot = await botRun([
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
    const bot = await botRun([
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
    const bot = await botRun([]);
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

describe("computer_exec", () => {
  const terminals = (request: ModelEmulatorRequest) =>
    (request.tools ?? [])
      .map((tool) => tool.function.name)
      .filter((name) => ["bash", "shell", "computer_exec"].includes(name))
      .sort();

  it.each([
    ["a worker run with a computer", "team", "volumes", ["bash", "computer_exec"]],
    ["a run in process", "team", "snapshot", ["shell"]],
    ["a run without a computer", "none", null, []],
  ] as const)("is offered to %s", async (_run, scope, homeStorage, offered) => {
    let tools: string[] = [];
    const bot = await botRun(
      [
        {
          expect(request) {
            tools = terminals(request);
          },
          response: finish[0]!.response,
        },
        finish[1]!,
      ],
      scope,
    );
    if (homeStorage) {
      await bot.run.prisma.computer.update({
        where: { id: bot.run.bot.computerId! },
        data: { homeStorage },
      });
    }
    await bot.start();

    expect(tools).toEqual(offered);
  });

  it.each([
    ["team", true],
    ["dedicated", false],
  ] as const)(
    "runs on the %s computer, from the bot's home, and starts it at that call",
    async (scope, leased) => {
      const worker = createServer((_request, response) => response.end("served by the worker"));
      await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise((resolve) => worker.close(() => resolve())));
      const command = `curl -s http://localhost:${(worker.address() as AddressInfo).port}`;
      const seen: Array<{ computer: string; leases: unknown }> = [];
      let results: Record<string, unknown> = {};
      const bot = await botRun(
        [
          {
            expect() {},
            response: { type: "tool", id: "here", name: "bash", arguments: { command } },
          },
          {
            async expect() {
              seen.push({ computer: await bot.computer(), leases: await bot.leases() });
            },
            response: { type: "tool", id: "there", name: "computer_exec", arguments: { command } },
          },
          {
            async expect(request) {
              seen.push({ computer: await bot.computer(), leases: await bot.leases() });
              results = toolResults(request);
            },
            response: finish[0]!.response,
          },
          finish[1]!,
        ],
        scope,
      );
      const runId = await bot.start();

      expect(results.here).toBe("served by the worker");
      expect(JSON.parse(String(results.there))).toEqual({
        code: 0,
        stdout: `computer ran ${command} in /workspace/bots/${bot.run.bot.id}\n`,
        stderr: "",
      });
      expect(seen).toEqual([
        { computer: "stopped", leases: [] },
        { computer: "running", leases: leased ? [{ runId, held: true }] : [] },
      ]);
    },
  );

  it("cuts an output too long for the worker channel, and the run goes on", async () => {
    let shown = "";
    const bot = await botRun([
      {
        expect() {},
        response: {
          type: "tool",
          id: "long",
          name: "computer_exec",
          arguments: { command: "dump" },
        },
      },
      {
        expect(request) {
          shown = String(toolResults(request).long);
        },
        response: finish[0]!.response,
      },
      finish[1]!,
    ]);
    vi.spyOn(bot.run.sandbox, "execute").mockImplementation(async function* () {
      yield { type: "stdout", data: "\u0001".repeat(1536 * 1024) };
      yield { type: "stderr", data: "done\n" };
      yield { type: "exit", code: 0 };
    });
    const runId = await bot.start();

    const effect = await bot.run.prisma.externalEffect.findFirstOrThrow({
      where: { runId, kind: "computer_exec" },
      select: { result: true },
    });
    expect(effect.result).toEqual({
      code: 0,
      stdout: `${"\u0001".repeat(65536)}\n\n[output cut at 65536 of 1572864 bytes]`,
      stderr: "done\n",
    });
    expect(shown.startsWith(`{"stdout":"${"\\u0001".repeat(100)}`)).toBe(true);
  });

  it("refuses a command that could stop the desktop, as shell does", async () => {
    let result: unknown;
    const bot = await botRun([
      {
        expect() {},
        response: {
          type: "tool",
          id: "kill",
          name: "computer_exec",
          arguments: { command: "pkill chromium" },
        },
      },
      {
        expect(request) {
          result = toolResults(request).kill;
        },
        response: finish[0]!.response,
      },
      finish[1]!,
    ]);
    await bot.start();

    expect(JSON.parse(String(result))).toEqual({
      error:
        "This command was not run: the desktop-protection guard detected a protected command or shell syntax it cannot inspect. Shell access is still available. For ordinary repository work, use direct commands with explicit paths, without sourcing or command substitution. Do not stop or restart browser/desktop processes.",
    });
  });
});

it("hands a screenshot to the guest's model as an image", async () => {
  const bot = await botRun([
    {
      expect() {},
      response: { type: "tool", id: "look", name: "computer_observe", arguments: {} },
    },
    ...finish,
  ]);
  await bot.start();

  const sent = bot.run.model.rawRequests[1] as {
    messages: Array<{
      content: string | Array<{ type: string; tool_use_id?: string; content?: unknown }>;
    }>;
  };
  const screenshot = sent.messages
    .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
    .find((block) => block.tool_use_id === "look");
  expect(screenshot?.content).toEqual([
    { type: "text", text: expect.stringMatching(/^computer observed/) },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: expect.stringMatching(/^iVBORw0KGgo/),
      },
    },
  ]);
});
