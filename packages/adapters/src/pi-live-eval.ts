import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelConnectInputSchema } from "@rakazo/contracts";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { z } from "zod";
import { PiRuntimeCredentialStore } from "./pi-credentials.js";
import type { LiveEvalArmResult } from "./pi-live-eval-arms.js";
import { LIVE_EVAL_ARMS, LIVE_EVAL_SHARED_TOOLS, runLiveEvalArm } from "./pi-live-eval-arms.js";
import {
  createLiveEvalTask,
  LIVE_EVAL_INSTRUCTIONS,
  LIVE_EVAL_TASK_IDS,
} from "./pi-live-eval-tasks.js";
import { LIVE_EVAL_LIMITS } from "./pi-live-eval-workspace.js";

const Controls = z.object({
  trials: z.coerce.number().int().min(1).max(30),
  timeoutMs: z.coerce.number().int().min(1_000).max(300_000),
  maxUsd: z.coerce.number().positive().max(25),
  maxTokens: z.coerce.number().int().min(256).max(8_192),
});

function configuration(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      live: { type: "boolean", default: false },
      connection: { type: "string" },
      provider: { type: "string", default: "openai" },
      model: { type: "string", default: "gpt-6-luna" },
      "api-key-env": { type: "string", default: "OPENAI_API_KEY" },
      trials: { type: "string", default: "6" },
      "timeout-ms": { type: "string", default: "180000" },
      "max-usd": { type: "string", default: "3" },
      "max-tokens": { type: "string", default: "4096" },
      case: { type: "string", multiple: true },
      output: { type: "string", default: "test-report/pi-live-eval/report.json" },
      "artifacts-dir": { type: "string" },
    },
  });
  const controls = Controls.parse({
    trials: values.trials,
    timeoutMs: values["timeout-ms"],
    maxUsd: values["max-usd"],
    maxTokens: values["max-tokens"],
  });
  return { values, controls };
}

async function connectionFor(values: Awaited<ReturnType<typeof configuration>>["values"]) {
  loadRootEnv();
  let raw: unknown;
  if (values.connection) {
    try {
      raw = JSON.parse(await readFile(values.connection, "utf8"));
    } catch {
      throw new Error("Cannot read the private model connection JSON.");
    }
  } else {
    raw = {
      provider: values.provider,
      modelId: values.model,
      apiKey: process.env[values["api-key-env"] ?? "OPENAI_API_KEY"],
    };
  }
  const parsed = ModelConnectInputSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.modelId?.trim() || !parsed.data.apiKey) {
    throw new Error("A model connection with a model id and an API credential is required.");
  }
  if (parsed.data.baseUrl) {
    throw new Error(
      "This comparison requires the catalog endpoint; endpoint overrides are unsupported.",
    );
  }
  return { ...parsed.data, modelId: parsed.data.modelId.trim(), apiKey: parsed.data.apiKey };
}

async function sdkConnection(
  connection: Awaited<ReturnType<typeof connectionFor>>,
  maxTokens: number,
) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new PiRuntimeCredentialStore(connection.provider, {
      type: "api_key",
      key: connection.apiKey,
    }),
    modelsPath: null,
    allowModelNetwork: true,
    refreshOnCreate: false,
  });
  const catalogModel = modelRuntime.getModel(connection.provider, connection.modelId);
  if (!catalogModel) throw new Error("The requested model is absent from the pinned Pi catalog.");
  modelRuntime.registerProvider(connection.provider, {
    api: catalogModel.api,
    baseUrl: connection.baseUrl ?? catalogModel.baseUrl,
    models: [{ ...catalogModel, maxTokens: Math.min(maxTokens, catalogModel.maxTokens) }],
  });
  const model = modelRuntime.getModel(connection.provider, connection.modelId);
  if (!model) throw new Error("The requested model could not be configured.");
  return { modelRuntime, model };
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (quantile: number) => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * quantile;
    const lower = sorted[Math.floor(position)];
    const upper = sorted[Math.ceil(position)];
    if (lower === undefined || upper === undefined) return null;
    return Math.round((lower + (upper - lower) * (position % 1)) * 1000) / 1000;
  };
  return {
    median: at(0.5),
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    q1: at(0.25),
    q3: at(0.75),
  };
}

