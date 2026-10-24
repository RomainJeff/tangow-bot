/**
 * Live P3 lanes against an E2B deployment. Needs E2B_API_KEY, and E2B_API_URL (with
 * E2B_SANDBOX_URL) or E2B_DOMAIN for a self-hosted one. Every resource it creates carries the
 * session's tag and is removed after each lane; receipts are redacted before they are written.
 *
 *   worker-live template --guest <agent-run-worker.mjs> --name <template>
 *   worker-live lanes --template <worker> --computer-template <computer> --out <dir> [--lanes a,b]
 *     Each lane runs in a child process: worker-live lane --lane <id> --template ...
 *   worker-live bench --template <worker> --computer-template <computer> --out <dir> [--trials 30] [--database postgresql]
 *   worker-live measure --template <worker> --computer-template <computer> --out <dir> [--trials 30]
 *     [--provider opencode-go] [--models 'glm-*-flash,gpt-*-luna'] [--gaps 10s,2m,5m,10m]
 *     [--approval-delays 10s,6m] [--scenarios chain,computer,approval,compaction]
 *     [--worker local]
 *     Token and cache measurements against a real model. RAKAZO_MODEL_KEY_FILE names a file
 *     outside any git work tree that holds the provider key. `--worker local` runs the guests in
 *     this process instead of E2B, for scenarios without a computer.
 */
import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { WORKER_PROFILE, workerTemplate } from "@rakazo/agent-run-worker/template";
import type { ConnectionOpts } from "e2b";
import { Sandbox, Template } from "e2b";
import {
  benchLive,
  LANES,
  liveSession,
  memAvailableMiB,
  requireHeadroom,
} from "../worker-live/index.js";
import type { ScenarioId, ThreadRecord } from "../worker-live/measure.js";
import {
  measureTokens,
  resolveModels,
  SCENARIOS,
  stableLocalWorkers,
} from "../worker-live/measure.js";
import { summarize } from "../worker-live/measure-receipt.js";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    guest: { type: "string" },
    "prepare-computer": { type: "boolean", default: false },
    name: { type: "string" },
    harness: { type: "string", default: "pi-native" },
    template: { type: "string" },
    "computer-template": { type: "string" },
    out: { type: "string" },
    lanes: { type: "string" },
    lane: { type: "string" },
    database: { type: "string", default: "pglite" },
    trials: { type: "string", default: "30" },
    provider: { type: "string", default: "opencode-go" },
    models: { type: "string", default: "glm-*-flash,gpt-*-luna" },
    gaps: { type: "string", default: "10s,2m,5m,10m" },
    "approval-delays": { type: "string", default: "10s,6m" },
    scenarios: { type: "string", default: SCENARIOS.join(",") },
    worker: { type: "string", default: "e2b" },
  },
});

const local = command === "measure" && values.worker === "local";
const apiKey = process.env.E2B_API_KEY;
if (!apiKey && !local) throw new Error("E2B_API_KEY is not set");
const connection: ConnectionOpts = {
  apiKey,
  apiUrl: process.env.E2B_API_URL,
  domain: process.env.E2B_DOMAIN,
};

const SECRETS = [
  apiKey,
  process.env.DATABASE_URL,
  process.env.E2B_API_URL,
  process.env.E2B_SANDBOX_URL,
  process.env.E2B_VOLUME_API_URL,
  process.env.E2B_DOMAIN,
  os.homedir(),
  os.userInfo().username,
  os.hostname(),
].filter((value): value is string => Boolean(value && value.length > 2));

/** Receipts name no key, endpoint, address but loopback, account, machine or local path. */
function redact(text: string): string {
  let clean = text;
  for (const secret of SECRETS) clean = clean.replaceAll(secret, "<redacted>");
  return clean.replace(/\b(?!127\.0\.0\.1\b)\d{1,3}(\.\d{1,3}){3}\b/g, "<ip>");
}

