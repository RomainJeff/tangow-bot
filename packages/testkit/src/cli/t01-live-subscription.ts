import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import type {
  AdapterContext,
  AgentRunRequest,
  ComputerRef,
  NativeProcess,
} from "@rakazo/adapter-kit";
import type { SandboxProvider } from "@rakazo/adapters";
import { CodexNativeRuntime, DockerSandboxProvider } from "@rakazo/adapters";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { listSpaceRuns } from "../../../../apps/api/src/runs.ts";
import { stopAndClearParkedCodexRuntimeForTest } from "../../../adapters/src/computer-native-runtime.ts";
import { sessionCookieHeader } from "../index.ts";
import {
  createT01ReplayIntent,
  loadT01ReplayState,
  ownedT01ResourceLabels,
  reapT01ReplayState,
  teardownT01ReplayState,
  updateT01ReplayIntent,
  updateT01ReplaySecrets,
  withT01ReplayLock,
} from "./t01-replay-state.ts";

const live = process.argv.includes("--live");
const provisionReplay = process.argv.includes("--provision-replay");
const replay = process.argv.includes("--replay");
const teardownReplay = process.argv.includes("--teardown-replay");
const reapReplay = process.argv.includes("--reap-replay");
const probeNative = process.argv.includes("--probe-native");
const probeDelegate = process.argv.includes("--probe-delegate");
const replayStateDirectory = process.env.RAKAZO_T01_REPLAY_STATE_DIR;
const image = process.env.RAKAZO_T01_LIVE_IMAGE ?? "rakazo-t01-terra/computer-codex-0.154.0:local";
const modelId = process.env.RAKAZO_T01_LIVE_MODEL_ID;
export const LIVE_OAUTH_LOCAL_TIMEOUT_MS = 15 * 60 * 1000;
export const LIVE_OPERATION_TIMEOUT_MS = 120 * 1000;
export const T01_REPLAY_TTL_MS = 30 * 60 * 1000;

type SpecialistRunDelivery = {
  status: string;
  error: string | null;
  terminalOutcome: string | null;
  terminalReturnDelivery: string | null;
};

type TerminalRun = { status: string };

