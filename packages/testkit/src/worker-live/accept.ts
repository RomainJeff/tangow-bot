import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConnectorProvider, WorkerProvider } from "@rakazo/adapter-kit";
import type { GuestConnector } from "@rakazo/adapters/runtime-worker";
import { cancelRunsInTransaction } from "@rakazo/db";
import type { LogEvent } from "@rakazo/logging";
import { createLogger, getLogger, installLogger } from "@rakazo/logging";
import { Sandbox } from "e2b";
import type { Seen } from "../worker-channel-tap.js";
import { parse, tapConnector } from "../worker-channel-tap.js";
import { startWorkerRun } from "../worker-run-fixture.js";
import type { MeasuredModel } from "./measure.js";
import { forward, type Live, sh } from "./session.js";

export type TaskId = "code" | "app" | "browser" | "mcp";
export const TASKS: TaskId[] = ["code", "app", "browser", "mcp"];

type Run = Awaited<ReturnType<typeof startWorkerRun>>;
/** What the person saw from the run, and every tool it called, in the run's order. */
type Reply = { text: string; tools: Array<{ name: string; native: boolean }> };
type Check = (reply: Reply, run: Run, live: Live) => Promise<Record<string, unknown>>;
type Turn = { prompt: string; check: Check };

const SLOW_TOOL = "wait_for_review";

const codeTurn = (file: string, count: number, last: string): Turn => ({
  prompt: `Write a shell script ${file} in your workspace that prints the first ${count} Fibonacci numbers on one line, starting 0 1, and run it. Then run the same file on your computer with computer_exec. Tell me both outputs.`,
  async check(reply) {
    const native = reply.tools.filter((tool) => tool.native).map((tool) => tool.name);
    const onComputer = reply.tools.some((tool) => tool.name === "computer_exec");
    return {
      pass: native.includes("bash") && onComputer && reply.text.includes(last),
      nativeTools: native,
      computerExec: onComputer,
    };
  },
});

const appTurn = (prompt: string, text: string): Turn => ({
  prompt,
  async check(reply, run, live) {
    const { providerRef } = await run.prisma.computer.findFirstOrThrow({
      select: { providerRef: true },
    });
    const computer = providerRef && (await Sandbox.connect(providerRef, live.connection));
    const served = computer
      ? await sh(computer, "curl -s --max-time 5 http://127.0.0.1:8080/ || true")
      : "";
    return {
      pass: reply.text.includes(text) && served.includes(text),
      computerExec: reply.tools.some((tool) => tool.name === "computer_exec"),
      servedAfterRun: served.slice(0, 80),
    };
  },
});

const browserTurn = (url: string): Turn => ({
  prompt: `Use the browser on your computer to open ${url} and tell me its main heading.`,
  async check(reply) {
    const browser = reply.tools.filter((tool) => tool.name.startsWith("browser_"));
    return {
      pass: browser.length > 0 && reply.text.includes("Example Domain"),
      browserTools: browser.map((tool) => tool.name),
    };
  },
});

const mcpTurn = (title: string): Turn => ({
  prompt: `Publish a note titled "${title}" with the publish_note tool, then confirm in one sentence.`,
  async check(_reply, run) {
    const [computers, volumes] = await Promise.all([
      run.prisma.computer.count(),
      run.prisma.volume.count(),
    ]);
    return {
      pass: published.includes(title) && computers === 0 && volumes === 0,
      published: [...published],
      computers,
      volumes,
    };
  },
});

/**
 * The four journeys of #200, each in its own thread: a cold turn that boots the worker and the
 * computer, a warm turn with a variant of the task on the running computer, then a turn the person
 * stops while its tool runs. Without a computer the bot has no bash, so a slow controller tool
 * stands in for it.
 */
const JOURNEYS: Record<
  TaskId,
  { computer: "dedicated" | "none"; passWhen: string; turns: [Turn, Turn]; abort: string }
> = {
  code: {
    computer: "dedicated",
    passWhen:
      "Each script is written and run with the worker's native tools, the computer runs the same file, and the reply gives the sequence",
    turns: [codeTurn("p6-fib.sh", 10, "21 34"), codeTurn("p6-fib12.sh", 12, "55 89")],
    abort: "Run `sleep 300` with bash, then tell me it finished.",
  },
  app: {
    computer: "dedicated",
    passWhen:
      "The server runs on the computer, the reply quotes its answer, and it still answers from the computer after the run",
    turns: [
      appTurn(
        "On your computer, start a web server on port 8080 that answers every request with the text p6-app-ok. Leave it running in the background, check it with curl on the computer, and tell me what it answered.",
        "p6-app-ok",
      ),
      appTurn(
        "Change the server on port 8080 of your computer so that it answers p6-app-warm instead, leave it running, check it with curl on the computer, and tell me what it answered.",
        "p6-app-warm",
      ),
    ],
    abort: "Run `sleep 300` with bash, then tell me it finished.",
  },
  browser: {
    computer: "dedicated",
    passWhen: "A browser tool ran on the computer and the reply gives the page's heading",
    turns: [browserTurn("https://example.com"), browserTurn("https://example.org")],
    abort: "Run `sleep 300` with bash, then tell me it finished.",
  },
  mcp: {
    computer: "none",
    passWhen:
      "Each note is published by the controller's tool, and the bot has no computer and no volume",
    turns: [mcpTurn("P6 acceptance"), mcpTurn("P6 acceptance warm")],
    abort: `Call ${SLOW_TOOL}, then tell me it finished.`,
  },
};