async function writeReceipt(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${redact(JSON.stringify(value, null, 2))}\n`);
}

/** Stops unless the deployment runs no sandbox: between lanes, any sandbox is someone else's. */
async function requireIdleDeployment() {
  const pages = Sandbox.list({ ...connection });
  let running = 0;
  while (pages.hasNext) running += (await pages.nextItems()).length;
  if (running > 0) throw new Error(`${running} sandboxes run on the deployment; stopping`);
}

function session() {
  if (!values.template || !values["computer-template"]) {
    throw new Error("--template and --computer-template are required");
  }
  const live = liveSession({
    ...connection,
    apiKey: connection.apiKey!,
    workerTemplate: values.template,
    harness: values.harness,
    guestBundle: values.guest,
    prepareComputer: values["prepare-computer"],
    computerTemplate: values["computer-template"],
  });
  const sweepOnSignal = (signal: NodeJS.Signals) => {
    process.once(signal, () => {
      console.error(`${signal}: removing this session's sandboxes and volumes`);
      void live.sweep().finally(() => process.exit(130));
    });
  };
  sweepOnSignal("SIGINT");
  sweepOnSignal("SIGTERM");
  return live;
}

async function template() {
  if (!values.guest || !values.name) throw new Error("--guest and --name are required");
  const started = performance.now();
  const built = await Template.build(workerTemplate(values.harness, values.guest), values.name, {
    ...connection,
    ...WORKER_PROFILE,
  });
  console.log(
    redact(
      JSON.stringify({
        name: values.name,
        templateId: built.templateId,
        buildId: built.buildId,
        profile: WORKER_PROFILE,
        guestSha256: createHash("sha256").update(readFileSync(values.guest)).digest("hex"),
        seconds: Math.round((performance.now() - started) / 1000),
      }),
    ),
  );
}

/** One lane in this process, its record sent to the parent: a fresh process per lane keeps memory flat. */
async function lane() {
  const selected = LANES.find((candidate) => candidate.id === values.lane);
  if (!selected) throw new Error(`No lane ${values.lane}`);
  const live = session();
  const memBefore = requireHeadroom();
  const started = performance.now();
  let outcome: { result: "pass" | "fail"; observed?: Record<string, unknown>; error?: string };
  try {
    const { pass, observed } = await selected.run(live);
    outcome = { result: pass ? "pass" : "fail", observed };
  } catch (error) {
    outcome = {
      result: "fail",
      error: error instanceof Error ? (error.stack ?? error.message).slice(0, 2000) : String(error),
    };
  }
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  const controllerRssMiB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const cleanup = await live.sweep();
  const record = {
    ...outcome,
    seconds,
    memAvailableMiB: { before: memBefore, after: memAvailableMiB() },
    controllerRssMiB,
    cleanup,
  };
  await new Promise<void>((resolve) => process.send!(record, () => resolve()));
}

async function lanes() {
  if (!values.template || !values["computer-template"] || !values.out) {
    throw new Error("--template, --computer-template and --out are required");
  }
  const selected = values.lanes?.split(",") ?? LANES.map((candidate) => candidate.id);
  const records: unknown[] = [];
  const startedAt = new Date().toISOString();
  const receipt = () => ({
    tag: "p3live-<session>",
    harness: values.harness,
    model: "local protocol emulator; not a real-model intelligence evaluation",
    desktopPreparation: values["prepare-computer"]
      ? "product E2BSandboxProvider.prepare"
      : "skipped for plain P3 fixtures; not computer parity evidence",
    guestSha256: values.guest
      ? createHash("sha256").update(readFileSync(values.guest)).digest("hex")
      : null,
    startedAt,
    workerTemplate: values.template,
    computerTemplate: values["computer-template"],
    lanes: records,
  });
  for (const candidate of LANES.filter((entry) => selected.includes(entry.id))) {
    const base = {
      lane: candidate.id,
      issue: candidate.issue,
      scenario: candidate.scenario,
      passWhen: candidate.passWhen,
    };
    await requireIdleDeployment();
    requireHeadroom();
    const child = fork(
      process.argv[1]!,
      [
        "lane",
        "--harness",
        values.harness,
        ...(values.guest ? ["--guest", values.guest] : []),
        ...(values["prepare-computer"] ? ["--prepare-computer"] : []),
        "--lane",
        candidate.id,
        "--template",
        values.template,
        "--computer-template",
        values["computer-template"],
      ],
      { execArgv: process.execArgv },
    );
    const [record, code] = await Promise.all([
      new Promise<Record<string, unknown> | undefined>((resolve) => {
        child.once("message", (message) => resolve(message as Record<string, unknown>));
        child.once("exit", () => resolve(undefined));
      }),
      new Promise<number | null>((resolve) => child.once("exit", resolve)),
    ]);
    if (!record)
      throw new Error(`Lane ${candidate.id} ended with code ${code} and no record; stopping`);
    records.push({ ...base, ...record });
    await writeReceipt(path.join(values.out, "lanes.json"), receipt());
    const cleanup = record.cleanup as { left: { sandboxes: number; volumes: number } };
    console.log(
      `lane ${candidate.id.padEnd(20)} ${String(record.result).toUpperCase().padEnd(7)} ${String(record.seconds).padStart(6)} s   rss ${record.controllerRssMiB} MiB   left ${cleanup.left.sandboxes} sandboxes, ${cleanup.left.volumes} volumes`,
    );
  }
  await writeReceipt(path.join(values.out, "lanes.json"), receipt());
}

