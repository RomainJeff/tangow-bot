import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { AdapterContext, SandboxProvider, WorkerProvider } from "@rakazo/adapter-kit";
import {
  E2BSandboxProvider,
  type E2BSandboxSdk,
  E2BVolumeFiles,
  E2BWorkerProvider,
  type E2BWorkerSdk,
  e2bVolumeSandbox,
  e2bWorkerSdk,
} from "@rakazo/adapters";
import type { GuestConnector } from "@rakazo/adapters/runtime-worker";
import { type ConnectionOpts, Sandbox, Volume } from "e2b";

export const MIN_MEM_AVAILABLE_MIB = 1536;
/** Where the product's E2B computer links its workspace: the volumes' root. */
export const COMPUTER_WORKSPACE = "/home/user/rakazo-home";
const VM_TIMEOUT_MS = 15 * 60 * 1000;
export const POLL_INTERVAL_S = 0.05;
const POLL_ROUNDS = 1200;

export interface LiveConfig {
  apiKey: string;
  apiUrl?: string;
  domain?: string;
  /** The worker template built from `apps/agent-run-worker/template`. */
  workerTemplate: string;
  harness?: string;
  /** Upload a local bundle to each owned worker instead of publishing a template. */
  guestBundle?: string;
  prepareComputer?: boolean;
  /** A template for the second VM that mounts the same volumes, as the computer does. */
  computerTemplate: string;
}

export type LaneResult = { pass: boolean; observed: Record<string, unknown> };

export interface Lane {
  id: string;
  issue: string;
  scenario: string;
  passWhen: string;
  run(live: Live): Promise<LaneResult>;
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
 * One live session on an E2B deployment. Every sandbox it creates carries `p3live: <tag>`, and it
 * records the name of every volume it creates, so `sweep` finds and removes all of them.
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
  const guestUploadDeadlines: Array<{ before: string; after: string; timeoutMs: number }> = [];
  /** A provider must keep the name it was given, so volumes are tracked by name, not tagged. */
  const volumeNames = new Set<string>();
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
    async createVolume(name, options) {
      volumeNames.add(name);
      return base.createVolume(name, options);
    },
  };

  async function ownSandboxes(): Promise<string[]> {
    const ids: string[] = [];
    const pages = Sandbox.list({ ...connection, query: { metadata: { p3live: tag } } });
    while (pages.hasNext) ids.push(...(await pages.nextItems()).map((info) => info.sandboxId));
    return ids;
  }
  async function ownVolumes() {
    return (await Volume.list(connection)).filter((volume) => volumeNames.has(volume.name));
  }
  /**
   * The product's E2B computer, through its SDK seam: this host has no desktop template, so the
   * machine is a plain sandbox of the computer template, tagged, without the desktop layer.
   */
  const computerSdk: E2BSandboxSdk = {
    create: async (options) =>
      (await Sandbox.create(config.computerTemplate, {
        ...connection,
        ...options,
        apiKey: config.apiKey,
        metadata: { ...options.metadata, p3live: tag },
      })) as unknown as Awaited<ReturnType<E2BSandboxSdk["create"]>>,
    connect: async (id, options) =>
      (await Sandbox.connect(id, { ...connection, ...options })) as unknown as Awaited<
        ReturnType<E2BSandboxSdk["connect"]>
      >,
    pause: async (id, options) => {
      await Sandbox.pause(id, { ...connection, ...options });
    },
  };

  return {
    tag,
    config,
    connection,
    guestCommandStarts,
    guestUploadDeadlines,
    /**
     * `maxTimeoutMs` stands for a deployment that kills sandboxes sooner. `guest` replaces the
     * template's guest with a script written into each VM before it starts, `args` after its path.
     */
    workerProvider: (
      maxTimeoutMs?: number,
      guest?: { path: string; script: string; args?: string },
    ) => {
      guest ??= config.guestBundle
        ? { path: "/tmp/rakazo-n13-guest.mjs", script: readFileSync(config.guestBundle, "utf8") }
        : undefined;
      return new E2BWorkerProvider(
        {
          apiKey: config.apiKey,
          apiUrl: config.apiUrl,
          domain: config.domain,
          template: config.workerTemplate,
          harness: config.harness ?? "pi-native",
          maxTimeoutMs,
          ...(guest && { guestEntry: [guest.path, guest.args].filter(Boolean).join(" ") }),
        },
        guest
          ? {
              ...sdk,
              async startGuest(sandboxId, command, options) {
                const { endAt } = await Sandbox.getInfo(sandboxId, connection);
                const timeoutMs = Math.max(endAt.getTime() - Date.now(), 1_000);
                const vm = await Sandbox.connect(sandboxId, { ...connection, timeoutMs });
                const after = await Sandbox.getInfo(sandboxId, connection);
                guestUploadDeadlines.push({
                  before: endAt.toISOString(),
                  after: after.endAt.toISOString(),
                  timeoutMs,
                });
                if (config.guestBundle) {
                  const archive = readFileSync(
                    path.join(path.dirname(config.guestBundle), "managed-skills.tar"),
                  );
                  await vm.files.write(
                    "/tmp/rakazo-managed-skills.tar",
                    new Uint8Array(archive).buffer,
                  );
                  await vm.commands.run(
                    "mkdir -p /managed-skills && tar -xf /tmp/rakazo-managed-skills.tar -C /managed-skills && chmod -R a-w /managed-skills",
                    { user: "root" },
                  );
                }
                await vm.files.write(guest.path, guest.script);
                return sdk.startGuest(sandboxId, command, options);
              },
            }
          : sdk,
      );
    },
    /**
     * The product's E2B computer. Its desktop preparation is skipped: it installs the desktop
     * packages a desktop template carries, which this host's computer template lacks, and the lanes
     * use no screen.
     */
    computer: (): SandboxProvider => {
      const provider = new E2BSandboxProvider(config.apiKey, computerSdk);
      if (config.prepareComputer) return provider;
      return new Proxy(provider, {
        get: (target, key, receiver) =>
          key === "prepare" ? async () => {} : Reflect.get(target, key, receiver),
      });
    },
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
    /** Kills this session's volume-files sandboxes, as E2B does at their timeout. */
    async killVolumeFileSandboxes() {
      const ids: string[] = [];
      const pages = Sandbox.list({
        ...connection,
        query: { metadata: { p3live: tag, rakazo: "volume-files" } },
      });
      while (pages.hasNext) ids.push(...(await pages.nextItems()).map((info) => info.sandboxId));
      for (const id of ids) await Sandbox.kill(id, connection);
      return ids.length;
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
      const left = await this.census();
      if (left.volumes === 0) volumeNames.clear();
      return { killed: sandboxes.length, destroyed: volumes.length, left };
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

/** A provider that does what `provider` does, but for the methods `overrides` replaces. */
export function forward(
  provider: WorkerProvider & GuestConnector,
  overrides: Partial<WorkerProvider & GuestConnector>,
): WorkerProvider & GuestConnector {
  return {
    describe: () => provider.describe(),
    ensure: (spec, ctx) => provider.ensure(spec, ctx),
    prepare: (ref, spec, ctx) => provider.prepare(ref, spec, ctx),
    destroy: (target, ctx) => provider.destroy(target, ctx),
    ensureVolume: (input, ctx) => provider.ensureVolume(input, ctx),
    deleteVolume: (input, ctx) => provider.deleteVolume(input, ctx),
    connect: (target, capability) => provider.connect(target, capability),
    ...overrides,
  };
}
