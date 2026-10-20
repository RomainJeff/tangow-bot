import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { AdapterContext, WorkerProvider } from "@rakazo/adapter-kit";
import {
  E2BVolumeFiles,
  E2BWorkerProvider,
  type E2BWorkerSdk,
  e2bVolumeSandbox,
  e2bWorkerSdk,
} from "@rakazo/adapters";
import type { GuestConnector } from "@rakazo/adapters/runtime-worker";
import { type ConnectionOpts, Sandbox, Volume } from "e2b";

export const MIN_MEM_AVAILABLE_MIB = 1536;
const VM_TIMEOUT_MS = 15 * 60 * 1000;
export const POLL_INTERVAL_S = 0.05;
const POLL_ROUNDS = 1200;

export interface LiveConfig {
  apiKey: string;
  apiUrl?: string;
  domain?: string;
  /** The worker template built from `apps/agent-run-worker/template`. */
  workerTemplate: string;
  /** A template for the second VM that mounts the same volumes, as the computer does. */
  computerTemplate: string;
}

export type LaneResult = { pass: boolean; observed: Record<string, unknown> };

export interface Lane {
  id: string;
  issue: string;
  scenario: string;
  passWhen: string;
  /** Set while the lane needs behavior a slice not merged yet adds. */
  pending?: string;
  run?(live: Live): Promise<LaneResult>;
}

export const context = (name: string): AdapterContext => ({
  operationId: `worker-live:${name}`,
  traceId: `worker-live:${name}`,
  spaceId: "worker-live",
  userId: "worker-live",
  signal: new AbortController().signal,
});

/** Host memory left outside the VMs' hugepages, or null off Linux. */
export function memAvailableMiB(): number | null {
  try {
    const kib = /MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1];
    return kib ? Math.round(Number(kib) / 1024) : null;
  } catch {
    return null;
  }
}

export function requireHeadroom(): number | null {
  const mib = memAvailableMiB();
  if (mib !== null && mib < MIN_MEM_AVAILABLE_MIB) {
    throw new Error(`MemAvailable ${mib} MiB is under ${MIN_MEM_AVAILABLE_MIB} MiB`);
  }
  return mib;
}

export const sha256 = (content: Uint8Array | string) =>
  createHash("sha256").update(content).digest("hex");

/**
 * One live session on an E2B deployment. Every sandbox it creates carries `p3live: <tag>` and
 * every volume a `<tag>-` name prefix, so `sweep` finds and removes all of them.
 */
export function liveSession(config: LiveConfig) {
  const tag = `p3live-${randomBytes(4).toString("hex")}`;
  const connection: ConnectionOpts = {
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    domain: config.domain,
  };
  const base = e2bWorkerSdk(connection);
  /** How long each guest command took to start, from the call to E2B's handle. */
  const guestCommandStarts: number[] = [];
  const sdk: E2BWorkerSdk = {
    ...base,
    async startGuest(sandboxId, command, options) {
      const started = performance.now();
      const guest = await base.startGuest(sandboxId, command, options);
      guestCommandStarts.push(performance.now() - started);
      return guest;
    },
    createSandbox: (options) =>
      base.createSandbox({ ...options, metadata: { ...options.metadata, p3live: tag } }),
    createVolume: (name) => base.createVolume(`${tag}-${name}`),
  };

  async function ownSandboxes(): Promise<string[]> {
    const ids: string[] = [];
    const pages = Sandbox.list({ ...connection, query: { metadata: { p3live: tag } } });
    while (pages.hasNext) ids.push(...(await pages.nextItems()).map((info) => info.sandboxId));
    return ids;
  }
  async function ownVolumes() {
    return (await Volume.list(connection)).filter((volume) => volume.name.startsWith(`${tag}-`));
  }

  return {
    tag,
    config,
    connection,
    guestCommandStarts,
    workerProvider: () =>
      new E2BWorkerProvider(
        {
          apiKey: config.apiKey,
          apiUrl: config.apiUrl,
          domain: config.domain,
          template: config.workerTemplate,
        },
        sdk,
      ),
    volumeFiles: () =>
      new E2BVolumeFiles(
        e2bVolumeSandbox({
          template: config.workerTemplate,
          connection,
          metadata: { p3live: tag },
        }),
      ),
    /** A second VM, as a computer: same mounts, its own kernel. */
    async vm(volumeMounts: Record<string, string>, template = config.computerTemplate) {
      return Sandbox.create(template, {
        ...connection,
        secure: true,
        metadata: { p3live: tag, role: "computer" },
        volumeMounts,
        timeoutMs: VM_TIMEOUT_MS,
        lifecycle: { onTimeout: "kill" },
      });
    },
    async census() {
      return { sandboxes: (await ownSandboxes()).length, volumes: (await ownVolumes()).length };
    },
    /** Kills every sandbox and destroys every volume of this session, then counts what is left. */
    async sweep() {
      const sandboxes = await ownSandboxes();
      for (const id of sandboxes) await Sandbox.kill(id, connection).catch(() => false);
      const volumes = await ownVolumes();
      for (const volume of volumes)
        await Volume.destroy(volume.volumeId, connection).catch(() => false);
      return { killed: sandboxes.length, destroyed: volumes.length, left: await this.census() };
    },
  };
}

export type Live = ReturnType<typeof liveSession>;

export async function sh(vm: Sandbox, command: string, user: "user" | "root" = "user") {
  return (await vm.commands.run(command, { user, timeoutMs: 60_000 })).stdout.trim();
}

/** Polls `file` in `vm` until it holds `marker`, and resolves with when the host saw it. */
export async function pollFor(vm: Sandbox, file: string, marker: string) {
  const handle = await vm.commands.run(
    `for i in $(seq 1 ${POLL_ROUNDS}); do grep -qs '${marker}' '${file}' && { echo "seen $i"; exit 0; }; sleep ${POLL_INTERVAL_S}; done; echo timeout`,
    { background: true, timeoutMs: 0 },
  );
  return handle.wait().then((result) => ({ at: performance.now(), out: result.stdout.trim() }));
}

export type ProviderWrap = (
  provider: WorkerProvider & GuestConnector,
) => WorkerProvider & GuestConnector;
