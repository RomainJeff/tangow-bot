/**
 * Live P3 lanes against an E2B deployment. Needs E2B_API_KEY, and E2B_API_URL (with
 * E2B_SANDBOX_URL) or E2B_DOMAIN for a self-hosted one. Every resource it creates carries the
 * session's tag and is removed after each lane; receipts are redacted before they are written.
 *
 *   worker-live template --guest <agent-run-worker.mjs> --name <template>
 *   worker-live lanes --template <worker> --computer-template <computer> --out <dir> [--lanes a,b]
 *     Each lane runs in a child process: worker-live lane --lane <id> --template ...
 *   worker-live bench --template <worker> --computer-template <computer> --out <dir> [--trials 30]
 */
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { WORKER_PROFILE, workerTemplate } from "@rakazo/agent-run-worker/template";
import { type ConnectionOpts, Sandbox, Template } from "e2b";
import {
  benchLive,
  LANES,
  liveSession,
  memAvailableMiB,
  requireHeadroom,
} from "../worker-live/index.js";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    guest: { type: "string" },
    name: { type: "string" },
    harness: { type: "string", default: "pi" },
    template: { type: "string" },
    "computer-template": { type: "string" },
    out: { type: "string" },
    lanes: { type: "string" },
    lane: { type: "string" },
    trials: { type: "string", default: "30" },
  },
});

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error("E2B_API_KEY is not set");
const connection: ConnectionOpts = {
  apiKey,
  apiUrl: process.env.E2B_API_URL,
  domain: process.env.E2B_DOMAIN,
};

const SECRETS = [
  apiKey,
  process.env.E2B_API_URL,
  process.env.E2B_SANDBOX_URL,
  process.env.E2B_VOLUME_API_URL,
  process.env.E2B_DOMAIN,
  os.homedir(),
  os.userInfo().username,
  os.hostname(),
].filter((value): value is string => Boolean(value && value.length > 2));

/** Receipts name no key, endpoint, address, account, machine or local path. */
function redact(text: string): string {
  let clean = text;
  for (const secret of SECRETS) clean = clean.replaceAll(secret, "<redacted>");
  return clean.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "<ip>");
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
  if (!selected?.run) throw new Error(`No runnable lane ${values.lane}`);
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
    if (candidate.pending || !candidate.run) {
      records.push({ ...base, result: "pending", pending: candidate.pending });
      console.log(`lane ${candidate.id.padEnd(20)} PENDING`);
      continue;
    }
    await requireIdleDeployment();
    requireHeadroom();
    const child = fork(
      process.argv[1]!,
      [
        "lane",
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
    const result = await benchLive(live, trials);
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

const commands: Record<string, () => Promise<void>> = { template, lanes, lane, bench };
const run = command ? commands[command] : undefined;
if (!run) throw new Error(`usage: worker-live <${Object.keys(commands).join("|")}> [options]`);
await run();
// The SDK's keep-alive connections would hold the process open.
process.exit(0);