async function saveReport(output: string, report: unknown, secret: string) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (secret && json.includes(secret))
    throw new Error("Refusing to save a report containing the API credential.");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.tmp`, json, { mode: 0o600 });
  await rename(`${output}.tmp`, output);
}

type RecordedTrial = Omit<LiveEvalArmResult, "artifacts"> & {
  trial: number;
  position: number;
  connectionSetupMs: number;
  processCpuMs: number;
};

function summary(trials: RecordedTrial[]) {
  return LIVE_EVAL_TASK_IDS.flatMap((task) =>
    LIVE_EVAL_ARMS.map((arm) => {
      const runs = trials.filter((run) => run.arm === arm && run.task === task);
      return {
        task,
        arm,
        runs: runs.length,
        passed: runs.filter((run) => run.status === "completed" && run.done && run.grade.passed)
          .length,
        errors: runs.filter((run) => run.errors.length).length,
        wallMs: distribution(runs.map((run) => run.metrics.wallMs)),
        successfulWallMs: distribution(
          runs
            .filter((run) => run.status === "completed" && run.done && run.grade.passed)
            .map((run) => run.metrics.wallMs),
        ),
        processCpuMs: distribution(runs.map((run) => run.processCpuMs)),
        inputTokens: distribution(runs.map((run) => run.metrics.usage.input)),
        toolCalls: distribution(runs.map((run) => run.metrics.toolCalls)),
        toolErrors: runs.reduce((sum, run) => sum + run.metrics.toolErrors, 0),
        modelTurns: distribution(runs.map((run) => run.metrics.modelTurns)),
        outputTokens: distribution(runs.map((run) => run.metrics.usage.output)),
        costUSD:
          !runs.length || runs.some((run) => run.metrics.costUSD === null)
            ? null
            : runs.reduce((sum, run) => sum + (run.metrics.costUSD ?? 0), 0),
      };
    }),
  );
}

async function main() {
  const { values, controls } = await configuration(process.argv.slice(2));
  const selected = LIVE_EVAL_TASK_IDS.filter(
    (id) => !values.case?.length || values.case.includes(id),
  );
  if (
    !selected.length ||
    values.case?.some((id) => !selected.some((selectedId) => selectedId === id))
  ) {
    throw new Error("Unknown case; choose reconcile or config-repair.");
  }
  const trials: RecordedTrial[] = [];
  const report = {
    kind: "real-model-pi-harness-pilot",
    startedAt: new Date().toISOString(),
    status: "not-run",
    model: values.model,
    provider: values.provider,
    api: "unresolved",
    controls: { ...controls, maxToolCalls: LIVE_EVAL_LIMITS.toolCalls, thinkingLevel: "medium" },
    metadata: {
      instructionsSha256: createHash("sha256").update(LIVE_EVAL_INSTRUCTIONS).digest("hex"),
      sharedToolsSha256: createHash("sha256")
        .update(JSON.stringify(LIVE_EVAL_SHARED_TOOLS))
        .digest("hex"),
      arms: {
        "current-runtime":
          "Actual PiAgentRuntime with shared file tools; product callbacks, event translation and silent-turn continuation retained. No executor or PostgreSQL.",
        "sdk-same-tools":
          "Real AgentSession with the same tool names, schemas, behavior and task instructions; SDK session lifecycle differs.",
        "sdk-native-files":
          "Real AgentSession with public SDK read/write/edit tool definitions using overridden in-memory operations; list_files and run_check remain shared.",
      },
      timing:
        "Fresh session and workspace per arm. Wall includes engine construction and SDK model-registry setup; module import and workspace directory creation are excluded.",
      pairing:
        "Same task seed for all arms; six order permutations rotate across trials. Network runs are serial, with no injected delays or retries by the evaluator.",
      cost: "Catalog estimates from reported token usage, not a billing receipt. Stop before another run once the cumulative estimate reaches maxUsd; one bounded run may overshoot. Missing cost stops further runs.",
      limitations: [
        "Descriptive pilot; no statistical significance or general task-quality claim.",
        "Synthetic task data and in-memory file IO; no shell, browser, external service or generated-code execution.",
        "SDK native file-tool ergonomics are exercised, but the production SDK adapter and worker remain unbuilt.",
        "This does not replace approval, steering, compaction, private-text, trace or recovery conformance tests.",
        "A task need not last 1-2 minutes; timeouts are limits, never artificial workload delays.",
        "The historical microbenchmark remains separate; its 1.2x diagnostic gate is not redefined by this pilot.",
      ],
    },
    planned: selected.flatMap((task) =>
      LIVE_EVAL_ARMS.map((arm) => ({ task, arm, trials: controls.trials })),
    ),
    trials,
    summary: summary(trials),
  };
  const output = resolve(values.output ?? "test-report/pi-live-eval/report.json");
  if (!values.live) {
    await saveReport(output, report, "");
    process.stdout.write(
      "No model calls made; the report records not-run. Use --live to execute.\n",
    );
    return;
  }
  const connection = await connectionFor(values);
  report.model = connection.modelId;
  report.provider = connection.provider;
  const initialSdk = await sdkConnection(connection, controls.maxTokens);
  report.api = initialSdk.model.api;
  report.status = "running";
  await saveReport(output, report, connection.apiKey);
  process.env.LOG_LEVEL = "off";
  process.env.MAX_TOOL_CALLS_PER_TURN = String(LIVE_EVAL_LIMITS.toolCalls);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const orders = [
    [0, 1, 2],
    [2, 1, 0],
    [1, 2, 0],
    [0, 2, 1],
    [2, 0, 1],
    [1, 0, 2],
  ];
  let spending = 0;
  try {
    runs: for (let trial = 1; trial <= controls.trials; trial++) {
      const order = orders[(trial - 1) % orders.length];
      if (!order) throw new Error("Missing evaluation order.");
      for (const taskId of selected) {
        const task = createLiveEvalTask(taskId, 7_300 + trial);
        for (const [position, index] of order.entries()) {
          if (controller.signal.aborted || spending >= controls.maxUsd) {
            report.status = "stopped";
            break runs;
          }
          const arm = LIVE_EVAL_ARMS[index];
          if (!arm) throw new Error("Missing evaluation arm.");
          const cwd = await mkdtemp(join(tmpdir(), "pi-live-eval-"));
          try {
            const cpuStarted = process.cpuUsage();
            const setupStarted = performance.now();
            const sdk =
              arm === "current-runtime"
                ? initialSdk
                : await sdkConnection(connection, controls.maxTokens);
            const connectionSetupMs =
              arm === "current-runtime" ? 0 : performance.now() - setupStarted;
            const result = await runLiveEvalArm({
              arm,
              task,
              cwd,
              agentDir: cwd,
              models: {
                runtime: {
                  provider: connection.provider,
                  id: connection.modelId,
                  apiKey: connection.apiKey,
                  maxTokens: controls.maxTokens,
                  thinkingLevel: "medium",
                },
                sdk,
              },
              secrets: [connection.apiKey],
              signal: controller.signal,
              deadlineMs: controls.timeoutMs,
            });
            const { artifacts: _artifacts, ...record } = result;
            const cpu = process.cpuUsage(cpuStarted);
            if (values["artifacts-dir"]) {
              await saveReport(
                resolve(values["artifacts-dir"], `${taskId}-${trial}-${arm}.json`),
                Object.fromEntries(result.artifacts),
                connection.apiKey,
              );
            }
            trials.push({
              ...record,
              trial,
              position,
              connectionSetupMs,
              processCpuMs: (cpu.user + cpu.system) / 1000,
              metrics: { ...result.metrics, wallMs: result.metrics.wallMs + connectionSetupMs },
            });
            spending += result.metrics.costUSD ?? 0;
            report.summary = summary(trials);
            await saveReport(output, report, connection.apiKey);
            process.stdout.write(
              `${taskId} ${arm} trial ${trial}: ${result.grade.passed ? "passed" : "failed"}; ${result.metrics.modelTurns} turns; ${result.metrics.toolCalls} tools; ${Math.round(result.metrics.wallMs)}ms\n`,
            );
            if (result.errors.includes("unsettled") || result.metrics.costUSD === null) {
              report.status = "stopped";
              break runs;
            }
          } finally {
            await rm(cwd, { recursive: true, force: true });
          }
        }
      }
    }
    if (report.status === "running") report.status = "completed";
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    report.summary = summary(trials);
    await saveReport(output, report, connection.apiKey);
  }
  if (
    report.status !== "completed" ||
    trials.some((run) => !run.grade.passed || run.status !== "completed")
  ) {
    process.exitCode = 1;
  }
}

main().catch(() => {
  process.stderr.write(
    "Live evaluation did not complete. Check the report and model connection; private error details are omitted.\n",
  );
  process.exitCode = 1;
});
