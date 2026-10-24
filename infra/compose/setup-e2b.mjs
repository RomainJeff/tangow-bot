#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const overridePath = path.join(root, ".env.e2b.compose.json");
const envPath = path.join(root, ".env");
const composePath = path.join(root, "infra/compose/docker-compose.yml");
let apiKey = "";

function run(command, args, env = process.env, timeout) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
  if (result.error || result.status !== 0) {
    // Child output can include provider credentials or configuration. Keep failures local and generic.
    throw new Error(`${command} ${args[0] ?? ""} failed. Check tool access and configuration.`);
  }
  return result.stdout.trim();
}

function prompt(label, fallback, hidden = false) {
  let tty;
  try {
    tty = openSync("/dev/tty", "r+");
  } catch {
    if (fallback) return fallback;
    throw new Error(`${label} is required. Run in a terminal or provide it in the environment.`);
  }
  let settings;
  const restore = () => {
    if (settings) spawnSync("stty", [settings], { stdio: [tty, "ignore", "ignore"] });
  };
  const interrupt = () => {
    restore();
    process.exit(130);
  };
  try {
    if (hidden) {
      const state = spawnSync("stty", ["-g"], { stdio: [tty, "pipe", "pipe"], encoding: "utf8" });
      if (state.status !== 0) throw new Error("Cannot hide key entry on this terminal.");
      settings = state.stdout.trim();
      if (spawnSync("stty", ["-echo"], { stdio: [tty, "ignore", "ignore"] }).status !== 0)
        throw new Error("Cannot hide key entry on this terminal.");
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
    }
    writeSync(
      tty,
      `${label}${fallback ? (hidden ? " [Enter keeps saved key]" : ` [${fallback}]`) : ""}: `,
    );
    const bytes = [];
    const byte = Buffer.alloc(1);
    while (readSync(tty, byte, 0, 1, null) > 0 && byte[0] !== 10) bytes.push(byte[0]);
    if (hidden) writeSync(tty, "\n");
    return Buffer.from(bytes).toString("utf8").replace(/\r$/, "") || fallback;
  } finally {
    restore();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    closeSync(tty);
  }
}