async function bench() {
  if (!values.out) throw new Error("--out is required");
  const trials = Number(values.trials);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error("--trials must be a positive integer");
  }
  await requireIdleDeployment();
  const live = session();
  const memBefore = requireHeadroom();
  try {
    const database = values.database;
    if (database !== "pglite" && database !== "postgresql")
      throw new Error("--database must be pglite or postgresql");
    const databaseUrl = database === "postgresql" ? process.env.DATABASE_URL : undefined;
    if (database === "postgresql" && (!databaseUrl || trials < 10)) {
      throw new Error("PostgreSQL bench needs DATABASE_URL and at least 10 trials");
    }
    const result = await benchLive(live, trials, databaseUrl);
    const cleanup = await live.sweep();
    await writeReceipt(path.join(values.out!, "bench.json"), {
      generatedAt: new Date().toISOString(),
      host: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        node: process.version,
      },
      workerTemplate: values.template,
      memAvailableMiB: { before: memBefore, after: memAvailableMiB() },
      ...result,
      cleanup,
    });
    console.log(redact(JSON.stringify({ ...result, rssMiB: undefined, cleanup }, null, 2)));
  } catch (error) {
    console.error(await live.sweep());
    throw error;
  }
}

/** `90s`, `2m` or `1h` in milliseconds. */
function durations(list: string): number[] {
  const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return list.split(",").map((entry) => {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(entry.trim());
    if (!match) throw new Error(`${entry} is not a duration such as 30s or 5m`);
    return Number(match[1]) * units[match[2] as keyof typeof units];
  });
}

/** The provider key, from a private file kept outside every git work tree. */
function modelKey(): string {
  const file = process.env.RAKAZO_MODEL_KEY_FILE;
  if (!file) throw new Error("RAKAZO_MODEL_KEY_FILE must name the file that holds the model key");
  let tracked = false;
  try {
    execFileSync("git", ["-C", path.dirname(path.resolve(file)), "rev-parse"], { stdio: "ignore" });
    tracked = true;
  } catch {}
  if (tracked) throw new Error("RAKAZO_MODEL_KEY_FILE must be outside any git work tree");
  const key = readFileSync(file, "utf8").trim();
  if (key.length < 8) throw new Error("The model key file holds no key");
  SECRETS.push(key, path.resolve(file));
  return key;
}