const published: string[] = [];
const notes: ConnectorProvider = {
  describe: () => ({
    id: "notes",
    contractVersion: "1",
    adapterVersion: "1",
    capabilities: { discover: true, oauth: false, secretsBrokered: true },
  }),
  discoverTools: async () => [
    {
      name: "publish_note",
      description: "Publish a note with this title",
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
      route: { connectorId: "notes", resourceId: "notes", toolName: "publish_note" },
    },
    {
      name: SLOW_TOOL,
      description: "Wait until the pending review finishes, which takes about five minutes",
      inputSchema: { type: "object", properties: {} },
      route: { connectorId: "notes", resourceId: "notes", toolName: SLOW_TOOL },
    },
  ],
  async *execute(request, context) {
    if ((request.route?.toolName ?? request.tool) === SLOW_TOOL) {
      await sleep(300_000, undefined, { signal: context.signal }).catch(() => {});
      yield { type: "result", data: { finished: !context.signal.aborted } };
      return;
    }
    published.push(String(request.args.title));
    yield { type: "result", data: { published: request.args.title } };
  },
};

/**
 * The VM's memory in use and its CPU busy share since boot, read inside it: E2B's metrics API
 * returns no samples on this deployment.
 */
async function usage(live: Live, sandboxId: string) {
  try {
    const vm = await Sandbox.connect(sandboxId, live.connection);
    const [cpu, uptime, mem] = (
      await sh(
        vm,
        "awk '/^cpu /{print $2+$3+$4+$7+$8, $5+$6}' /proc/stat; awk '{print $1}' /proc/uptime; awk '/MemTotal|MemAvailable/{print $2}' /proc/meminfo | paste -sd' '",
      )
    ).split("\n");
    const [busy, idle] = cpu!.split(" ").map(Number);
    const [total, available] = mem!.split(" ").map(Number);
    return {
      uptimeS: Math.round(Number(uptime)),
      cpuBusyShareSinceBoot: Math.round((busy! / (busy! + idle!)) * 1000) / 1000,
      memUsedMiB: Math.round((total! - available!) / 1024),
      memTotalMiB: Math.round(total! / 1024),
    };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  }
}

/**
 * Runs each journey against a real model, through the production executor, worker routing,
 * pi-native guest and model relay.
 */