export async function waitForTerminalRun<T extends TerminalRun>(
  read: () => Promise<T | undefined>,
  input: {
    delay?: () => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): Promise<T | undefined> {
  const now = input.now ?? Date.now;
  const deadline = now() + (input.timeoutMs ?? 120_000);
  const delay = input.delay ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  let observed = await read();
  while (
    (!observed || ["queued", "leased", "running"].includes(observed.status)) &&
    now() < deadline
  ) {
    await delay();
    observed = await read();
  }
  return observed;
}

export async function waitForSpecialistReturnDelivery(
  read: () => Promise<SpecialistRunDelivery>,
  input: {
    delay?: () => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): Promise<SpecialistRunDelivery> {
  const now = input.now ?? Date.now;
  const deadline = now() + (input.timeoutMs ?? 120_000);
  const delay = input.delay ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  let observed = await read();
  while (
    (["queued", "leased", "running"].includes(observed.status) ||
      observed.terminalReturnDelivery !== "delivered") &&
    now() < deadline
  ) {
    await delay();
    observed = await read();
  }
  return observed;
}

if (
  [replay, teardownReplay, reapReplay, probeNative, probeDelegate].filter(Boolean).length > 1 ||
  ((replay || teardownReplay || reapReplay || probeNative) && live)
)
  throw new Error("Replay and teardown modes cannot be combined with another T01 runner mode.");
if ((provisionReplay || replay || teardownReplay || reapReplay) && !replayStateDirectory)
  throw new Error("RAKAZO_T01_REPLAY_STATE_DIR is required for replay lifecycle modes.");

function ipv4ToNumber(value: string): number | undefined {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return undefined;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function cidrBounds(cidr: string): { start: number; end: number } | undefined {
  const [address, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);
  const ip = address ? ipv4ToNumber(address) : undefined;
  if (ip === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return undefined;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = (ip & mask) >>> 0;
  return { start, end: (start | (~mask >>> 0)) >>> 0 };
}

export function cidrsOverlap(left: string, right: string): boolean {
  const leftBounds = cidrBounds(left);
  const rightBounds = cidrBounds(right);
  return (
    !!leftBounds &&
    !!rightBounds &&
    leftBounds.start <= rightBounds.end &&
    rightBounds.start <= leftBounds.end
  );
}

function hostRouteCidrs(): string[] {
  const routes = JSON.parse(
    execFileSync("ip", ["-j", "route", "show"], { encoding: "utf8" }),
  ) as Array<{ dst?: unknown }>;
  return routes
    .map((route) => route.dst)
    .filter((dst): dst is string => typeof dst === "string" && dst !== "default")
    .filter((dst) => cidrBounds(dst) !== undefined);
}

function dockerNetworkCidrs(): string[] {
  const ids = execFileSync("docker", ["network", "ls", "-q"], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length === 0) return [];
  const networks = JSON.parse(
    execFileSync("docker", ["network", "inspect", ...ids], {
      encoding: "utf8",
    }),
  ) as Array<{ IPAM?: { Config?: Array<{ Subnet?: unknown }> } }>;
  return networks
    .flatMap((network) => network.IPAM?.Config ?? [])
    .map((config) => config.Subnet)
    .filter(
      (subnet): subnet is string => typeof subnet === "string" && cidrBounds(subnet) !== undefined,
    );
}

function createDedicatedTestNetwork(name: string, ownerId?: string) {
  const forbiddenCidrs = [...hostRouteCidrs(), ...dockerNetworkCidrs()];
  for (let octet = 0; octet < 256; octet += 1) {
    const subnet = `10.254.${octet}.0/24`;
    if (forbiddenCidrs.some((cidr) => cidrsOverlap(subnet, cidr))) continue;
    try {
      execFileSync(
        "docker",
        [
          "network",
          "create",
          "--driver",
          "bridge",
          "--subnet",
          subnet,
          "--label",
          "rakazo.t01.scope=isolated",
          "--label",
          "rakazo.t01.runner=live-subscription",
          ...(ownerId ? ["--label", `rakazo.t01.owner=${ownerId}`] : []),
          name,
        ],
        { encoding: "utf8" },
      );
      return { name, subnet };
    } catch {
      // Docker rejects overlap with existing daemon networks; try only another route-safe subnet.
    }
  }
  throw new Error("No verified isolated Docker subnet is available for T01.");
}

type T01Postgres = {
  getConnectionUri(): string;
  stop(): Promise<void>;
  containerName?: string;
};

async function startPersistentT01Postgres(ownerId: string): Promise<T01Postgres> {
  const containerName = `rakazo-t01-postgres-${ownerId}`;
  const password = randomUUID();
  const labels = ownedT01ResourceLabels(ownerId).flatMap((label) => ["--label", label]);
  execFileSync(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      containerName,
      ...labels,
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "--env",
      "POSTGRES_DB=t01",
      "--publish",
      "127.0.0.1::5432",
      "postgres:16-alpine",
    ],
    { stdio: "ignore" },
  );
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      execFileSync("docker", ["exec", containerName, "pg_isready", "-U", "postgres", "-d", "t01"], {
        stdio: "ignore",
      });
      const info = JSON.parse(
        execFileSync("docker", ["container", "inspect", containerName], {
          encoding: "utf8",
        }),
      ) as Array<{
        NetworkSettings?: {
          Ports?: Record<string, Array<{ HostPort?: string }> | null>;
        };
      }>;
      const port = info[0]?.NetworkSettings?.Ports?.["5432/tcp"]?.[0]?.HostPort;
      if (!port) throw new Error("T01 persistent PostgreSQL has no loopback port.");
      return {
        containerName,
        getConnectionUri: () =>
          `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/t01`,
        stop: async () => {
          execFileSync("docker", ["rm", "-f", containerName], {
            stdio: "ignore",
          });
        },
      };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
  throw new Error("T01 persistent PostgreSQL did not become ready.");
}

function assertDedicatedNetworkMembership(network: { name: string }, containerName: string): void {
  const inspectedNetwork = JSON.parse(
    execFileSync("docker", ["network", "inspect", network.name], {
      encoding: "utf8",
    }),
  ) as Array<{ Containers?: Record<string, { Name?: string }> }>;
  const members = Object.values(inspectedNetwork[0]?.Containers ?? {});
  if (members.length !== 1 || members[0]?.Name !== containerName)
    throw new Error("T01 dedicated network contains an unexpected container.");
  const inspectedContainer = JSON.parse(
    execFileSync("docker", ["container", "inspect", containerName], {
      encoding: "utf8",
    }),
  ) as Array<{ NetworkSettings?: { Networks?: Record<string, unknown> } }>;
  const networks = Object.keys(inspectedContainer[0]?.NetworkSettings?.Networks ?? {});
  if (networks.length !== 1 || networks[0] !== network.name)
    throw new Error("T01 Computer is attached outside its dedicated network.");
}

function dockerNetworkExists(name: string): boolean {
  try {
    execFileSync("docker", ["network", "inspect", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function labelsForDockerResource(kind: "container" | "network", name: string): string[] {
  const inspected = JSON.parse(
    execFileSync("docker", [kind, "inspect", name], { encoding: "utf8" }),
  ) as Array<{
    Config?: { Labels?: Record<string, string> };
    Labels?: Record<string, string>;
  }>;
  return Object.entries(inspected[0]?.Config?.Labels ?? inspected[0]?.Labels ?? {}).map(
    ([key, value]) => `${key}=${value}`,
  );
}

async function teardownReplayFromPrivateState(directory: string): Promise<void> {
  const state = await loadT01ReplayState(directory, Date.now(), {
    allowExpired: true,
  });
  await teardownT01ReplayState({
    state,
    labelsForContainer: async (name) => labelsForDockerResource("container", name),
    labelsForNetwork: async (name) => labelsForDockerResource("network", name),
    removeContainer: async (name) => {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    },
    removeNetwork: async (name) => {
      execFileSync("docker", ["network", "rm", name], { stdio: "ignore" });
    },
  });
}

async function reapReplayFromPrivateState(directory: string): Promise<void> {
  const state = await loadT01ReplayState(directory, Date.now(), {
    allowExpired: true,
  });
  const list = (kind: "container" | "network", ownerId: string): string[] =>
    execFileSync("docker", [kind, "ls", "-q", "--filter", `label=rakazo.t01.owner=${ownerId}`], {
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  await reapT01ReplayState({
    state,
    listContainers: async (ownerId) => list("container", ownerId),
    listNetworks: async (ownerId) => list("network", ownerId),
    labelsForContainer: async (name) => labelsForDockerResource("container", name),
    labelsForNetwork: async (name) => labelsForDockerResource("network", name),
    removeContainer: async (name) => {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    },
    removeNetwork: async (name) => {
      execFileSync("docker", ["network", "rm", name], { stdio: "ignore" });
    },
  });
}

export function cleanupDedicatedDockerResources(input: {
  containerName?: string;
  networkName: string;
  removeContainer: (name: string) => void;
  networkExists: (name: string) => boolean;
  removeNetwork: (name: string) => void;
}): string[] {
  const errors: string[] = [];
  if (input.containerName) {
    try {
      input.removeContainer(input.containerName);
    } catch {
      errors.push("dedicated container cleanup failed");
    }
  }
  if (input.networkExists(input.networkName)) {
    try {
      input.removeNetwork(input.networkName);
    } catch {
      errors.push("dedicated network cleanup failed");
    }
  }
  return errors;
}

if (live && !modelId) throw new Error("RAKAZO_T01_LIVE_MODEL_ID is required with --live");

const codexErrorCategories = new Set([
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "usageLimitExceeded",
  "rateLimitExceeded",
  "serverOverloaded",
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "internalServerError",
  "unauthorized",
  "badRequest",
  "threadRollbackFailed",
  "sandboxError",
  "other",
]);

function nativeErrorCategory(value: unknown): string | undefined {
  if (typeof value === "string" && codexErrorCategories.has(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  for (const key of [
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
    "activeTurnNotSteerable",
  ]) {
    if (key in value) return key;
  }
  return undefined;
}

export function classifyRuntimeFailure(value: unknown): string {
  if (typeof value !== "string") return "unclassified";
  if (
    value.toLowerCase().includes("auth") ||
    value.toLowerCase().includes("credential") ||
    value.toLowerCase().includes("login") ||
    value.toLowerCase().includes("connected chatgpt subscription")
  )
    return "authentication";
  if (value.startsWith("codex thread/start response missing native thread id"))
    return "thread_start_missing_id";
  if (value.startsWith("codex response id mismatch")) return "response_id_mismatch";
  if (value.startsWith("codex app-server ended before response"))
    return "process_ended_before_response";
  if (value.startsWith("codex app-server ended before turn completion"))
    return "process_ended_before_turn_completion";
  if (value.startsWith("codex turn completed with non-success status: failed"))
    return "turn_failed";
  if (value.startsWith("codex turn completed with non-success status: interrupted"))
    return "turn_interrupted";
  return "unclassified";
}

/** The scripted coordinator fixture is selected by the bot known before any run dispatch. */
export function isJ2ScriptedCoordinatorRun(botId: string, coordinatorBotId: string | undefined) {
  return coordinatorBotId !== undefined && botId === coordinatorBotId;
}

export function isJ2WorkReturnWakePrompt(prompt: string): boolean {
  return prompt.includes("UNTRUSTED SPECIALIST OUTPUT");
}

/** The J2 driver, not its scripted coordinator, controls the post-return path. */
export function j2WakeScriptedResponse(prompt: string): { type: "done"; text: string } | undefined {
  if (!isJ2WorkReturnWakePrompt(prompt)) return undefined;
  return { type: "done", text: "J2 wake acknowledged" };
}

function redactJ2CoordinatorError(value: unknown): string {
  return String(value ?? "unknown")
    .replace(/eyJ[A-Za-z0-9._-]*/g, "<jwt>")
    .replace(/token[\s\S]*/gi, "token<redacted>")
    .replace(/accountId(?:["']?\s*[:=]\s*["']?|\s+)[^,\s}"']+/gi, "accountId<redacted>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/postgres:\/\/\S+/gi, "<postgres-url>")
    .replace(/\b[a-zA-Z0-9_-]{20,}\b/g, "<identifier>")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

export function j2WorkReturnText(
  messages: Array<{ runId?: string; blocks?: unknown }>,
  runId: string,
): string | undefined {
  const message = messages.find((entry) => entry.runId === runId);
  if (!message || !Array.isArray(message.blocks)) return undefined;
  const text = message.blocks
    .filter(
      (block): block is { kind: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        "kind" in block &&
        "text" in block &&
        (block as { kind?: unknown }).kind === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join(" ");
  return text || undefined;
}

function redactJ2WorkReturnText(text: string, codeword?: string): string {
  return redactJ2CoordinatorError(codeword ? text.replaceAll(codeword, "<codeword>") : text);
}

export async function sandboxCommandOutput(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  argv: string[],
  context: AdapterContext,
  timeoutMs = 10_000,
): Promise<{ code: number; stdout: string }> {
  return withFreshOperationSignal(async (signal) => {
    let stdout = "";
    let code: number | undefined;
    for await (const event of sandbox.execute(
      computer,
      { argv, cwd: "", timeoutMs },
      { ...context, signal },
    )) {
      if (event.type === "stdout") stdout += event.data;
      if (event.type === "exit") code = event.code;
    }
    if (code === undefined) throw new Error("J2 Computer command did not exit");
    return { code, stdout };
  }, timeoutMs);
}

async function j2ParkedCodexPids(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<string[]> {
  const result = await sandboxCommandOutput(
    sandbox,
    computer,
    ["sh", "-c", "ps -eo pid=,args= | awk '/[c]odex app-server --listen stdio:\\/\\// {print $1}'"],
    context,
  );
  if (result.code !== 0) throw new Error("J2 could not inspect the parked Codex PID");
  const pids = result.stdout
    .trim()
    .split(/\s+/)
    .filter((pid) => /^\d+$/.test(pid));
  if (pids.length === 0) throw new Error("J2 parked Codex PID was not found");
  return pids;
}

async function j2AssertPidsGone(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  pids: string[],
  context: AdapterContext,
): Promise<void> {
  const result = await sandboxCommandOutput(
    sandbox,
    computer,
    ["sh", "-c", 'for pid; do test ! -d "/proc/$pid" || exit 1; done', "sh", ...pids],
    context,
  );
  if (result.code !== 0) throw new Error("J2 parked Codex PID still exists in /proc");
}

export function createNativeProbeRequest(input: {
  botId: string;
  computerId: string;
  runId: string;
}): AgentRunRequest {
  return {
    botId: input.botId,
    threadId: "probe-thread",
    runId: input.runId,
    prompt: "T01 native probe",
    instructions: "",
    history: [],
    tools: [],
    model: {
      provider: "openai-codex",
      id: "gpt-5.6-terra",
      oauth: {
        credential: {
          type: "oauth",
          access: "probe-not-a-jwt",
          refresh: "probe-refresh",
          expires: 0,
          accountId: "probe",
        },
        refresh: async () => {
          throw new Error("probe OAuth refresh is disabled");
        },
      },
    },
    execution: {
      choice: { harness: "codex-native", targetId: input.computerId },
      authority: {
        runId: input.runId,
        attemptId: "probe",
        fence: 0,
        policyRevision: 0,
      },
      continuity: { mode: "new" },
      computerId: input.computerId,
      contextRevision: 0,
    },
  };
}

export function classifyNativeProbeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("failed to set external auth")) return "expected_fake_auth_rejection";
  if (message.startsWith("codex app-server ended before response"))
    return "ended_before_initialize_response";
  return "unexpected";
}

function redactProbeText(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]+/g, "<jwt>")
    .split("\n")
    .map((line) => line.replace(/(token).*$/i, "$1<redacted>"))
    .join("\n")
    .slice(-4_096);
}

const initializeMessage = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "rakazo", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  },
})}\n`;

async function probeSupervisorInitialize(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  receipt: string[],
): Promise<void> {
  const home = `/tmp/rakazo-codex-${randomUUID()}`;
  const process = await sandbox.startNativeProcess!(
    computer,
    {
      argv: ["codex", "app-server", "--listen", "stdio://"],
      cwd: "",
      privateHome: home,
      env: {
        CI: "1",
        OPENAI_API_KEY: "",
        CODEX_HOME: home,
      },
    },
    context,
  );
  const lines = process.stdout[Symbol.asyncIterator]();
  await process.write(initializeMessage);
  let response = false;
  try {
    const item = await Promise.race([
      lines.next(),
      new Promise<IteratorResult<string>>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 20_000),
      ),
    ]);
    if (!item.done) response = (JSON.parse(item.value) as { id?: unknown }).id === 1;
  } catch {
    // The bounded terminal fact below is the only retained error observation.
  }
  receipt.push(`E3_B_INITIALIZE_RESPONSE=${response ? "yes" : "no"}`);
  await process.stop();
  const outcome = await process.wait();
  receipt.push(`E3_B_EXIT_CODE=${outcome.code ?? "unknown"}`);
  receipt.push(`E3_B_EXIT_SOURCE=${outcome.exitSource ?? "unknown"}`);
}

async function probeDirectInitialize(
  containerName: string,
  home: string,
  label: string,
  receipt: string[],
): Promise<void> {
  const startedAt = Date.now();
  const child = spawn(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "CI=1",
      "-e",
      "OPENAI_API_KEY=",
      "-e",
      `CODEX_HOME=${home}`,
      containerName,
      "sh",
      "-lc",
      'umask 077; mkdir -p -m 700 "$CODEX_HOME"; exec codex app-server --listen stdio://',
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = `${stdout}${chunk}`.slice(-4_096);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });
  child.stdin.write(initializeMessage);
  await new Promise((resolve) => setTimeout(resolve, 20_000));
  child.stdin.end();
  const code = await new Promise<number | null>((resolve) =>
    child.once("close", (value) => resolve(value)),
  );
  let response = false;
  try {
    response = (JSON.parse(stdout.split("\n").find(Boolean) ?? "") as { id?: unknown }).id === 1;
  } catch {
    // Native stdout is intentionally not retained.
  }
  receipt.push(`E3_${label}_INITIALIZE_RESPONSE=${response ? "yes" : "no"}`);
  receipt.push(`E3_${label}_EXIT_CODE=${code ?? "unknown"}`);
  receipt.push(`E3_${label}_ELAPSED_MS=${Date.now() - startedAt}`);
  if (stderr) receipt.push(`E3_${label}_STDERR=${redactProbeText(stderr)}`);
}

/** Emit only the allowlisted receipt facts collected before a replay failure. */
export function reportReplayFailure(
  receipt: readonly string[],
  write: (line: string) => void = console.log,
): void {
  if (receipt.length > 0) write(receipt.join("\n"));
}

/** Keep the receipt-before-throw ordering explicit at the replay error seam. */
export function throwReplayFailure(
  receipt: readonly string[],
  error: unknown,
  write: (line: string) => void = console.log,
): never {
  reportReplayFailure(receipt, write);
  throw error;
}

export function auditSandbox(delegate: SandboxProvider, receipt: string[]): SandboxProvider {
  return new Proxy(delegate, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "startNativeProcess" || typeof value !== "function")
        return typeof value === "function" ? value.bind(target) : value;
      return async (...args: Parameters<NonNullable<SandboxProvider["startNativeProcess"]>>) => {
        const process = (await value.call(target, ...args)) as NativeProcess;
        const requests = new Map<string | number, string>();
        let exitRecorded = false;
        let lastNotification = "none";
        let agentMessageDeltas = 0;
        return {
          ...process,
          write: async (data: string) => {
            try {
              const message = JSON.parse(data) as {
                id?: unknown;
                method?: unknown;
              };
              if (
                typeof message.method === "string" &&
                (typeof message.id === "string" || typeof message.id === "number")
              )
                requests.set(message.id, message.method);
              if (
                message.method === "account/login/start" ||
                message.method === "thread/start" ||
                message.method === "thread/resume" ||
                message.method === "turn/start"
              )
                receipt.push(`NATIVE_OUTBOUND_METHOD=${message.method}`);
            } catch {
              // The native protocol owns malformed-input handling; do not log its payload.
            }
            await process.write(data);
          },
          wait: async () => {
            const outcome = await process.wait();
            if (!exitRecorded) {
              exitRecorded = true;
              receipt.push(`NATIVE_PROCESS_EXIT_CODE=${outcome.code ?? "unknown"}`);
              receipt.push(`NATIVE_PROCESS_EXIT_SOURCE=${outcome.exitSource ?? "unknown"}`);
              if (outcome.stderr) {
                receipt.push(`NATIVE_STDERR_PRESENT=${outcome.stderr.present ? "yes" : "no"}`);
                if (outcome.stderr.category)
                  receipt.push(`NATIVE_STDERR_CATEGORY=${outcome.stderr.category}`);
              }
            }
            return outcome;
          },
          stdout: (async function* () {
            try {
              for await (const line of process.stdout) {
                try {
                  const message = JSON.parse(line) as {
                    id?: unknown;
                    method?: unknown;
                    error?: { code?: unknown; message?: unknown };
                    result?: { turn?: { status?: unknown } };
                    params?: {
                      error?: { codexErrorInfo?: unknown };
                      turn?: {
                        status?: unknown;
                        error?: { codexErrorInfo?: unknown };
                      };
                    };
                  };
                  const method =
                    typeof message.id === "string" || typeof message.id === "number"
                      ? requests.get(message.id)
                      : undefined;
                  if (method && typeof message.error?.code === "number") {
                    receipt.push(`NATIVE_RPC_ERROR_METHOD=${method} CODE=${message.error.code}`);
                    if (method.startsWith("thread/") || method.startsWith("turn/")) {
                      receipt.push(
                        `NATIVE_RPC_ERROR_CATEGORY=${message.error.code === -32600 ? "invalid_request" : "rpc_error"}`,
                      );
                      receipt.push(
                        `NATIVE_RPC_ERROR_MESSAGE=${redactJ2CoordinatorError(message.error.message)}`,
                      );
                    }
                  }
                  if (message.id === 2 && !message.error)
                    receipt.push("NATIVE_LOGIN_RESPONSE=id:2 received");
                  if (
                    (method === "thread/start" || method === "turn/start") &&
                    message.result !== undefined &&
                    !message.error
                  )
                    receipt.push(`NATIVE_RESPONSE_METHOD=${method}`);
                  if (method === "turn/start" && message.result !== undefined && !message.error) {
                    const status = message.result.turn?.status;
                    receipt.push(
                      `NATIVE_TURN_START_STATUS=${status === "inProgress" || status === "completed" || status === "failed" || status === "interrupted" ? status : "unknown"}`,
                    );
                  }
                  if (message.method === "turn/started") {
                    lastNotification = "turn/started";
                    receipt.push("NATIVE_EVENT=turn/started");
                  }
                  if (message.method === "error") {
                    lastNotification = "error";
                    receipt.push("NATIVE_EVENT=error");
                    const category = nativeErrorCategory(message.params?.error?.codexErrorInfo);
                    if (category) receipt.push(`NATIVE_ERROR_CATEGORY=${category}`);
                  }
                  if (message.method === "turn/completed") {
                    lastNotification = "turn/completed";
                    const status = message.params?.turn?.status;
                    if (status === "completed")
                      receipt.push("NATIVE_TURN_COMPLETED=status:completed");
                    if (status === "failed" || status === "interrupted")
                      receipt.push(`NATIVE_TURN_COMPLETED_STATUS=${status}`);
                    const category = nativeErrorCategory(
                      message.params?.turn?.error?.codexErrorInfo,
                    );
                    if (category) receipt.push(`NATIVE_TURN_ERROR_CATEGORY=${category}`);
                  }
                  if (message.method === "item/agentMessage/delta") {
                    lastNotification = "item/agentMessage/delta";
                    agentMessageDeltas += 1;
                  }
                } catch {
                  // Do not persist native output; only allowlisted protocol facts are retained.
                }
                yield line;
              }
            } finally {
              receipt.push(`NATIVE_AGENT_MESSAGE_DELTAS=${agentMessageDeltas}`);
              receipt.push(`LAST_NATIVE_NOTIFICATION=${lastNotification}`);
            }
          })(),
        };
      };
    },
  }) as SandboxProvider;
}

export async function waitForOAuthReady(
  complete: (
    signal: AbortSignal,
  ) => Promise<{ status: "pending" | "ready" | "error"; error?: string }>,
  expiresInSeconds: number | undefined,
  options: {
    signal?: AbortSignal;
    localTimeoutMs?: number;
    delay?: (signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<void> {
  const providerTimeoutMs = Math.max(1, expiresInSeconds ?? 0) * 1000;
  const timeoutMs = Math.min(
    providerTimeoutMs,
    options.localTimeoutMs ?? LIVE_OAUTH_LOCAL_TIMEOUT_MS,
  );
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new Error("OAuth device code expired before sign-in completed.")),
    timeoutMs,
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal;
  const delay =
    options.delay ??
    ((current) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2_000);
        current.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(current.reason);
          },
          { once: true },
        );
      }));
  try {
    for (;;) {
      signal.throwIfAborted();
      const state = await complete(signal);
      signal.throwIfAborted();
      if (state.status === "ready") return;
      if (state.status === "error") throw new Error(state.error ?? "OAuth sign-in failed.");
      await delay(signal);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function withFreshOperationSignal<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = LIVE_OPERATION_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("T01 operation timed out.")),
    timeoutMs,
  );
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function finishOAuthAfterReady<T>(
  finish: (signal: AbortSignal) => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  return withFreshOperationSignal(finish, timeoutMs);
}

async function replayT01LiveState(directory: string): Promise<void> {
  const state = await loadT01ReplayState(directory);
  const { botId, computerId, spaceId, userId } = state.manifest.records;
  if (!botId || !computerId || !spaceId || !userId)
    throw new Error("T01 replay state is incomplete; run reap or finish provisioning first.");
  const receipt: string[] = [];
  let supervisor: ReturnType<typeof serve> | undefined;
  let handles:
    | Awaited<ReturnType<typeof import("../../../../apps/api/src/app.ts")["createApp"]>>
    | undefined;
  try {
    process.env.DATA_DIR = path.join(directory, "data");
    process.env.RAKAZO_COMPUTER_IMAGE = image;
    process.env.SANDBOX_SUPERVISOR_TOKEN = state.secrets.supervisorToken;
    process.env.SANDBOX_PROVIDER = "docker";
    process.env.SANDBOX_SCREEN_NETWORK = "published";
    process.env.DATABASE_URL = state.secrets.databaseUrl;
    process.env.REALTIME_DATABASE_URL = state.secrets.databaseUrl;
    const { supervisorApp } = await import("../../../../infra/sandboxes/supervisor/src/index.ts");
    supervisor = serve({
      fetch: supervisorApp.fetch,
      hostname: "127.0.0.1",
      port: 0,
    });
    if (!supervisor.listening)
      await new Promise<void>((resolve, reject) => {
        supervisor!.once("listening", resolve);
        supervisor!.once("error", reject);
      });
    const supervisorUrl = `http://127.0.0.1:${(supervisor.address() as AddressInfo).port}`;
    const sandbox = auditSandbox(
      new DockerSandboxProvider(supervisorUrl, state.secrets.supervisorToken),
      receipt,
    );
    const { createApp } = await import("../../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: state.secrets.databaseUrl,
      realtimeDatabaseUrl: state.secrets.databaseUrl,
      authUrl: "http://127.0.0.1",
      webOrigin: "http://127.0.0.1",
      dataDir: path.join(directory, "data"),
      sandboxProvider: "docker",
      sandbox,
      wakeupDriver: "memory",
      agentRuntime: "scripted",
      signupsEnabled: "true",
      encryptionKey: state.secrets.encryptionKey,
    });
    const signedIn = await handles.app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1",
      },
      body: JSON.stringify({
        email: state.secrets.testUserEmail,
        password: state.secrets.testUserPassword,
      }),
    });
    const cookie = sessionCookieHeader(signedIn);
    const rpc = async <T>(procedure: string, input: unknown, signal?: AbortSignal): Promise<T> => {
      const response = await handles!.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1",
          cookie,
        },
        body: JSON.stringify({ json: input }),
        signal,
      });
      const body = (await response.json()) as {
        json?: T;
        error?: { message?: string };
      };
      if (!response.ok || body.error) throw new Error(body.error?.message ?? `${procedure} failed`);
      return body.json as T;
    };
    const stored = await handles.prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      include: { computer: true },
    });
    if (!stored.computer || stored.computer.id !== computerId)
      throw new Error("T01 replay state does not own the recorded Computer.");
    const computer = {
      id: stored.computer.id,
      providerRef: stored.computer.providerRef ?? stored.computer.id,
      botId: stored.computer.homeKey,
      kind: "docker" as const,
    };
    const sent = await rpc<{ runId: string }>("threads/send", {
      botId: stored.id,
      text: "Reply exactly T01 live subscription smoke test.",
      harness: "codex-native",
      executionTarget: computer.id,
    });
    await handles.executor.continueRun(sent.runId, "t01-replay");
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const actor = { userId, spaceId };
      const runs = await listSpaceRuns(handles.prisma, actor, "recent");
      const run = runs.find((entry) => entry.runId === sent.runId);
      if (run?.status === "completed") {
        receipt.push("PUBLIC_RUN_STATUS=completed");
        break;
      }
      if (run?.status === "failed") {
        receipt.push("PUBLIC_RUN_STATUS=failed");
        const failed = await handles.prisma.run.findUnique({
          where: { id: sent.runId },
          select: { error: true },
        });
        receipt.push(`RUNTIME_FAILURE_CATEGORY=${classifyRuntimeFailure(failed?.error)}`);
        throw new Error("Native replay run failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!receipt.includes("PUBLIC_RUN_STATUS=completed"))
      throw new Error("Timed out waiting for replay completion");
    console.log(receipt.join("\n"));
  } catch (error) {
    throwReplayFailure(receipt, error);
  } finally {
    await handles?.stop();
    if (supervisor) await new Promise<void>((resolve) => supervisor!.close(() => resolve()));
  }
}