function atomicWrite(filename, contents) {
  const temporary = `${filename}.tmp`;
  const file = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(file, contents);
    closeSync(file);
    renameSync(temporary, filename);
    chmodSync(filename, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      "computer-image": { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node infra/compose/setup-e2b.mjs --computer-image <registry>/<image>:<tag> [--dry-run]\nRun in the deployed checkout. Docker must be usable without sudo. Domain and hidden API key are requested interactively.",
    );
    return;
  }
  const image = values["computer-image"];
  if (
    !image ||
    image.startsWith("-") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*:[a-zA-Z0-9_.-]+$/.test(image) ||
    !image.includes("/")
  )
    throw new Error("Pass --computer-image <registry>/<image>:<tag> with push access.");
  if (values["dry-run"]) {
    console.log(
      `Dry run: check tools and deployed revision; request E2B domain and hidden key; probe volumes; build Pi worker; build/push ${image}; build desktop; write private Compose override; recreate api/worker; check health. No files, network calls or services changed.`,
    );
    return;
  }
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (
    !(
      (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) ||
      [24, 26].includes(major) ||
      major > 26
    )
  )
    throw new Error("Node 22.22.2+, 24, or 26+ is required.");
  if (!existsSync(envPath) || !existsSync(composePath))
    throw new Error("Run from a deployed source checkout with .env and source Compose.");
  run("pnpm", ["--version"]);
  run("docker", ["info"]);
  run("docker", ["compose", "version"]);
  const sha = run("git", ["rev-parse", "HEAD"]);
  run("git", [
    "diff",
    "--quiet",
    "HEAD",
    "--",
    "apps",
    "packages",
    "infra/sandboxes",
    "pnpm-lock.yaml",
  ]);
  const compose = ["compose", "--env-file", envPath, "-f", composePath];
  const hadOverride = existsSync(overridePath);
  const previous = hadOverride ? readFileSync(overridePath) : null;
  let previousData = {};
  try {
    if (previous) previousData = JSON.parse(previous.toString());
  } catch {
    throw new Error("Existing private Compose override is invalid JSON.");
  }
  const oldCompose = hadOverride ? [...compose, "-f", overridePath] : compose;
  const revisionFormat =
    '{{range .Config.Env}}{{if eq (index (split . "=") 0) "GIT_SHA"}}{{index (split . "=") 1}}{{end}}{{end}}';
  for (const service of ["api", "worker"]) {
    const id = run("docker", [...oldCompose, "ps", "-q", service]);
    if (
      !id ||
      id.includes("\n") ||
      run("docker", ["inspect", "--format", revisionFormat, id]) !== sha
    )
      throw new Error(
        `Running ${service} revision must match this checkout before template builds.`,
      );
  }
  const saved = previousData.services?.api?.environment ?? {};
  const env = { ...parseEnv(readFileSync(envPath, "utf8")), ...saved, ...process.env };
  const domain = prompt("E2B domain", env.E2B_DOMAIN ?? "").trim();
  if (!/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(domain))
    throw new Error("Enter an E2B hostname without scheme, port or path.");
  apiKey = prompt("E2B API key", env.E2B_API_KEY ?? "", true);
  if (!apiKey || /[\r\n\0]/.test(apiKey)) throw new Error("A single-line E2B API key is required.");
  if (Boolean(env.E2B_API_URL) !== Boolean(env.E2B_SANDBOX_URL))
    throw new Error("Custom endpoints require both E2B_API_URL and E2B_SANDBOX_URL.");
  const connection = { E2B_API_KEY: apiKey, E2B_DOMAIN: domain };
  for (const name of ["E2B_API_URL", "E2B_SANDBOX_URL"])
    if (env[name]) {
      const url = new URL(env[name]);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error(`Invalid ${name}.`);
      connection[name] = env[name];
    }
  const buildEnv = { ...process.env, ...connection };
  const workerTemplate = env.WORKER_TEMPLATE || "rakazo-worker-pi-native";
  console.log("Checking E2B API and volume access...");
  run(
    "pnpm",
    [
      "--filter",
      "@rakazo/computer-e2b-template",
      "exec",
      "node",
      "--input-type=module",
      "-e",
      'import { Volume } from "e2b"; await Volume.list();',
    ],
    buildEnv,
  );
  console.log("Building lightweight Pi worker template...");
  run(
    "pnpm",
    ["--filter", "@rakazo/agent-run-worker", "template:build", "--name", workerTemplate],
    buildEnv,
  );
  console.log("Building and pushing desktop computer image...");
  run("docker", ["build", "--platform", "linux/amd64", "-t", image, "infra/sandboxes/computer"]);
  run("docker", ["push", image]);
  const digest = run("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", image]);
  if (!/^[^\s]+@sha256:[a-f0-9]{64}$/.test(digest))
    throw new Error("Registry did not return an immutable image digest.");
  console.log("Building desktop E2B template...");
  run(
    "pnpm",
    ["--filter", "@rakazo/computer-e2b-template", "template:build", "--image", digest],
    buildEnv,
  );
  const environment = { ...connection, SANDBOX_PROVIDER: "e2b", WORKER_TEMPLATE: workerTemplate };
  const next = { services: { api: { environment }, worker: { environment } } };
  const nextCompose = [...compose, "-f", overridePath];
  const start = ["up", "-d", "--no-deps", "--pull", "never", "api", "worker"];
  console.log("Switching API and worker to E2B...");
  atomicWrite(overridePath, `${JSON.stringify(next, null, 2)}\n`);
  try {
    run("docker", [...nextCompose, "config", "--quiet"]);
    run("docker", [...nextCompose, ...start]);
    const check = `const response = await fetch('http://127.0.0.1:3100/health', { signal: AbortSignal.timeout(5000) }); const body = await response.json(); if (!response.ok || !body.ok || body.sandbox !== 'e2b' || body.revision !== '${sha}') process.exit(1);`;
    let healthy = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        run(
          "docker",
          [...nextCompose, "exec", "-T", "api", "node", "--input-type=module", "-e", check],
          process.env,
          10000,
        );
        const workerId = run("docker", [...nextCompose, "ps", "-q", "worker"]);
        if (
          !workerId ||
          run("docker", ["inspect", "--format", "{{.State.Running}}", workerId]) !== "true" ||
          !run("docker", [
            ...nextCompose,
            "logs",
            "--no-color",
            "--tail",
            "100",
            "worker",
          ]).includes("worker ready")
        )
          throw new Error("Worker is not ready.");
        healthy = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    if (!healthy) throw new Error("E2B API or worker readiness check failed.");
  } catch (error) {
    if (previous) atomicWrite(overridePath, previous);
    else rmSync(overridePath, { force: true });
    try {
      run("docker", [...oldCompose, ...start]);
    } catch {
      throw new Error(
        "Switch and configuration recovery failed. Configuration was restored; restart API and worker manually. Published templates are unchanged by recovery.",
      );
    }
    throw new Error(
      `${error.message} Previous application configuration restored. Published template builds are not rolled back.`,
    );
  }
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  console.log(
    `E2B configured. Keep using this Compose command:\ndocker ${nextCompose.map(quote).join(" ")} up -d --pull never\nExisting homes are not migrated. Open a bot computer and verify a worker run before considering E2B fully validated. See docs/self-host-e2b-workers.md.`,
  );
}

main().catch((error) => {
  const message = apiKey ? error.message.replaceAll(apiKey, "[redacted]") : error.message;
  console.error(`E2B setup failed: ${message}`);
  process.exitCode = 1;
});
