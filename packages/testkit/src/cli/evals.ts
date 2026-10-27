import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ModelConnectInputSchema } from "@rakazo/contracts";
import { DEFAULT_SKILL_LEARNING } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { startDockerSupervisor } from "../docker-supervisor.js";
import { EVAL_CASES } from "../evals/cases.js";
import { emptyTrial, redact, summarize, validateControls } from "../evals/report.js";

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      connection: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "api-key-env": { type: "string" },
      "base-url": { type: "string" },
      trials: { type: "string", default: "3" },
      case: { type: "string", multiple: true },
      "timeout-ms": { type: "string", default: "180000" },
      "max-tool-calls": { type: "string", default: "30" },
      output: { type: "string", default: "test-report/evals/report.json" },
      computer: { type: "string", default: "fake" },
    },
  });
  if (values.list) {
    for (const scenario of EVAL_CASES) console.log(`${scenario.id}: ${scenario.purpose}`);
    return;
  }
  const controls = {
    trials: Number(values.trials),
    timeoutMs: Number(values["timeout-ms"]),
    maxToolCalls: Number(values["max-tool-calls"]),
  };
  validateControls(controls);
  if (values.computer !== "fake" && values.computer !== "docker")
    throw new Error("--computer is fake or docker");
  const docker = values.computer === "docker";
  const selected = values.case?.length
    ? EVAL_CASES.filter((c) => values.case!.includes(c.id))
    : EVAL_CASES.filter((c) => docker || !c.browserSite);
  if (!selected.length || values.case?.some((id) => !EVAL_CASES.some((c) => c.id === id)))
    throw new Error("Unknown eval case; use --list");
  if (!docker && selected.some((c) => c.browserSite))
    throw new Error("Browser cases need --computer docker");
  // Trial by trial across cases, so drift and warmup do not favor one case.
  const trials = Array.from({ length: controls.trials }, (_, i) =>
    selected.map((c) => emptyTrial(c.id, i + 1)),
  ).flat();
  const output = path.resolve(values.output!);
  const report = {
    version: 1,
    kind: "real-model-product-eval",
    startedAt: new Date().toISOString(),
    model: values.model ?? process.env.PI_DEFAULT_MODEL ?? null,
    provider: values.provider ?? null,
    controls,
    fixtures: docker
      ? "synthetic services, messaging and a Docker computer serving the bench travel site"
      : "synthetic services, messaging and fake sandbox",
    assistedRetries: false,
    limitations: [
      "Does not evaluate browser perception, native recording perception, or real external services.",
      "Release routine grades a scheduled new-release read; unchanged-release notification deduplication is not covered.",
      "Deterministic fact checks are deliberately narrow; they do not grade overall writing quality.",
      "Cost is unavailable from persisted product usage and is reported as null.",
      "Tool trace contains names and statuses only; raw requests and responses are omitted.",
    ],
    trials,
    summary: summarize(trials),
  };
  const save = () => {
    report.summary = summarize(report.trials);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${output}.tmp`, output);
  };
  save();
  if (!values.live)
    throw new Error("Live model execution requires --live; report marks all trials not-run");
  loadRootEnv();
  const rawConnection: unknown = values.connection
    ? readConnection(values.connection)
    : {
        provider: values.provider,
        modelId: values.model ?? process.env.PI_DEFAULT_MODEL,
        apiKey: values["api-key-env"] ? process.env[values["api-key-env"]] : undefined,
        baseUrl: values["base-url"],
        label: "Eval model",
      };
  const parsedConnection = ModelConnectInputSchema.safeParse(rawConnection);
  if (!parsedConnection.success || !parsedConnection.data.modelId?.trim())
    throw new Error(
      "A valid model connection is required: --connection with models/connect JSON, or --provider --model --api-key-env (and --base-url for compatible servers). All trials remain not-run.",
    );
  const connection = parsedConnection.data;
  report.model = connection.modelId!;
  report.provider = connection.provider;
  save();
  // This CLI owns a disposable database. Never migrate or evaluate against an inherited database.
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-evals-"));
  let postgres: StartedPostgreSqlContainer | undefined;
  let supervisor: { url: string; stop: () => void } | undefined;
  try {
    postgres = await new PostgreSqlContainer("postgres:16-alpine").start();
    const databaseUrl = postgres.getConnectionUri();
    Object.assign(process.env, {
      DATABASE_URL: databaseUrl,
      REALTIME_DATABASE_URL: databaseUrl,
      WAKEUP_DRIVER: "memory",
      BETTER_AUTH_SECRET: "synthetic-eval-auth-secret-at-least-32-characters",
      ENCRYPTION_KEY: "synthetic-eval-encryption-key-at-least-32-characters",
      SANDBOX_SUPERVISOR_TOKEN: "synthetic-eval-supervisor-token-at-least-32-characters",
      SCREEN_PROXY_SECRET: "synthetic-eval-screen-secret-at-least-32-characters",
      BETTER_AUTH_URL: "http://127.0.0.1:5173",
      WEB_ORIGIN: "http://127.0.0.1:5173",
      SIGNUPS_ENABLED: "true",
      SIGNUP_ALLOWLIST: "",
      SANDBOX_PROVIDER: "fake",
      DATA_DIR: dataDir,
      MAX_TOOL_CALLS_PER_TURN: String(controls.maxToolCalls),
      WEB_PROVIDER: "fake",
      LOG_LEVEL: "off",
      COMPOSIO_API_KEY: "",
      PIPEDREAM_CLIENT_ID: "",
      PIPEDREAM_CLIENT_SECRET: "",
      PIPEDREAM_PROJECT_ID: "",
      SMTP_URL: "",
      SLACK_BOT_TOKEN: "",
      TELEGRAM_BOT_TOKEN: "",
      WHATSAPP_ACCESS_TOKEN: "",
      LARK_APP_ID: "",
      SENDBLUE_API_KEY_ID: "",
      MODEL_API_KEY: "",
    });
    execFileSync("pnpm", ["--filter", "@rakazo/db", "generate"], {
      stdio: "pipe",
      timeout: 120_000,
    });
    execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], {
      stdio: "pipe",
      timeout: 120_000,
    });
    // Import runtime modules only after generation; their barrel exports load Prisma.
    const { createApp } = await import("../../../../apps/api/src/app.ts");
    const { runTrial } = await import("../evals/runner.js");
    const { EvalSandboxProvider } = await import("../evals/sandbox.js");
    const { computerOnVolumes, LocalWorkerProvider } = await import("../local-worker-provider.js");
    const { TravelSiteComputer } = await import("../bench/travel-site/computer.js");
    const { DockerWorkerProvider } = await import("@rakazo/adapters");
    // One supervisor for the run; each trial's bot is new, so its computer is a new container.
    const computers = docker ? path.join(dataDir, "computers") : undefined;
    const supervisorToken = process.env.SANDBOX_SUPERVISOR_TOKEN!;
    if (computers) {
      mkdirSync(computers, { recursive: true });
      supervisor = await startDockerSupervisor({
        dataDir: computers,
        token: supervisorToken,
        env: dockerEnv(),
      });
    }
    for (let i = 0; i < trials.length; i++) {
      const planned = trials[i]!;
      const scenario = selected.find((c) => c.id === planned.caseId)!;
      trials[i] = await runTrial(scenario, planned.trial, {
        ...controls,
        connection,
        createApp: async (composio, messaging) => {
          // The supervisor binds homes and volumes from its own data directory, so the app shares it.
          const trialDataDir = computers ?? path.join(dataDir, `${scenario.id}-${planned.trial}`);
          // A guest is a child process with none of this process's keys, or with a Docker computer,
          // a worker container that reaches neither this machine's files nor the computer's loopback.
          const workers = supervisor
            ? new DockerWorkerProvider({
                supervisorUrl: supervisor.url,
                supervisorToken,
                dataDir: trialDataDir,
              })
            : new LocalWorkerProvider({ mode: "child", root: path.join(trialDataDir, "workers") });
          const sandbox = supervisor
            ? new TravelSiteComputer(supervisor.url, supervisorToken)
            : new EvalSandboxProvider((volumeRef) => workers.volumePath(volumeRef));
          const handles = await createApp({
            sandbox,
            workers,
            mainBotBlockedTools: scenario.mainBotBlockedTools,
            agentRuntime: "worker",
            databaseUrl,
            realtimeDatabaseUrl: databaseUrl,
            dataDir: trialDataDir,
            sandboxProvider: docker ? "docker" : "fake",
            wakeupDriver: "memory",
            composio,
            messaging,
            messagingOpenSignup: false,
            defaultProvider: connection.provider,
            defaultModel: connection.modelId!,
            deploymentModelKey: undefined,
            composioApiKey: undefined,
            signupsEnabled: "true",
            signupAllowlist: "",
            emailEmulator: true,
            pipedreamClientId: undefined,
            pipedreamClientSecret: undefined,
            pipedreamProjectId: undefined,
            smtpUrl: undefined,
            emailFrom: undefined,
            sendblueApiKeyId: undefined,
            sendblueApiSecret: undefined,
            slackBotToken: undefined,
            whatsappAccessToken: undefined,
            telegramBotToken: undefined,
            larkAppId: undefined,
            mcpStdioEnabled: false,
            mcpStdioAllowedCommands: [],
            updaterUrl: undefined,
            updaterToken: undefined,
            skillLearning: scenario.skillLearning ? "on" : DEFAULT_SKILL_LEARNING,
          });
          return {
            ...handles,
            dataDir: trialDataDir,
            harnessIssues: "harnessIssues" in sandbox ? sandbox.harnessIssues : undefined,
            prepareBot: (botId) =>
              computerOnVolumes(handles.prisma, botId, docker ? "docker" : "e2b"),
            async stop() {
              try {
                await handles.stop();
              } finally {
                try {
                  if ("destroyPrepared" in sandbox) await sandbox.destroyPrepared();
                } finally {
                  if ("dispose" in workers) await workers.dispose();
                }
              }
            },
          };
        },
      });
      save();
      const result = trials[i]!;
      console.log(
        `${result.caseId} trial ${result.trial}: ${result.status}${result.category ? ` (${result.category})` : ""}; ${result.toolCalls} tool calls; ${result.helperToolCalls} helper tool calls; ${result.latencyMs}ms; run ${result.runMs ?? "-"}ms; first reply ${result.firstReplyMs ?? "-"}ms; ${(result.inputTokens ?? 0) + (result.outputTokens ?? 0)} tokens; main context ${result.mainContextTokens ?? "-"}`,
      );
      if (result.cleanupFailed) {
        process.exitCode = 1;
        break;
      }
    }
    if (trials.some((r) => r.status !== "passed")) process.exitCode = 1;
  } finally {
    supervisor?.stop();
    try {
      await postgres?.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

/** What the supervisor needs to reach this machine's Docker as the `docker` CLI does. */
function dockerEnv(): Record<string, string> {
  const docker = (...args: string[]) =>
    execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
  return {
    // The supervisor defaults to /var/run/docker.sock; follow the CLI's context instead.
    ...(process.env.DOCKER_HOST || process.env.DOCKER_SOCKET
      ? {}
      : { DOCKER_HOST: docker("context", "inspect", "--format", "{{.Endpoints.docker.Host}}") }),
    // A supervisor on the host of Docker Desktop cannot reach container addresses.
    ...(docker("info", "--format", "{{.OperatingSystem}}") === "Docker Desktop"
      ? { SANDBOX_CONTROL_VIA_LOOPBACK: "true" }
      : {}),
  };
}

function readConnection(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Parser and filesystem errors may include private file contents or paths.
    throw new Error(
      "Could not read model connection JSON. Check that the file is readable and contains valid JSON. All trials remain not-run.",
    );
  }
}

main().catch((error: unknown) => {
  // Never dump process env, subprocess output, connection JSON, or error stacks into public CI logs.
  console.error(
    redact(
      error instanceof Error ? error.message.split("\n")[0]! : "Eval runner failed",
      Object.entries(process.env)
        .filter(([key]) => /KEY|SECRET|TOKEN|PASSWORD/.test(key))
        .map(([, value]) => value ?? ""),
    ),
  );
  process.exitCode = 1;
});