export async function main() {
  if (provisionReplay || replay || teardownReplay || reapReplay)
    return withT01ReplayLock(replayStateDirectory!, mainUnlocked);
  return mainUnlocked();
}

async function mainUnlocked() {
  const outcome = { cleanupFailed: false };
  await runUnlocked(outcome);
  if (outcome.cleanupFailed) throw new Error("T01 isolated cleanup failed.");
}

async function runUnlocked(outcome: { cleanupFailed: boolean }) {
  if (teardownReplay) {
    await teardownReplayFromPrivateState(replayStateDirectory!);
    console.log("T01_REPLAY_TEARDOWN=completed");
    return;
  }
  if (reapReplay) {
    await reapReplayFromPrivateState(replayStateDirectory!);
    console.log("T01_REPLAY_REAP=completed");
    return;
  }
  if (replay) {
    await replayT01LiveState(replayStateDirectory!);
    return;
  }
  let primaryError: unknown;
  const replayOwnerId = provisionReplay ? randomUUID() : undefined;
  const root = provisionReplay
    ? replayStateDirectory!
    : await mkdtemp(path.join(tmpdir(), "rakazo-t01-live-"));
  const dataDir = path.join(root, "data");
  const receipt: string[] = [];
  const token = `t01-${randomUUID()}`;
  const testUserEmail = `t01-${randomUUID()}@example.test`;
  const testUserPassword = `t01-${randomUUID()}`;
  let replayState = provisionReplay
    ? await createT01ReplayIntent({
        directory: root,
        ownerId: replayOwnerId!,
        expiresAt: Date.now() + T01_REPLAY_TTL_MS,
        secrets: {
          databaseUrl: "",
          supervisorToken: token,
          encryptionKey: "t01-live-isolated-encryption-key",
          testUserEmail,
          testUserPassword,
        },
      })
    : undefined;
  const postgres: T01Postgres = provisionReplay
    ? await startPersistentT01Postgres(replayOwnerId!)
    : await new PostgreSqlContainer("postgres:16-alpine").start();
  if (replayState)
    replayState = await updateT01ReplaySecrets(replayState, {
      ...replayState.secrets,
      databaseUrl: postgres.getConnectionUri(),
    });
  if (replayState)
    replayState = await updateT01ReplayIntent(replayState, {
      resources: { databaseContainerName: postgres.containerName! },
      records: {},
    });
  let preserveReplayResources = false;
  let supervisor: ReturnType<typeof serve> | undefined;
  let handles:
    | Awaited<ReturnType<typeof import("../../../../apps/api/src/app.ts")["createApp"]>>
    | undefined;
  let computer: { id: string; providerRef: string; botId: string; kind: "docker" } | undefined;
  let computerSpec: typeof import("../../../../infra/sandboxes/supervisor/src/computer-spec.ts");
  let dedicatedNetwork: { name: string; subnet: string } | undefined;
  let computerContainerName: string | undefined;
  let context:
    | {
        operationId: string;
        traceId: string;
        spaceId: string;
        userId: string;
        botId: string;
        signal: AbortSignal;
      }
    | undefined;
  let j2CoordinatorId: string | undefined;
  let j2ProfileId: string | undefined;
  let j2SpecialistId: string | undefined;
  let j2SpecialistRuntime: "codex-native" | "scripted" | undefined;
  let j2MissionComputerId: string | undefined;
  let j2FollowupRunId: string | undefined;
  let j2Codeword: string | undefined;
  let j2CoordinatorStarted = false;
  try {
    const version = execFileSync(
      "docker",
      ["run", "--rm", "--network", "none", "--entrypoint", "codex", image, "--version"],
      { encoding: "utf8" },
    ).trim();
    receipt.push(`CLI_VERSION=${version} EXIT=0`);
    process.env.DATA_DIR = dataDir;
    process.env.RAKAZO_COMPUTER_IMAGE = image;
    process.env.SANDBOX_SUPERVISOR_TOKEN = token;
    if (replayOwnerId) process.env.RAKAZO_T01_OWNER_LABEL = replayOwnerId;
    process.env.SANDBOX_PROVIDER = "docker";
    // A pre-created, runner-labelled network keeps the Computer off Docker's
    // shared bridge while retaining host-loopback screen publication.
    process.env.SANDBOX_SCREEN_NETWORK = "published";
    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.REALTIME_DATABASE_URL = process.env.DATABASE_URL;
    computerSpec = await import("../../../../infra/sandboxes/supervisor/src/computer-spec.ts");
    execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "db", "push"], {
      cwd: path.resolve("packages/db"),
      stdio: "inherit",
      env: process.env,
    });
    const { supervisorApp } = await import("../../../../infra/sandboxes/supervisor/src/index.ts");
    supervisor = serve({
      fetch: supervisorApp.fetch,
      hostname: "127.0.0.1",
      port: 0,
    });
    if (!supervisor.listening)
      await new Promise<void>((resolve, reject) => {
        supervisor!.once("listening", resolve);
        supervisor!.once("error", reject);
      });
    const supervisorUrl = `http://127.0.0.1:${(supervisor.address() as AddressInfo).port}`;
    const sandbox = auditSandbox(new DockerSandboxProvider(supervisorUrl, token), receipt);
    const j2CompositeRuntime = {
      describe: () => ({ capabilities: { scripted: true } }),
      async *run(request: AgentRunRequest, runtimeContext?: AdapterContext) {
        if (isJ2ScriptedCoordinatorRun(request.botId, j2CoordinatorId)) {
          if (!j2CoordinatorStarted) {
            j2CoordinatorStarted = true;
            yield {
              type: "tool" as const,
              name: "delegate",
              args: {
                profile_bot_id: j2ProfileId ?? "",
                name: "J2 Codex specialist",
                brief: live
                  ? `Reply briefly with this code word: ${j2Codeword ?? "missing-codeword"}`
                  : "Reply exactly J2 smoke test",
              },
              executionId: `${request.runId}:j2-delegate`,
            };
            yield { type: "done" as const, text: "delegated" };
            return;
          }
          const wakeResponse = j2WakeScriptedResponse(request.prompt);
          if (wakeResponse) {
            yield wakeResponse;
            return;
          }
          const work = await handles!.prisma.scopedTask.findFirstOrThrow({
            where: { coordinatorBotId: j2CoordinatorId },
            orderBy: { createdAt: "desc" },
          });
          if (request.prompt === "J2 delegate close") {
            yield {
              type: "tool" as const,
              name: "delegate_close",
              args: { work_id: work.id, reason: "J2 driver close" },
              executionId: `${request.runId}:j2-close`,
            };
            yield { type: "done" as const, text: "closed" };
            return;
          }
          yield {
            type: "tool" as const,
            name: "delegate_followup",
            args: {
              work_id: work.id,
              text:
                live && request.prompt === "J2 delegate followup"
                  ? "What was the code word in the first task? Reply briefly."
                  : "Reply exactly J2 followup",
            },
            executionId: `${request.runId}:j2-followup`,
          };
          yield { type: "done" as const, text: "followed up" };
          return;
        }
        j2SpecialistRuntime = "codex-native";
        if (!computer) throw new Error("J2 specialist Computer is not provisioned");
        const native = new CodexNativeRuntime({ sandbox, computer, cwd: "" });
        yield* native.run(request, runtimeContext);
      },
    };
    const { createApp } = await import("../../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL,
      realtimeDatabaseUrl: process.env.DATABASE_URL,
      authUrl: "http://127.0.0.1",
      webOrigin: "http://127.0.0.1",
      dataDir,
      sandboxProvider: "docker",
      sandbox,
      wakeupDriver: "memory",
      agentRuntime: "scripted",
      signupsEnabled: "true",
      encryptionKey: "t01-live-isolated-encryption-key",
      nativeRuntimes: probeDelegate ? { "codex-native": j2CompositeRuntime } : undefined,
    });
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1",
      },
      body: JSON.stringify({
        email: testUserEmail,
        password: testUserPassword,
        name: "T01 live",
      }),
    });
    const cookie = sessionCookieHeader(signup);
    const rpc = async <T>(procedure: string, input: unknown, signal?: AbortSignal): Promise<T> => {
      const response = await handles!.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1",
          cookie,
        },
        body: JSON.stringify({ json: input }),
        signal,
      });
      const body = (await response.json()) as {
        json?: T;
        error?: { message?: string };
      };
      if (!response.ok || body.error) throw new Error(body.error?.message ?? `${procedure} failed`);
      return body.json as T;
    };
    const beginLiveOAuth = async () => {
      const started = await rpc<{
        loginId: string;
        verificationUri: string;
        userCode: string;
        expiresInSeconds?: number;
      }>("models/beginOAuth", { provider: "openai-codex", modelId });
      console.log(`DEVICE_CODE_URL=${started.verificationUri}`);
      console.log(`DEVICE_CODE=${started.userCode}`);
      await waitForOAuthReady(
        (signal) => rpc("models/completeOAuth", { loginId: started.loginId }, signal),
        started.expiresInSeconds,
      );
      await finishOAuthAfterReady((signal) =>
        rpc("models/finishOAuth", { loginId: started.loginId }, signal),
      );
    };
    const actor = await rpc<{ userId: string; spaceId: string }>("me", {});
    const catalog = await rpc<Array<{ provider: string; id: string }>>("models/list", {});
    const codexModels = catalog
      .filter((model) => model.provider === "openai-codex")
      .map((model) => model.id);
    if (codexModels.length === 0) throw new Error("Rakazo catalog has no openai-codex model.");
    console.log(`T01_OPENAI_CODEX_MODELS=${codexModels.join(",")}`);
    const bot = await rpc<{ id: string }>("bots/create", {
      name: "T01 live",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const stored = await handles.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      include: { computer: true },
    });
    computerContainerName = computerSpec.containerNameFor(stored.computer!.homeKey);
    dedicatedNetwork = createDedicatedTestNetwork(
      computerSpec.computerNetworkNameFor(stored.computer!.homeKey),
      replayOwnerId,
    );
    if (replayState)
      replayState = await updateT01ReplayIntent(replayState, {
        resources: {
          ...replayState.manifest.resources,
          networkName: dedicatedNetwork.name,
        },
        records: replayState.manifest.records,
      });
    context = {
      operationId: "t01-live",
      traceId: "t01-live",
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: bot.id,
      signal: AbortSignal.timeout(120_000),
    };
    await Promise.all([
      mkdir(path.join(dataDir, "skills", "marketplaces", actor.spaceId), {
        recursive: true,
      }),
      mkdir(path.join(dataDir, "skills", "user", actor.spaceId, actor.userId), {
        recursive: true,
      }),
    ]);
    const missionComputerBootStartedAt = Date.now();
    const missionComputerColdBoot = !stored.computer!.providerRef;
    computer = await sandbox.provision(
      {
        botId: stored.computer!.homeKey,
        homePath: path.join(dataDir, "homes", stored.computer!.homeKey),
      },
      context,
    );
    if (replayState)
      replayState = await updateT01ReplayIntent(replayState, {
        resources: {
          ...replayState.manifest.resources,
          containerName: computerContainerName,
        },
        records: replayState.manifest.records,
      });
    await handles.prisma.computer.update({
      where: { id: stored.computer!.id },
      data: { providerRef: computer.providerRef, state: "running" },
    });
    const versionEvents = [];
    for await (const event of sandbox.execute(
      computer,
      { argv: ["codex", "--version"], cwd: "" },
      context,
    ))
      versionEvents.push(event);
    if (versionEvents.at(-1)?.type !== "exit" || versionEvents.at(-1).code !== 0)
      throw new Error("Codex CLI is unavailable in the new Computer");
    assertDedicatedNetworkMembership(dedicatedNetwork, computerContainerName);
    receipt.push("COMPUTER_NATIVE_CAPABILITY=ready");
    if (probeDelegate) {
      // This isolated J2 rehearsal exercises unauthenticated lifecycle cleanup;
      // it intentionally does not mount the worker-local MCP entry point.
      receipt.push("J2_NATIVE_MCP=disabled");
      receipt.push(`J2_MISSION_COMPUTER_BOOT_MS=${Date.now() - missionComputerBootStartedAt}`);
      receipt.push(`J2_COLD_BOOT=${missionComputerColdBoot ? "yes" : "no"}`);
    }
    receipt.push(`T01_TEST_NETWORK=${dedicatedNetwork.name} ${dedicatedNetwork.subnet} members=1`);
    if (probeNative) {
      receipt.push("E3_A_BEGIN=runtime_path");
      const runtime = new CodexNativeRuntime({
        sandbox: handles.sandbox,
        computer,
        cwd: "",
      });
      try {
        for await (const _event of runtime.run(
          createNativeProbeRequest({
            botId: stored.id,
            computerId: computer.id,
            runId: randomUUID(),
          }),
          context,
        ))
          undefined;
        receipt.push("E3_A_OUTCOME=unexpected_completion");
      } catch (error) {
        receipt.push(`E3_A_OUTCOME=${classifyNativeProbeFailure(error)}`);
      }

      receipt.push("E3_B_BEGIN=supervisor_path");
      await probeSupervisorInitialize(sandbox, computer, context, receipt);

      receipt.push("E3_C_BEGIN=direct_tmp_home");
      await probeDirectInitialize(
        computerContainerName!,
        `/tmp/rakazo-codex-${randomUUID()}`,
        "C_TMP",
        receipt,
      );
      receipt.push("E3_C_BEGIN=direct_home_directory");
      await probeDirectInitialize(
        computerContainerName!,
        "/home/rakazo/.codex-probe",
        "C_HOME",
        receipt,
      );
      console.log(receipt.join("\n"));
      return;
    }
    if (probeDelegate) {
      const profile = await rpc<{ id: string }>("bots/create", {
        name: "J2 Codex specialist profile",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      await handles.prisma.bot.update({
        where: { id: profile.id },
        data: {
          modelProvider: "openai-codex",
          modelId: live ? modelId! : "gpt-5.6-terra",
          thinkingLevel: "medium",
        },
      });
      if (live) {
        j2Codeword = `rakazo-${randomBytes(3).toString("hex")}`;
        await beginLiveOAuth();
      }
      // Reuse the runner's already-provisioned coordinator Computer. A newly-created
      // team Computer would be provisioned lazily and is not part of this pilot's
      // labelled cleanup boundary.
      const coordinator = bot;
      j2CoordinatorId = coordinator.id;
      j2ProfileId = profile.id;
      {
        const first = await rpc<{ runId: string }>("threads/send", {
          botId: coordinator.id,
          text: "J2 delegate start",
          harness: "codex-native",
          executionTarget: stored.computer!.id,
        });
        await handles.executor.continueRun(first.runId, "j2-probe-coordinator");
        const coordinatorDeadline = Date.now() + 120_000;
        let work = await handles.prisma.scopedTask.findFirst({
          where: { coordinatorBotId: coordinator.id },
          orderBy: { createdAt: "desc" },
        });
        while (!work && Date.now() < coordinatorDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          work = await handles.prisma.scopedTask.findFirst({
            where: { coordinatorBotId: coordinator.id },
            orderBy: { createdAt: "desc" },
          });
        }
        if (!work) {
          const observed = await handles.prisma.run.findUniqueOrThrow({
            where: { id: first.runId },
            select: { status: true, error: true },
          });
          receipt.push(`J2_COORDINATOR_RUN_ERROR=${redactJ2CoordinatorError(observed.error)}`);
          reportReplayFailure(receipt);
          throw new Error(
            `J2 coordinator produced no work: ${observed.status}/${classifyRuntimeFailure(observed.error)}`,
          );
        }
        j2MissionComputerId = work.missionComputerId ?? stored.computer!.id;
        receipt.push(`J2_DELEGATE=work_created workId=${work.id}`);
        const specialistRun = await handles.prisma.run.findFirstOrThrow({
          where: { scopedTaskId: work.id, trigger: "delegate" },
          orderBy: { createdAt: "desc" },
        });
        j2SpecialistId = specialistRun.botId;
        // Delegation has already enqueued this run on createApp's in-memory worker.
        // Unlike the simple --replay path, calling continueRun here races that worker
        // and can strand a Computer lease. Observe the worker's terminal transition.
        const failed = await waitForSpecialistReturnDelivery(async () =>
          handles.prisma.run.findUniqueOrThrow({
            where: { id: specialistRun.id },
            select: {
              status: true,
              error: true,
              terminalOutcome: true,
              terminalReturnDelivery: true,
            },
          }),
        );
        const missionLeases = await handles.prisma.computerExecutionLease.findMany({
          where: {
            computerId: work.missionComputerId ?? stored.computer!.id,
          },
          select: { botId: true, runId: true, expiresAt: true },
        });
        const now = Date.now();
        receipt.push(
          `J2_MISSION_LEASES=${missionLeases.length} [${missionLeases
            .map(
              (lease) =>
                `${lease.botId === coordinator.id ? "coordinator" : "specialist"}/${lease.runId === specialistRun.id ? "first-specialist-run" : "other"}/${Math.round((lease.expiresAt.getTime() - now) / 1000)}s`,
            )
            .join(",")}]`,
        );
        const coordinatorRun = await handles.prisma.run.findUniqueOrThrow({
          where: { id: first.runId },
          select: { status: true },
        });
        receipt.push(`J2_COORDINATOR_RUN_STATUS=${coordinatorRun.status}`);
        receipt.push("J2_EXECUTION_LEASE_MS=300000");
        receipt.push(`J2_SPECIALIST_RUN=codex-native/${failed.status}`);
        receipt.push(`J2_SPECIALIST_ERROR=${redactJ2CoordinatorError(failed.error)}`);
        receipt.push(`RUNTIME_FAILURE_CATEGORY=${classifyRuntimeFailure(failed.error)}`);
        receipt.push(`J2_SPECIALIST_RUNTIME=${j2SpecialistRuntime ?? "scripted"}`);
        if (
          live
            ? failed.status !== "completed" || j2SpecialistRuntime !== "codex-native"
            : classifyRuntimeFailure(failed.error) !== "authentication"
        ) {
          receipt.push(`J2_SPECIALIST_RUNTIME_MISMATCH=${j2SpecialistRuntime ?? "scripted"}`);
          throw new Error(
            live
              ? "J2 live specialist did not complete on codex-native"
              : "J2 specialist did not reach the expected auth-free native runtime",
          );
        }
        const messages = await rpc<{
          messages: Array<{ runId?: string; blocks?: unknown }>;
        }>("threads/messages", {
          botId: coordinator.id,
          includePeerReceipts: true,
        });
        const returned = messages.messages.some((message) =>
          JSON.stringify(message.blocks).includes("work_return"),
        );
        if (!returned) {
          receipt.push(
            `J2_SPECIALIST_RUN_STATUS=${failed.status}/${failed.terminalOutcome ?? "none"}/${failed.terminalReturnDelivery ?? "none"}`,
          );
          const scoped = await handles.prisma.scopedTask.findUniqueOrThrow({
            where: { id: work.id },
            select: { status: true, coordinatorThreadId: true },
          });
          receipt.push(`J2_SCOPED_TASK_STATUS=${scoped.status}`);
          const diagnosticRows = await handles.prisma.message.findMany({
            where: { threadId: scoped.coordinatorThreadId },
            select: { blocks: true },
          });
          const workReturnRows = diagnosticRows.filter((row) =>
            JSON.stringify(row.blocks).includes("work_return"),
          ).length;
          receipt.push(`J2_WORK_RETURN_ROWS=${workReturnRows}`);
          const publicKinds =
            messages.messages
              .flatMap((message) =>
                Array.isArray(message.blocks)
                  ? message.blocks.map((block) =>
                      typeof block === "object" && block && "kind" in block
                        ? String((block as { kind: unknown }).kind)
                        : "unknown",
                    )
                  : ["unknown"],
              )
              .sort()
              .join(",") || "none";
          receipt.push(`J2_COORDINATOR_THREAD_MESSAGES=${messages.messages.length}/${publicKinds}`);
          receipt.push(
            `J2_RECORD_FAILURE_CALLED=${failed.terminalReturnDelivery === "delivered" ? "yes" : "unknown"}`,
          );
          receipt.push(`J2_WORKER_LAST_ERROR=${redactJ2CoordinatorError(failed.error)}`);
          reportReplayFailure(receipt);
          throw new Error("J2 failed specialist return was not delivered publicly");
        }
        const delivered = await handles.prisma.run.findUniqueOrThrow({
          where: { id: specialistRun.id },
          select: { terminalOutcome: true, terminalReturnDelivery: true },
        });
        if (
          delivered.terminalOutcome !== (live ? "result" : "failed") ||
          delivered.terminalReturnDelivery !== "delivered"
        ) {
          receipt.push(
            `J2_SPECIALIST_RUN_STATUS=${failed.status}/${delivered.terminalOutcome ?? "none"}/${delivered.terminalReturnDelivery ?? "none"}`,
          );
          reportReplayFailure(receipt);
          throw new Error("J2 specialist failure delivery did not finalize");
        }
        receipt.push(`J2_WORK_RETURN=${live ? "result" : "failed"}`);
        const waitForCoordinatorWake = async (excludeRunIds: string[] = []) =>
          waitForTerminalRun(() =>
            handles!.prisma.run.findFirst({
              where: {
                botId: coordinator.id,
                threadId: work.coordinatorThreadId,
                trigger: "work_return",
                ...(excludeRunIds.length > 0 ? { id: { notIn: excludeRunIds } } : {}),
              },
              orderBy: { createdAt: "asc" },
              select: { id: true, status: true },
            }),
          );
        const coordinatorWake = await waitForCoordinatorWake();
        receipt.push(`J2_COORDINATOR_WAKE=${coordinatorWake?.status ?? "missing"}`);
        if (coordinatorWake?.status !== "completed")
          throw new Error("J2 coordinator wake did not reach a completed terminal state");
        if (live) {
          const text = j2WorkReturnText(messages.messages, specialistRun.id);
          if (!text) throw new Error("J2 live specialist result text was not captured");
          receipt.push(`J2_WORK_RETURN_TEXT=${redactJ2WorkReturnText(text, j2Codeword)}`);
        }
        const inspected = await handles.app.request(`/api/delegation/${work.id}/inspect`, {
          headers: { cookie, "x-rakazo-bot-id": coordinator.id },
        });
        const tree = (await inspected.json()) as {
          root?: {
            depth?: number;
            status?: string;
            missionComputerId?: string | null;
          };
        };
        if (!inspected.ok || !tree.root) throw new Error("J2 inspect failed");
        receipt.push(
          `J2_INSPECT=${tree.root.depth}/${tree.root.status} missionComputerId=${tree.root.missionComputerId ? "present" : "missing"}`,
        );
        const followup = await rpc<{ runId: string }>("threads/send", {
          botId: coordinator.id,
          text: "J2 delegate followup",
          harness: "codex-native",
          executionTarget: stored.computer!.id,
        });
        await handles.executor.continueRun(followup.runId, "j2-probe-coordinator-followup");
        const followupDeadline = Date.now() + 120_000;
        let next = await handles.prisma.run.findFirst({
          where: { scopedTaskId: work.id, trigger: "delegate_followup" },
          orderBy: { createdAt: "desc" },
        });
        while (!next && Date.now() < followupDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          next = await handles.prisma.run.findFirst({
            where: { scopedTaskId: work.id, trigger: "delegate_followup" },
            orderBy: { createdAt: "desc" },
          });
        }
        if (!next) {
          receipt.push("J2_FOLLOWUP=unknown");
          console.log(receipt.join("\n"));
          return;
        }
        j2FollowupRunId = next.id;
        // The follow-up is likewise owned by the active in-memory worker; wait for
        // its terminal state before teardown instead of racing a second continuation.
        const followupResult = await waitForSpecialistReturnDelivery(() =>
          handles.prisma.run.findUniqueOrThrow({
            where: { id: next.id },
            select: {
              status: true,
              error: true,
              terminalOutcome: true,
              terminalReturnDelivery: true,
            },
          }),
        );
        receipt.push(`J2_FOLLOWUP=${followupResult.status}`);
        if (followupResult.terminalReturnDelivery !== "delivered")
          throw new Error("J2 specialist follow-up return was not delivered");
        if (
          live &&
          (followupResult.status !== "completed" ||
            followupResult.terminalOutcome !== "result" ||
            followupResult.terminalReturnDelivery !== "delivered")
        )
          throw new Error("J2 live specialist follow-up did not deliver a result");
        const secondCoordinatorWake = await waitForCoordinatorWake([coordinatorWake.id]);
        if (secondCoordinatorWake?.status !== "completed")
          throw new Error("J2 second coordinator wake did not reach a completed terminal state");
        receipt.push("J2_COORDINATOR_WAKES=2");
        if (!live) {
          receipt.push("J2_CONTINUITY=not_run_without_auth");
        } else {
          const specialistThreadId = specialistRun.threadId;
          let reconstructedRunId: string | undefined;
          let nativeSessionBefore:
            | {
                generation: number;
                nativeRef: string | null;
                processRef: string | null;
                state: string;
                processState: string;
              }
            | undefined;
          const recordJ2Followup2Diagnostics = async (error: unknown) => {
            const sessionShape = (
              session:
                | {
                    generation: number;
                    nativeRef: string | null;
                    state: string;
                    processState: string;
                  }
                | null
                | undefined,
            ) =>
              session
                ? `${session.state}/${session.processState}/${session.generation}/${session.nativeRef ? "present" : "missing"}`
                : "none";
            const [run, after] = await Promise.all([
              reconstructedRunId
                ? handles.prisma.run.findUnique({
                    where: { id: reconstructedRunId },
                    select: {
                      status: true,
                      error: true,
                      terminalOutcome: true,
                      terminalReturnDelivery: true,
                    },
                  })
                : Promise.resolve(null),
              specialistThreadId
                ? handles.prisma.nativeSession.findUnique({
                    where: {
                      botId_threadId: {
                        botId: specialistRun.botId,
                        threadId: specialistThreadId,
                      },
                    },
                    select: {
                      generation: true,
                      nativeRef: true,
                      state: true,
                      processState: true,
                    },
                  })
                : Promise.resolve(null),
            ]);
            receipt.push(
              `J2_FOLLOWUP2_RUN=${run?.status ?? "none"}/${run?.terminalOutcome ?? "none"}/${run?.terminalReturnDelivery ?? "none"}`,
            );
            receipt.push(
              `J2_FOLLOWUP2_ERROR=${classifyRuntimeFailure(run?.error ?? (error instanceof Error ? error.message : error))}`,
            );
            receipt.push(`J2_NATIVE_SESSION_BEFORE=${sessionShape(nativeSessionBefore)}`);
            receipt.push(`J2_NATIVE_SESSION_AFTER=${sessionShape(after)}`);
          };
          if (!specialistThreadId || !computer || !context) {
            await recordJ2Followup2Diagnostics(
              new Error("J2 live continuity has no specialist session placement"),
            );
            throw new Error("J2 live continuity has no specialist session placement");
          }
          const existingSession = await handles.prisma.nativeSession.findUnique({
            where: {
              botId_threadId: {
                botId: specialistRun.botId,
                threadId: specialistThreadId,
              },
            },
            select: {
              generation: true,
              nativeRef: true,
              processRef: true,
              state: true,
              processState: true,
            },
          });
          if (!existingSession) {
            await recordJ2Followup2Diagnostics(
              new Error("J2 first live follow-up native session was not found"),
            );
            throw new Error("J2 first live follow-up native session was not found");
          }
          nativeSessionBefore = existingSession;
          if (
            nativeSessionBefore.state !== "parked" ||
            nativeSessionBefore.processState !== "running" ||
            !nativeSessionBefore.processRef
          ) {
            await recordJ2Followup2Diagnostics(
              new Error("J2 first live follow-up did not park a resumable session"),
            );
            throw new Error("J2 first live follow-up did not park a resumable session");
          }
          const resumedEvent = await handles.prisma.lifecycleEvent.findFirst({
            where: {
              botId: specialistRun.botId,
              threadId: specialistThreadId,
              kind: "resume",
            },
            orderBy: { createdAt: "desc" },
          });
          if (!resumedEvent) {
            await recordJ2Followup2Diagnostics(
              new Error("J2 first live follow-up was not a native resume"),
            );
            throw new Error("J2 first live follow-up was not a native resume");
          }
          receipt.push("J2_FOLLOWUP1_CONTINUITY=resumed");
          const oldPids = await j2ParkedCodexPids(sandbox, computer, context);
          try {
            await stopAndClearParkedCodexRuntimeForTest({
              computer,
              ref: {
                bindingId: specialistThreadId,
                generation: nativeSessionBefore.generation,
              },
              // The seam only calls this after stop() returned "stopped". A confirmed
              // DELETE drops the supervisor's session record, so reconfirm would answer
              // stop_unconfirmed for an unknown id; the independent proof is /proc.
              verifyStopped: async () => {
                await j2AssertPidsGone(sandbox, computer, oldPids, context);
              },
            });
            receipt.push("J2_OLD_PID_DEAD=yes");
          } catch (error) {
            receipt.push("J2_OLD_PID_DEAD=no");
            await recordJ2Followup2Diagnostics(error);
            throw error;
          }
          const reconstructedFollowup = await rpc<{ runId: string }>("threads/send", {
            botId: coordinator.id,
            text: "J2 delegate followup reconstruct",
            harness: "codex-native",
            executionTarget: stored.computer!.id,
          });
          await handles.executor.continueRun(
            reconstructedFollowup.runId,
            "j2-probe-coordinator-reconstruct",
          );
          let reconstructed = await handles.prisma.run.findFirst({
            where: {
              scopedTaskId: work.id,
              trigger: "delegate_followup",
              id: { not: next.id },
            },
            orderBy: { createdAt: "desc" },
          });
          while (!reconstructed && Date.now() < followupDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            reconstructed = await handles.prisma.run.findFirst({
              where: {
                scopedTaskId: work.id,
                trigger: "delegate_followup",
                id: { not: next.id },
              },
              orderBy: { createdAt: "desc" },
            });
          }
          if (!reconstructed) {
            await recordJ2Followup2Diagnostics(
              new Error("J2 reconstructed specialist follow-up was not created"),
            );
            throw new Error("J2 reconstructed specialist follow-up was not created");
          }
          j2FollowupRunId = reconstructed.id;
          reconstructedRunId = reconstructed.id;
          let reconstructedResult: {
            status: string;
            terminalOutcome: string | null;
            terminalReturnDelivery: string | null;
          };
          do {
            reconstructedResult = await handles.prisma.run.findUniqueOrThrow({
              where: { id: reconstructed.id },
              select: {
                status: true,
                terminalOutcome: true,
                terminalReturnDelivery: true,
              },
            });
            if (!["queued", "leased", "running"].includes(reconstructedResult.status)) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          } while (Date.now() < followupDeadline);
          if (
            reconstructedResult.status !== "completed" ||
            reconstructedResult.terminalOutcome !== "result" ||
            reconstructedResult.terminalReturnDelivery !== "delivered"
          ) {
            await recordJ2Followup2Diagnostics(
              new Error("J2 reconstructed specialist follow-up did not deliver a result"),
            );
            throw new Error("J2 reconstructed specialist follow-up did not deliver a result");
          }
          const reconstructedSession = await handles.prisma.nativeSession.findUniqueOrThrow({
            where: {
              botId_threadId: {
                botId: specialistRun.botId,
                threadId: specialistThreadId,
              },
            },
            select: { generation: true, nativeRef: true },
          });
          if (reconstructedSession.generation !== nativeSessionBefore.generation + 1) {
            await recordJ2Followup2Diagnostics(
              new Error("J2 reconstructed session did not advance generation"),
            );
            throw new Error("J2 reconstructed session did not advance generation");
          }
          const method = receipt.includes("NATIVE_OUTBOUND_METHOD=thread/resume")
            ? "thread/resume"
            : undefined;
          if (!method) {
            await recordJ2Followup2Diagnostics(
              new Error("J2 reconstructed session did not use thread/resume"),
            );
            throw new Error("J2 reconstructed session did not use thread/resume");
          }
          const followupMessages = await rpc<{
            messages: Array<{ runId?: string; blocks?: unknown }>;
          }>("threads/messages", {
            botId: coordinator.id,
            includePeerReceipts: true,
          });
          const reconstructedText = j2WorkReturnText(followupMessages.messages, reconstructed.id);
          const recalled =
            !!j2Codeword && !!reconstructedText && reconstructedText.includes(j2Codeword);
          receipt.push("J2_FOLLOWUP2_CONTINUITY=reconstructed");
          receipt.push(`J2_FOLLOWUP2_METHOD=${method}`);
          receipt.push(`J2_NATIVE_GENERATION=${reconstructedSession.generation}`);
          receipt.push(`J2_CODEWORD_RECALLED=${recalled ? "yes" : "no"}`);
          if (!recalled) {
            await recordJ2Followup2Diagnostics(
              new Error("J2 reconstructed response did not recall the code word"),
            );
            throw new Error("J2 reconstructed response did not recall the code word");
          }
        }
        const close = await rpc<{ runId: string }>("threads/send", {
          botId: coordinator.id,
          text: "J2 delegate close",
          harness: "codex-native",
          executionTarget: stored.computer!.id,
        });
        await handles.executor.continueRun(close.runId, "j2-probe-coordinator-close");
        // The close continuation can already be owned by the in-memory worker. Waiting
        // for that worker's terminal write is the assertion under test; reading the work
        // or tearing down the supervisor earlier can abort a claimed close turn.
        const closeDeadline = Date.now() + 120_000;
        let closeResult: { status: string; terminalOutcome: string | null };
        do {
          closeResult = await handles.prisma.run.findUniqueOrThrow({
            where: { id: close.runId },
            select: { status: true, terminalOutcome: true },
          });
          if (!["queued", "leased", "running"].includes(closeResult.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        } while (Date.now() < closeDeadline);
        receipt.push(`J2_CLOSE_RUN=${closeResult.status}/${closeResult.terminalOutcome ?? "none"}`);
        if (["queued", "leased", "running"].includes(closeResult.status))
          throw new Error("J2 close run did not reach a terminal state");
        const j2Role = (botId: string) => (botId === coordinator.id ? "coordinator" : "specialist");
        const nativeSessions = await handles.prisma.nativeSession.findMany({
          where: { botId: { in: [coordinator.id, specialistRun.botId] } },
          select: {
            botId: true,
            state: true,
            processState: true,
            generation: true,
          },
          orderBy: { botId: "asc" },
        });
        const lifecycleEvents = await handles.prisma.lifecycleEvent.findMany({
          where: { botId: { in: [coordinator.id, specialistRun.botId] } },
          select: { botId: true, kind: true },
          orderBy: { createdAt: "asc" },
        });
        receipt.push(
          `J2_NATIVE_SESSIONS=${nativeSessions.length === 0 ? "none" : nativeSessions.map((session) => `${j2Role(session.botId)}:${session.state}/${session.processState}/g${session.generation}`).join(",")}`,
        );
        receipt.push(
          `J2_LIFECYCLE_EVENTS=${lifecycleEvents.length === 0 ? "none" : lifecycleEvents.map((event) => event.kind).join(",")}`,
        );
        const closedWork = await handles.prisma.scopedTask.findUniqueOrThrow({
          where: { id: work.id },
          select: { status: true },
        });
        const grantsAfterClose = await handles.prisma.computerUsageGrant.count({
          where: {
            computerId: j2MissionComputerId,
            botId: specialistRun.botId,
          },
        });
        receipt.push(`J2_USAGE_GRANTS_AFTER_CLOSE=${grantsAfterClose}`);
        receipt.push(`J2_WORK_STATUS=${closedWork.status}`);
        console.log(receipt.join("\n"));
        return;
      }
    }
    const persistReplayState = async () => {
      replayState = await updateT01ReplayIntent(replayState!, {
        resources: replayState!.manifest.resources,
        records: {
          botId: bot.id,
          computerId: stored.computer!.id,
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
      });
      preserveReplayResources = true;
      console.log(`T01_REPLAY_PROVISIONED=${root}`);
    };
    if (provisionReplay && !live) {
      await persistReplayState();
      return;
    }
    if (!live) {
      await writeFile(path.join(root, "preflight.txt"), `${receipt.join("\n")}\n`);
      console.log("T01_PREFLIGHT_PASS=isolated resources cleaned after verification");
      console.log(
        "T01_FUTURE_COMMAND=RAKAZO_T01_LIVE_MODEL_ID=<catalog-model-id> pnpm exec tsx packages/testkit/src/cli/t01-live-subscription.ts --live",
      );
      return;
    }
    await beginLiveOAuth();
    await rpc("bots/update", {
      botId: bot.id,
      modelProvider: "openai-codex",
      modelId,
    });
    if (provisionReplay) {
      await persistReplayState();
      return;
    }
    const sent = await rpc<{ runId: string }>("threads/send", {
      botId: bot.id,
      text: "Reply exactly T01 live subscription smoke test.",
      harness: "codex-native",
      executionTarget: stored.computer!.id,
    });
    await handles.executor.continueRun(sent.runId, "t01-live");
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const runs = await listSpaceRuns(handles.prisma, actor, "recent");
      const run = runs.find((entry) => entry.runId === sent.runId);
      if (run?.status === "completed") {
        receipt.push("PUBLIC_RUN_STATUS=completed");
        break;
      }
      if (run?.status === "failed") {
        receipt.push("PUBLIC_RUN_STATUS=failed");
        const failed = await handles.prisma.run.findUnique({
          where: { id: sent.runId },
          select: { error: true },
        });
        receipt.push(`RUNTIME_FAILURE_CATEGORY=${classifyRuntimeFailure(failed?.error)}`);
        throw new Error("Native live run failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!receipt.includes("PUBLIC_RUN_STATUS=completed"))
      throw new Error("Timed out waiting for public completion");
    await writeFile(path.join(root, "live-receipt.txt"), `${receipt.join("\n")}\n`);
    console.log(receipt.join("\n"));
  } catch (error) {
    primaryError = error;
    if (live) {
      receipt.push("LIVE_RUN_FAILURE=observed");
      console.log(receipt.join("\n"));
    }
    throw error;
  } finally {
    if (probeDelegate && receipt.some((line) => line.startsWith("J2_DELEGATE="))) {
      const finalReceiptStart = receipt.length;
      if (handles && j2MissionComputerId) {
        const missionComputer = await handles.prisma.computer.findUnique({
          where: { id: j2MissionComputerId },
          select: {
            state: true,
            updatedAt: true,
            maintenanceId: true,
            controlLeaseId: true,
            providerRef: true,
          },
        });
        if (missionComputer) {
          const ageSeconds = Math.max(
            0,
            Math.round((Date.now() - missionComputer.updatedAt.getTime()) / 1000),
          );
          receipt.push(
            `J2_MISSION_COMPUTER=${missionComputer.state}/${ageSeconds}s/${missionComputer.maintenanceId ? "yes" : "no"}/${missionComputer.controlLeaseId ? "yes" : "no"}/${missionComputer.providerRef ? "yes" : "no"}`,
          );
          const usageGrants = await handles.prisma.computerUsageGrant.count({
            where: { computerId: j2MissionComputerId },
          });
          receipt.push(`J2_USAGE_GRANTS=${usageGrants}`);
        }
      }
      if (handles && j2SpecialistId) {
        const specialist = await handles.prisma.bot.findUnique({
          where: { id: j2SpecialistId },
          select: { computer: { select: { id: true, state: true } } },
        });
        receipt.push(
          `J2_SPECIALIST_BOT_COMPUTER=${specialist?.computer?.id ?? "none"}/${specialist?.computer?.state ?? "none"}`,
        );
      }
      if (handles && j2FollowupRunId) {
        const followup = await handles.prisma.run.findUnique({
          where: { id: j2FollowupRunId },
          select: { status: true },
        });
        const attempts = await handles.prisma.attempt.count({
          where: { runId: j2FollowupRunId },
        });
        receipt.push(`J2_FOLLOWUP_RUN=${followup?.status ?? "none"}/${attempts}`);
      } else receipt.push("J2_FOLLOWUP_RUN=none/0");
      if (process.env.RAKAZO_J2_DIAGNOSTICS === "1" && process.env.RAKAZO_J2_DIAGNOSTICS_FILE) {
        const diagnostics = await readFile(process.env.RAKAZO_J2_DIAGNOSTICS_FILE, "utf8").catch(
          () => "",
        );
        const counts = new Map<string, number>();
        for (const line of diagnostics.split("\n")) {
          try {
            const record = JSON.parse(line) as {
              branch?: unknown;
              reason?: unknown;
            };
            if (typeof record.branch === "string" && typeof record.reason === "string") {
              const key = `${record.branch}/${record.reason}`;
              counts.set(key, (counts.get(key) ?? 0) + 1);
            }
          } catch {
            // The guarded diagnostics file can end with a partial line during teardown.
          }
        }
        for (const [key, count] of counts) receipt.push(`J2_REQUEUE_DIAG=${key} ×${count}`);
      }
      if (receipt.length > finalReceiptStart)
        console.log(receipt.slice(finalReceiptStart).join("\n"));
      console.log(receipt.join("\n"));
    }
    const cleanupErrors: string[] = [];
    if (!preserveReplayResources && computer && context && handles)
      await withFreshOperationSignal((signal) =>
        handles.sandbox.destroy(computer, { ...context, signal }),
      ).catch(() => cleanupErrors.push("computer destroy failed"));
    if (!preserveReplayResources && dedicatedNetwork) {
      cleanupErrors.push(
        ...cleanupDedicatedDockerResources({
          containerName: computerContainerName,
          networkName: dedicatedNetwork.name,
          removeContainer: (name) =>
            execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }),
          networkExists: dockerNetworkExists,
          removeNetwork: (name) =>
            execFileSync("docker", ["network", "rm", name], {
              stdio: "ignore",
            }),
        }),
      );
    }
    await handles?.stop().catch(() => cleanupErrors.push("app stop failed"));
    if (supervisor)
      await new Promise<void>((resolve) => supervisor!.close(() => resolve())).catch(() =>
        cleanupErrors.push("supervisor stop failed"),
      );
    if (!preserveReplayResources)
      await postgres.stop().catch(() => cleanupErrors.push("postgres stop failed"));
    if (!preserveReplayResources)
      await rm(root, { recursive: true, force: true }).catch(() =>
        cleanupErrors.push("temporary data cleanup failed"),
      );
    for (const message of cleanupErrors) console.error(`T01_CLEANUP_ERROR=${message}`);
    outcome.cleanupFailed = !primaryError && cleanupErrors.length > 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
