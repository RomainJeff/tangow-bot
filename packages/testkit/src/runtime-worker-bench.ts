import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import type { AgentRunRequest, AgentRuntime, LocalToolOutput } from "@rakazo/adapter-kit";
import { createWorkerLifecycle } from "@rakazo/adapters";
import {
  createLifecycleLauncher,
  createStopJournal,
  createWorkerAgentRuntime,
  GUEST_TOOLS,
  WORKER_LIMITS,
} from "@rakazo/adapters/runtime-worker";
import { LocalWorkerProvider } from "./local-worker-provider.js";
import type { ModelEmulatorStep } from "./model-emulator.js";
import {
  parse,
  quantiles,
  queryLog,
  type Seen,
  settled,
  tapConnector,
} from "./worker-channel-tap.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const { values } = parseArgs({
  options: {
    trials: { type: "string", default: "30" },
    warmup: { type: "string", default: "3" },
    tools: { type: "string", default: "5" },
    "stop-trials": { type: "string", default: "30" },
    out: { type: "string" },
  },
});
const trials = Number(values.trials);
const warmup = Number(values.warmup);
const toolsPerRun = Number(values.tools);
const stopTrials = Number(values["stop-trials"]);
for (const [name, value] of Object.entries({ trials, warmup, toolsPerRun, stopTrials })) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be an integer >= 0`);
}
if (!values.out) throw new Error("--out <receipt.json> is required");

const CONTROL_BUDGET_P95_MS = 200;
const recap = JSON.stringify({ version: 1, results: ["Ran the commands"], references: [] });

type Arm = "in_process" | "memory" | "child";
type ToolSample = { authorizeMs: number; ackMs: number; queries: number; queryMs: number };
type Window = { authorize: [number, number]; ack: [number, number] };

function workerSteps(runs: number): ModelEmulatorStep[] {
  return Array.from({ length: runs }, () => [
    ...Array.from(
      { length: toolsPerRun },
      (_, index): ModelEmulatorStep => ({
        expect() {},
        response: {
          type: "tool",
          id: `sh-${index}`,
          name: "bash",
          arguments: { command: `echo ${index}` },
        },
      }),
    ),
    {
      expect() {},
      response: {
        type: "tool",
        id: "say",
        name: "message_user",
        arguments: { message: "Done." },
      },
    } satisfies ModelEmulatorStep,
    { expect() {}, response: { type: "text", text: recap } } satisfies ModelEmulatorStep,
  ]).flat();
}

/**
 * The same journaling without a channel: a runtime in the controller's process that announces
 * each tool and runs it through `executeLocalTool`, as the session does for a guest.
 */
function inProcessRuntime(samples: Window[]) {
  const runtime: AgentRuntime = {
    describe: () => ({
      id: "in-process-bench",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: {
        streaming: true,
        compaction: false,
        tools: true,
        scripted: false,
        localTools: GUEST_TOOLS,
      },
    }),
    abort: async () => {},
    async *run(request) {
      for (let index = 0; index < toolsPerRun; index++) {
        const args = { command: `echo ${index}` };
        const executionId = `sh-${index}`;
        yield { type: "tool", name: "bash", args, executionId };
        const called = performance.now();
        let ran: [number, number] = [0, 0];
        await request.executeLocalTool!("bash", args, executionId, async () => {
          const started = performance.now();
          const output: LocalToolOutput = {
            text: `${index}\n`,
            isError: false,
            truncated: false,
            totalBytes: 2,
          };
          ran = [started, performance.now()];
          return output;
        });
        samples.push({ authorize: [called, ran[0]], ack: [ran[1], performance.now()] });
      }
      yield { type: "done", text: recap };
    },
  };
  return runtime;
}

async function controlArm(arm: Arm, runs: number) {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-worker-bench-"));
  const log = queryLog();
  const seen: Seen[] = [];
  const connects: number[] = [];
  const inProcess: Window[] = [];
  let provider: LocalWorkerProvider | undefined;
  const fixture = await startWorkerRun({
    steps: arm === "in_process" ? [] : workerSteps(runs),
    prisma: log.wrap,
    runtime: (prisma) => {
      if (arm === "in_process") return inProcessRuntime(inProcess);
      provider = new LocalWorkerProvider({ mode: arm, root: path.join(dir, "workers") });
      return createWorkerAgentRuntime({
        launcher: createLifecycleLauncher({
          prisma,
          lifecycle: createWorkerLifecycle({ prisma, provider }),
          connector: tapConnector(provider, seen, connects),
        }),
        stops: createStopJournal(prisma),
      });
    },
  });

  async function trial() {
    seen.length = 0;
    connects.length = 0;
    inProcess.length = 0;
    const runId = await fixture.send("Run the commands.");
    const started = performance.now();
    await fixture.continueRun(runId);
    const runMs = performance.now() - started;
    const run = await fixture.prisma.run.findUniqueOrThrow({
      where: { id: runId },
      select: { status: true },
    });
    const effects = await fixture.prisma.externalEffect.findMany({
      where: { runId, kind: "bash" },
      select: { status: true },
    });
    const ok =
      run.status === "completed" &&
      effects.length === toolsPerRun &&
      effects.every((effect) => effect.status === "completed");

    const windows: Window[] =
      arm === "in_process"
        ? inProcess
        : (() => {
            const frames = parse(seen);
            const grants = settled(frames, "tool.call", "tool.grant");
            const records = settled(frames, "tool.done", "tool.recorded");
            assert.equal(grants.length, toolsPerRun, "every guest tool was granted");
            assert.equal(records.length, toolsPerRun, "every guest result was recorded");
            return grants.map((grant, index) => ({
              authorize: [grant.from, grant.to],
              ack: [records[index]!.from, records[index]!.to],
            }));
          })();
    const tools: ToolSample[] = windows.map(({ authorize, ack }) => {
      const before = log.within(authorize[0], authorize[1]);
      const after = log.within(ack[0], ack[1]);
      return {
        authorizeMs: authorize[1] - authorize[0],
        ackMs: ack[1] - ack[0],
        queries: before.count + after.count,
        queryMs: before.ms + after.ms,
      };
    });
    const boot =
      arm === "in_process"
        ? undefined
        : (() => {
            const frames = parse(seen);
            const hello = frames.find((frame) => frame.kind === "worker.hello");
            const start = frames.find((frame) => frame.kind === "worker.start");
            assert.ok(hello && start && connects[0] !== undefined, "the guest said hello");
            return { helloMs: hello.at - connects[0], startMs: start.at - hello.at };
          })();
    return { ok, runMs, tools, boot };
  }

  return {
    trial,
    async close() {
      await provider?.dispose();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

type StopConfig = { mode: "memory" | "child"; guestIgnoresCancel: boolean };

/**
 * Cancel to confirmed destruction, driven through the runtime alone as the executor's abort does,
 * on a run whose guest sleeps in a granted bash call.
 */
async function stopArm(config: StopConfig, runs: number) {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-worker-bench-stop-"));
  const fixture = await startWorkerRun({
    steps: Array.from({ length: runs }, () => ({
      expect() {},
      response: { type: "tool", id: "nap", name: "bash", arguments: { command: "sleep 30" } },
    })),
  });
  const { prisma } = fixture;
  const provider = new LocalWorkerProvider({
    mode: config.mode,
    root: path.join(dir, "workers"),
    faults: { guestIgnoresCancel: config.guestIgnoresCancel },
  });
  const runtime = createWorkerAgentRuntime({
    launcher: createLifecycleLauncher({
      prisma,
      lifecycle: createWorkerLifecycle({ prisma, provider }),
      connector: provider,
    }),
    stops: createStopJournal(prisma),
  });

  async function trial() {
    const runId = await fixture.send("Take a nap.");
    await prisma.run.update({
      where: { id: runId },
      data: { status: "running", leaseOwner: "bench", leaseFence: 1 },
    });
    const attempt = await prisma.attempt.create({ data: { runId, fence: 1, status: "running" } });
    let grant = () => {};
    const granted = new Promise<void>((resolve) => {
      grant = resolve;
    });
    const request: AgentRunRequest = {
      botId: fixture.bot.id,
      threadId: fixture.thread.id,
      runId,
      prompt: "Take a nap.",
      instructions: "Use bash.",
      history: [],
      tools: [...GUEST_TOOLS],
      model: fixture.model.model,
      attempt: { id: attempt.id, fence: 1 },
      executeTool: async () => "unused",
      executeLocalTool: async (_name, _args, _id, run) => {
        grant();
        return run(new AbortController().signal);
      },
    };
    const running = (async () => {
      for await (const _event of runtime.run(request)) {
      }
    })().catch(() => undefined);
    await granted;
    const started = performance.now();
    await runtime.abort(runId);
    const stopMs = performance.now() - started;
    await running;
    await prisma.run.update({ where: { id: runId }, data: { status: "cancelled" } });
    const row = await prisma.attempt.findUniqueOrThrow({
      where: { id: attempt.id },
      select: { workerState: true, stopPhase: true },
    });
    return { stopMs, ok: row.workerState === "released" && row.stopPhase === "process_ended" };
  }

  return {
    trial,
    async close() {
      await provider.dispose();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function rotate<T>(items: T[], by: number) {
  return items.map((_, index) => items[(index + by) % items.length]!);
}

async function main() {
  const arms: Arm[] = ["in_process", "memory", "child"];
  const control = new Map(
    await Promise.all(
      arms.map(async (arm) => [arm, await controlArm(arm, warmup + trials)] as const),
    ),
  );
  const results = new Map(
    arms.map((arm) => [
      arm,
      {
        errors: 0,
        warmupTools: [] as ToolSample[],
        firstTools: [] as ToolSample[],
        laterTools: [] as ToolSample[],
        runMs: [] as number[],
        helloMs: [] as number[],
        startMs: [] as number[],
      },
    ]),
  );
  try {
    for (let index = 0; index < warmup + trials; index++) {
      for (const arm of rotate(arms, index)) {
        const sample = await control.get(arm)!.trial();
        const result = results.get(arm)!;
        if (!sample.ok) result.errors += 1;
        if (index < warmup) {
          result.warmupTools.push(...sample.tools);
          continue;
        }
        result.firstTools.push(sample.tools[0]!);
        result.laterTools.push(...sample.tools.slice(1));
        result.runMs.push(sample.runMs);
        if (sample.boot) {
          result.helloMs.push(sample.boot.helloMs);
          result.startMs.push(sample.boot.startMs);
        }
      }
    }
  } finally {
    for (const arm of control.values()) await arm.close();
  }

  const stopConfigs: StopConfig[] = [
    { mode: "memory", guestIgnoresCancel: false },
    { mode: "child", guestIgnoresCancel: false },
    { mode: "memory", guestIgnoresCancel: true },
    { mode: "child", guestIgnoresCancel: true },
  ];
  const stopName = (config: StopConfig) =>
    `${config.mode}_${config.guestIgnoresCancel ? "guest_ignores_cancel" : "guest_cooperates"}`;
  const stops = new Map(
    await Promise.all(
      stopConfigs.map(
        async (config) => [stopName(config), await stopArm(config, stopTrials)] as const,
      ),
    ),
  );
  const stopResults = new Map(
    stopConfigs.map((config) => [stopName(config), { errors: 0, ms: [] as number[] }]),
  );
  try {
    for (let index = 0; index < stopTrials; index++) {
      for (const config of rotate(stopConfigs, index)) {
        const sample = await stops.get(stopName(config))!.trial();
        const result = stopResults.get(stopName(config))!;
        if (!sample.ok) result.errors += 1;
        result.ms.push(sample.stopMs);
      }
    }
  } finally {
    for (const arm of stops.values()) await arm.close();
  }

  const control95 = (tools: ToolSample[]) =>
    quantiles(tools.map((tool) => tool.authorizeMs + tool.ackMs)).p95;
  const describeTools = (tools: ToolSample[]) => ({
    controlMs: quantiles(tools.map((tool) => tool.authorizeMs + tool.ackMs)),
    authorizeMs: quantiles(tools.map((tool) => tool.authorizeMs)),
    ackMs: quantiles(tools.map((tool) => tool.ackMs)),
    queriesPerTool: quantiles(tools.map((tool) => tool.queries)),
    queryShareOfControl: (() => {
      const control = tools.reduce((sum, tool) => sum + tool.authorizeMs + tool.ackMs, 0);
      const queries = tools.reduce((sum, tool) => sum + tool.queryMs, 0);
      return control ? Math.round((queries / control) * 1000) / 1000 : null;
    })(),
  });

  const receipt = {
    generatedAt: new Date().toISOString(),
    host: { platform: platform(), arch: arch(), cpus: cpus().length, node: process.version },
    database: "PGlite in memory over the wire protocol, all repository migrations applied",
    arms: {
      in_process:
        "a scripted runtime in the controller's process runs each bash call through executeLocalTool: the same journaling and fenced claim, no channel, no model",
      memory: "the guest runs Pi in the controller's process over an in-memory channel",
      child: "the guest runs Pi in a child process over stdio frames",
    },
    model: "startModelEmulator on loopback; Pi, its HTTP client and SSE parsing are real",
    measuredAt:
      "the controller's side of the channel: a tool.call read to its tool.grant sent (authorize), a tool.done read to its tool.recorded sent (ack)",
    order: "trials rotate the arms, so each arm runs first, second and third equally often",
    stopMeasure:
      "runtime.abort on a run whose guest sleeps in a granted bash call, until it resolves; an error is a stop not recorded as process ended and released",
    trials,
    warmupTrials: warmup,
    toolsPerRun,
    budgets: {
      controlP95Ms: CONTROL_BUDGET_P95_MS,
      stopConfirmMs: WORKER_LIMITS.stopConfirmMs,
    },
    control: Object.fromEntries(
      arms.map((arm) => {
        const result = results.get(arm)!;
        return [
          arm,
          {
            errors: result.errors,
            firstToolOfAttempt: describeTools(result.firstTools),
            laterTools: describeTools(result.laterTools),
            warmupTools: describeTools(result.warmupTools),
            runMs: quantiles(result.runMs),
            ...(arm === "in_process"
              ? {}
              : {
                  guestBoot: {
                    connectToHelloMs: quantiles(result.helloMs),
                    helloToStartMs: quantiles(result.startMs),
                  },
                  withinBudget:
                    Math.max(
                      control95(result.firstTools) ?? Infinity,
                      control95(result.laterTools) ?? Infinity,
                    ) < CONTROL_BUDGET_P95_MS,
                }),
          },
        ];
      }),
    ),
    stop: Object.fromEntries(
      [...stopResults].map(([name, result]) => [
        name,
        {
          errors: result.errors,
          cancelToDestroyedMs: quantiles(result.ms),
          withinBudget: Math.max(...result.ms) < WORKER_LIMITS.stopConfirmMs,
        },
      ]),
    ),
  };
  await writeFile(values.out!, `${JSON.stringify(receipt, null, 2)}\n`);
  for (const arm of arms) {
    const result = results.get(arm)!;
    process.stdout.write(
      `${arm}: control p95 ${control95(result.firstTools)} ms first tool, ${control95(result.laterTools)} ms later, ${result.errors} errors\n`,
    );
  }
  for (const [name, result] of stopResults) {
    const { p50, max } = quantiles(result.ms);
    process.stdout.write(`stop ${name}: p50 ${p50} ms, max ${max} ms, ${result.errors} errors\n`);
  }
}

await main();
process.exit(0);
