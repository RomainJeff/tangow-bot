import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerSpec } from "@rakazo/adapter-kit";
import { DockerWorkerProvider } from "@rakazo/adapters";
import { afterAll, beforeAll } from "vitest";

/** Opt-in: needs Docker and the worker image (apps/agent-run-worker/Dockerfile), no network or keys. */
export const dockerWorkersEnabled = process.env.VERIFY_DOCKER_WORKERS === "1";

const SUPERVISOR = fileURLToPath(
  new URL("../../../infra/sandboxes/supervisor/src/index.ts", import.meta.url),
);

export const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();

/** The supervisor here runs on the host, so workers run as the host user, as its computers do. */
const hostUid = process.getuid?.();
export const sandboxUser =
  hostUid === undefined || hostUid === 0
    ? { uid: 1000, gid: 1000 }
    : { uid: hostUid, gid: process.getgid?.() ?? hostUid };

export const dockerDesktop =
  dockerWorkersEnabled && docker("info", "--format", "{{.OperatingSystem}}") === "Docker Desktop";

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function workerSpec(attemptId: string, mounts: WorkerSpec["mounts"]): WorkerSpec {
  return {
    attemptId,
    runId: `run-${attemptId}`,
    botId: "bot",
    mounts,
    ttlSeconds: 600,
    ensureDeadline: new Date(Date.now() + 15 * 60_000),
  };
}

/** A real supervisor on this machine for the file's tests, on its own `DATA_DIR` and token. */
export function useDockerSupervisor() {
  const state = {
    dir: "",
    dataDir: "",
    url: "",
    port: 0,
    token: randomBytes(24).toString("hex"),
    provider: () =>
      new DockerWorkerProvider({
        supervisorUrl: state.url,
        supervisorToken: state.token,
        dataDir: state.dataDir,
      }),
  };
  let child: ChildProcess | undefined;
  beforeAll(async () => {
    if (!dockerWorkersEnabled) return;
    state.dir = await mkdtemp(path.join(tmpdir(), "rakazo-docker-workers-"));
    state.dataDir = path.join(state.dir, "data");
    await mkdir(state.dataDir, { recursive: true });
    state.port = await freePort();
    state.url = `http://127.0.0.1:${state.port}`;
    child = spawn(process.execPath, ["--import", "tsx", SUPERVISOR], {
      cwd: path.dirname(path.dirname(SUPERVISOR)),
      stdio: ["ignore", "ignore", process.env.RAKAZO_WORKER_DEBUG ? "inherit" : "ignore"],
      env: {
        ...process.env,
        DATA_DIR: state.dataDir,
        SANDBOX_SUPERVISOR_TOKEN: state.token,
        SUPERVISOR_PORT: String(state.port),
        SUPERVISOR_HOST: "127.0.0.1",
      },
    });
    for (let tries = 0; ; tries++) {
      const ok = await fetch(`${state.url}/health`).then(
        (response) => response.ok,
        () => false,
      );
      if (ok) break;
      if (tries > 100) throw new Error("The supervisor did not start");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, 60_000);
  afterAll(async () => {
    if (!dockerWorkersEnabled) return;
    child?.kill("SIGTERM");
    await rm(state.dir, { recursive: true, force: true });
  });
  return state;
}