async function measure() {
  if (!values.out) throw new Error("--out is required");
  const trials = Number(values.trials);
  if (!Number.isInteger(trials) || trials < 1)
    throw new Error("--trials must be a positive integer");
  const scenarios = values.scenarios.split(",") as ScenarioId[];
  for (const scenario of scenarios)
    if (!SCENARIOS.includes(scenario)) throw new Error(`No scenario ${scenario}`);
  const protocol = {
    scenarios,
    trials,
    gapsMs: durations(values.gaps),
    approvalDelaysMs: durations(values["approval-delays"]),
  };
  if (local && scenarios.includes("computer"))
    throw new Error("The computer scenario needs E2B; drop it with --scenarios");
  const apiKey = modelKey();
  const models = resolveModels(values.provider, values.models.split(","));
  const shortest = Math.min(...protocol.gapsMs);
  const waits =
    (scenarios.includes("chain") ? protocol.gapsMs.reduce((sum, gap) => sum + gap, 0) : 0) +
    (scenarios.includes("computer") ? shortest : 0) +
    (scenarios.includes("compaction") ? shortest : 0) +
    (scenarios.includes("approval")
      ? protocol.approvalDelaysMs.reduce((sum, delay) => sum + delay, 0)
      : 0);
  console.log(
    `${models.map((model) => model.id).join(", ")}: ${trials} trials; waits alone take ${Math.round((waits * trials * (local ? 1 : models.length)) / 60_000)} min`,
  );
  if (!local) await requireIdleDeployment();
  const live = local ? undefined : session();
  const localRoot = local ? await mkdtemp(path.join(os.tmpdir(), "rakazo-measure-")) : undefined;
  const startedAt = new Date().toISOString();
  const threads: ThreadRecord[] = [];
  let written = Promise.resolve();
  const write = (status: "complete" | "partial") =>
    (written = written.then(() =>
      writeReceipt(path.join(values.out!, "token-cache.json"), {
        schemaVersion: 1,
        status,
        startedAt,
        generatedAt: new Date().toISOString(),
        harness: values.harness,
        worker: local
          ? "local memory guests in the controller process, one stable directory per thread"
          : "E2B worker VMs",
        guestSha256: values.guest
          ? createHash("sha256").update(readFileSync(values.guest)).digest("hex")
          : null,
        workerTemplate: values.template,
        computerTemplate: values["computer-template"],
        desktopPreparation: values["prepare-computer"]
          ? "product E2BSandboxProvider.prepare"
          : "skipped",
        provider: values.provider,
        models: models.map(({ id, api, baseUrl, cost }) => ({
          id,
          api,
          catalogBaseUrl: baseUrl,
          catalogCostPerMillion: cost,
        })),
        protocol: { ...protocol, comparable: trials >= 30 },
        order: local
          ? "one stream per model at once; each stream runs the scenarios in turn, one fresh controller and thread per trial"
          : "scenarios in turn; each trial runs every model on a fresh controller and thread, rotating which goes first; one thread at a time, its resources swept before the next",
        method: {
          source: "agent.worker.model_request at the controller relay, one per model request",
          inputTokens:
            "every prompt token, cached or not; uncached = input - cacheRead - cacheWrite",
          promptBytes:
            "UTF-8 bytes of the redacted canonical transcript (pi-ai-transcript-v1), not provider wire bytes",
          pricing: "catalog list price per million tokens, without long-context tiers",
          persistentEstimate:
            "one native session continuing every attempt from the previous full prompt and answer; generous: previous prompt counted cached whenever the projection read cache",
          restoreOutsideProvisioningMs:
            "grant to the resumed attempt's first model request, minus provider ensure to guest hello",
          transcriptAppend:
            "controller time and database queries from each transcript frame to its recorded reply",
        },
        summary: summarize(threads, models),
        threads,
      }),
    ));
  try {
    await measureTokens({
      models,
      protocol,
      upstream: { apiKey },
      provider: live
        ? () => live.workerProvider()
        : () => stableLocalWorkers(mkdtempSync(path.join(localRoot!, "thread-"))).provider,
      sandbox: live && (() => live.computer()),
      cleanup: live && (async () => (await live.sweep()).left),
      concurrentModels: local,
      onThread: async (thread) => {
        threads.push(thread);
        await write("partial");
        console.log(
          `${thread.scenario.padEnd(10)} ${thread.model.padEnd(24)} trial ${thread.trial}   ${thread.turns.map((turn) => turn.status).join(",")}${thread.left ? `   left ${thread.left.sandboxes} sandboxes, ${thread.left.volumes} volumes` : ""}`,
        );
      },
    });
    await write("complete");
  } finally {
    if (live) console.error(redact(JSON.stringify(await live.sweep())));
    if (localRoot) await rm(localRoot, { recursive: true, force: true });
  }
}

const commands: Record<string, () => Promise<void>> = { template, lanes, lane, bench, measure };
const run = command ? commands[command] : undefined;
if (!run) throw new Error(`usage: worker-live <${Object.keys(commands).join("|")}> [options]`);
await run();
// The SDK's keep-alive connections would hold the process open.
process.exit(0);