export async function acceptTasks(options: {
  live: Live;
  model: MeasuredModel;
  apiKey: string;
  tasks: TaskId[];
  onTask?: (record: Record<string, unknown>) => Promise<void>;
}) {
  const { live, model } = options;
  const events: LogEvent[] = [];
  const previousLogger = getLogger();
  installLogger(
    createLogger({
      service: "worker-accept",
      sinks: [
        {
          write: (event) =>
            void (event.message === "agent.worker.model_request" && events.push(event)),
        },
      ],
    }),
  );
  const records: Array<Record<string, unknown>> = [];
  try {
    for (const id of options.tasks) {
      const journey = JOURNEYS[id];
      published.length = 0;
      const seen: Seen[] = [];
      const ensures: number[] = [];
      const destroys: Array<{ ms: number; vm: Awaited<ReturnType<typeof usage>> }> = [];
      const run = await startWorkerRun({
        steps: [],
        catalogModel: { provider: model.provider, id: model.id, apiKey: options.apiKey },
        tools: notes,
        computerScope: journey.computer,
        sandbox: journey.computer === "none" ? undefined : live.computer(),
        screensByPath: true,
        provider: () => {
          const base: WorkerProvider & GuestConnector = live.workerProvider();
          return forward(base, {
            async ensure(spec, ctx) {
              ensures.push(performance.now());
              return base.ensure(spec, ctx);
            },
            async destroy(target, ctx) {
              const vm = target.providerRef
                ? await usage(live, target.providerRef)
                : { unavailable: "no ref" };
              const started = performance.now();
              const done = await base.destroy(target, ctx);
              destroys.push({ ms: Math.round(performance.now() - started), vm });
              return done;
            },
          });
        },
        connector: (provider) => tapConnector(provider, seen, []),
      });
      const record: Record<string, unknown> = { task: id, passWhen: journey.passWhen };
      try {
        const turn = async (label: "cold" | "warm", prompt: string, cancel?: boolean) => {
          const startedAt = performance.now();
          const fromEvent = events.length;
          const fromDestroy = destroys.length;
          const runId = await run.send(prompt);
          const running = run.continueRun(runId);
          let stopMs: number | undefined;
          if (cancel) {
            const deadline = Date.now() + 120_000;
            while (Date.now() < deadline && !(await toolStarted(run, runId)))
              await new Promise((resolve) => setTimeout(resolve, 250));
            const { taskId } = await run.prisma.run.findUniqueOrThrow({ where: { id: runId } });
            const cancelledAt = performance.now();
            await run.prisma.$transaction((tx) =>
              cancelRunsInTransaction(tx, [{ id: runId, taskId }], new Date(), run.userId),
            );
            await running;
            stopMs = Math.round(performance.now() - cancelledAt);
          } else await running;
          const runMs = Math.round(performance.now() - startedAt);
          const frames = parse(seen).filter((frame) => frame.at >= startedAt);
          const ensureAt = ensures.find((at) => at >= startedAt);
          const helloAt = frames.find((frame) => frame.kind === "worker.hello")?.at;
          const firstEventAt = frames.find(
            (frame) => frame.from === "controller" && frame.type === "model.event",
          )?.at;
          const { status, error } = await run.prisma.run.findUniqueOrThrow({
            where: { id: runId },
            select: { status: true, error: true },
          });
          const requests = events
            .slice(fromEvent)
            .filter((event) => event.threadId === run.thread.id);
          const tokens = (key: string) =>
            requests.reduce((sum, event) => sum + (Number(event[key]) || 0), 0);
          const usage = {
            requests: requests.length,
            inputTokens: tokens("inputTokens"),
            cacheReadTokens: tokens("cacheReadTokens"),
            outputTokens: tokens("outputTokens"),
          };
          const reply = await replyOf(run, runId);
          const workers = Sandbox.list({
            ...live.connection,
            query: { metadata: { p3live: live.tag, rakazo: "worker" } },
          });
          let workersLeft = 0;
          while (workers.hasNext) workersLeft += (await workers.nextItems()).length;
          return {
            runId,
            sample: {
              label,
              status,
              ...(error ? { error: error.slice(0, 300) } : {}),
              bootMs:
                ensureAt !== undefined && helloAt !== undefined
                  ? Math.round(helloAt - ensureAt)
                  : null,
              firstModelEventMs:
                firstEventAt === undefined ? null : Math.round(firstEventAt - startedAt),
              runMs,
              ...(stopMs === undefined ? {} : { stopAfterCancelMs: stopMs }),
              workerDestroy: destroys.slice(fromDestroy),
              workersLeftAfterRun: workersLeft,
              usage: {
                ...usage,
                catalogCostUsd: Number(
                  (
                    ((usage.inputTokens - usage.cacheReadTokens) * model.cost.input +
                      usage.cacheReadTokens * model.cost.cacheRead +
                      usage.outputTokens * model.cost.output) /
                    1e6
                  ).toFixed(6),
                ),
              },
              tools: reply.tools,
              reply: reply.text.slice(0, 600),
            },
            reply,
          };
        };
        const samples: Array<Record<string, unknown>> = [];
        const checks: Array<Record<string, unknown>> = [];
        for (const [index, { prompt, check }] of journey.turns.entries()) {
          const { sample, reply } = await turn(index === 0 ? "cold" : "warm", prompt);
          const checked =
            sample.status === "completed" ? await check(reply, run, live) : { pass: false };
          samples.push({ ...sample, prompt, check: checked });
          checks.push(checked);
        }
        const aborted = await turn("warm", journey.abort, true);
        record.samples = samples;
        record.abort = { ...aborted.sample, prompt: journey.abort };
        record.pass =
          checks.every((check) => check.pass === true) && aborted.sample.status === "cancelled";
        if (journey.computer !== "none") {
          const { providerRef } = await run.prisma.computer.findFirstOrThrow({
            select: { providerRef: true },
          });
          if (providerRef) record.computerVm = await usage(live, providerRef);
        }
      } catch (error) {
        record.pass = false;
        record.error = error instanceof Error ? error.message.slice(0, 500) : String(error);
      } finally {
        await run.close();
        const started = performance.now();
        const cleanup = await live.sweep();
        record.cleanup = { ...cleanup, sweepMs: Math.round(performance.now() - started) };
      }
      records.push(record);
      await options.onTask?.(record);
    }
  } finally {
    installLogger(previousLogger);
  }
  return records;
}

/** The abort turn's long tool has been called: a native bash, or the slow controller tool. */
async function toolStarted(run: Run, runId: string) {
  return (await run.runEntries(runId)).some(
    (entry) =>
      entry.type === "tool.call" &&
      (entry.payload.native === true || entry.payload.name === SLOW_TOOL),
  );
}

/** What message_user showed the person, and every tool the run called, in its order. */
async function replyOf(run: Run, runId: string): Promise<Reply> {
  const entries = (await run.runEntries(runId)).toSorted((a, b) => a.seq - b.seq);
  const text: string[] = [];
  const tools: Reply["tools"] = [];
  for (const entry of entries) {
    if (entry.type === "tool.call")
      tools.push({ name: entry.payload.name, native: entry.payload.native === true });
    if (entry.type === "assistant.text" && entry.payload.toPerson)
      for (const block of entry.payload.blocks) if (block.kind === "text") text.push(block.text);
  }
  return { text: text.join("\n"), tools };
}
