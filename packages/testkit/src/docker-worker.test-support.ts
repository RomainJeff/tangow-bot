import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkerSpec } from "@rakazo/adapter-kit";
import { DockerWorkerProvider } from "@rakazo/adapters";
import { afterAll, beforeAll } from "vitest";
import { startDockerSupervisor } from "./docker-supervisor.js";

export { freePort } from "./docker-supervisor.js";

/** Opt-in: needs Docker and the worker image (apps/agent-run-worker/Dockerfile), no network or keys. */
export const dockerWorkersEnabled = process.env.VERIFY_DOCKER_WORKERS === "1";

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
  let stop: (() => void) | undefined;
  beforeAll(async () => {
    if (!dockerWorkersEnabled) return;
    state.dir = await mkdtemp(path.join(tmpdir(), "rakazo-docker-workers-"));
    state.dataDir = path.join(state.dir, "data");
    await mkdir(state.dataDir, { recursive: true });
    const supervisor = await startDockerSupervisor({ dataDir: state.dataDir, token: state.token });
    state.url = supervisor.url;
    state.port = Number(new URL(supervisor.url).port);
    stop = supervisor.stop;
  }, 60_000);
  afterAll(async () => {
    if (!dockerWorkersEnabled) return;
    stop?.();
    await rm(state.dir, { recursive: true, force: true });
  });
  return state;
}
