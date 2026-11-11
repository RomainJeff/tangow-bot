import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { cp, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterContext,
  AdapterDescriptor,
  WorkerCapabilities,
  WorkerProvider,
  WorkerSpec,
} from "@tangow/adapter-kit";
import type { ChannelFaults, FrameChannel, GuestConnector } from "@tangow/adapters/runtime-worker";
import { memoryChannelPair, streamChannel, WORKER_LIMITS } from "@tangow/adapters/runtime-worker";
import type { GuestHarness } from "@tangow/agent-run-worker";
import { HARNESSES, runGuest } from "@tangow/agent-run-worker";
import type { PrismaClient } from "@tangow/db";
import { VolumeComputer } from "./volume-computer.js";

export interface LocalWorkerFaults extends ChannelFaults {
  /** Connections the in-memory guest may open after its first. Default 0. */
  reconnects?: number;
  /** `worker.cancel` never reaches the guest. */
  guestIgnoresCancel?: boolean;
  /** `destroy` never answers, like a provider that cannot confirm. */
  destroyNeverConfirms?: boolean;
}

type Guest = { exited: Promise<void>; kill(): Promise<void> };
type Vm = { spec: WorkerSpec; root: string; guest?: Guest };

const KILL_GRACE_MS = 2_000;
/** The guest's source entry, resolved on use: a bundled harness has no package to resolve. */
const guestEntry = () =>
  fileURLToPath(new URL("./main.ts", import.meta.resolve("@tangow/agent-run-worker")));

function channelQueue() {
  const queued: FrameChannel[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    push(channel: FrameChannel) {
      queued.push(channel);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *channels(): AsyncGenerator<FrameChannel> {
      while (true) {
        const next = queued.shift();
        if (next) yield next;
        else if (ended) return;
        else await new Promise<void>((resume) => (wake = resume));
      }
    },
  };
}

function isCancel(frame: Uint8Array) {
  return (JSON.parse(Buffer.from(frame).toString()) as { kind?: string }).kind === "worker.cancel";
}

/**
 * Workers on this machine, for tests, canaries and evals: a VM is a directory, its guest runs the
 * harness in this process (`memory`) or as a child process over stdio (`child`). A volume is a
 * directory beside the VMs, linked at its mount path and kept when the VM is destroyed. Never
 * composed in production.
 */
export class LocalWorkerProvider implements WorkerProvider, GuestConnector {
  /** Attempt ids whose guest was started, in order. */
  readonly launches: string[] = [];
  private readonly harness: GuestHarness;
  private readonly vms = new Map<string, Vm>();

  constructor(
    private readonly options: {
      mode: "memory" | "child";
      /** Each VM gets a directory under it; the guest sees it as `/`. */
      root: string;
      faults?: LocalWorkerFaults;
      /** A bundled guest for `child` mode, run by plain `node`. Default: the source, through tsx. */
      entry?: string;
      /** The baked managed skills a VM gets. Default: the repository's `skills/agent`. */
      managedSkills?: string;
      /** The harness a `memory` guest runs. Default: Pi native. */
      harness?: GuestHarness;
    },
  ) {
    this.harness = options.harness ?? HARNESSES["pi-native"]!;
  }

  describe(): AdapterDescriptor<WorkerCapabilities> {
    return {
      id: "local-worker",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { readOnlyMounts: false },
    };
  }

  async ensure(spec: WorkerSpec, _context: AdapterContext): Promise<{ providerRef: string }> {
    const providerRef = `local-${spec.attemptId}`;
    if (!this.vms.has(providerRef)) {
      const root = path.join(this.options.root, spec.attemptId);
      await mkdir(path.join(root, "workspace"), { recursive: true });
      await cp(
        this.options.managedSkills ??
          fileURLToPath(new URL("../../../skills/agent", import.meta.url)),
        path.join(root, "managed-skills", "agent"),
        { recursive: true },
      );
      for (const mount of spec.mounts) {
        const volume = this.volumePath(mount.volumeRef);
        await mkdir(volume, { recursive: true });
        await mkdir(path.dirname(path.join(root, mount.path)), { recursive: true });
        await symlink(volume, path.join(root, mount.path));
      }
      this.vms.set(providerRef, { spec, root });
    }
    return { providerRef };
  }

  async prepare(): Promise<void> {}

  connect(
    target: { attemptId: string; providerRef: string },
    capability: string,
  ): ReturnType<GuestConnector["connect"]> {
    const vm = this.vms.get(target.providerRef);
    if (!vm) throw new Error(`No local worker ${target.providerRef}`);
    this.launches.push(target.attemptId);
    const { connections, guest } =
      this.options.mode === "memory"
        ? this.memoryGuest(vm, capability)
        : this.childGuest(vm, capability);
    vm.guest = guest;
    return { expectedHarness: this.harness.declaration, connections, exited: guest.exited };
  }

  async destroy(
    target: { attemptId: string; providerRef: string | null },
    _context: AdapterContext,
  ): Promise<"destroyed" | "absent"> {
    if (this.options.faults?.destroyNeverConfirms) return new Promise(() => undefined);
    const entry = [...this.vms].find(([, vm]) => vm.spec.attemptId === target.attemptId);
    if (!entry) return "absent";
    const [ref, vm] = entry;
    await vm.guest?.kill();
    this.vms.delete(ref);
    await rm(vm.root, { recursive: true, force: true });
    return "destroyed";
  }

  async ensureVolume(input: {
    name: string;
    ensureDeadline: Date;
  }): Promise<{ providerRef: string }> {
    if (Date.now() >= input.ensureDeadline.getTime())
      throw new Error("Volume creation missed its deadline");
    await mkdir(this.volumePath(input.name), { recursive: true });
    return { providerRef: input.name };
  }

  async deleteVolume(input: { providerRef: string }): Promise<void> {
    await rm(this.volumePath(input.providerRef), { recursive: true, force: true });
  }

  /** Where a volume's files are, on this machine. */
  volumePath(volumeRef: string): string {
    return path.join(this.options.root, "volumes", volumeRef);
  }

  /** Kills every guest still running, whatever the faults. */
  async dispose(): Promise<void> {
    await Promise.all([...this.vms.values()].map((vm) => vm.guest?.kill()));
    this.vms.clear();
  }

  private memoryGuest(vm: Vm, capability: string) {
    const faults = this.options.faults ?? {};
    const controllerSide = channelQueue();
    let current: ReturnType<typeof memoryChannelPair> | undefined;
    let killed = false;
    const pairFaults: ChannelFaults = {
      ...faults,
      dropControllerFrame: (frame) =>
        (faults.guestIgnoresCancel === true && frame.kind === "worker.cancel") ||
        Boolean(faults.dropControllerFrame?.(frame)),
    };
    async function* guestSide() {
      for (let opened = 0; opened <= (faults.reconnects ?? 0) && !killed; opened++) {
        current = memoryChannelPair(pairFaults);
        controllerSide.push(current.controller);
        yield current.guest;
      }
    }
    const exited = runGuest({
      channels: guestSide(),
      capability,
      harness: this.harness,
      root: vm.root,
      home: path.join(vm.root, "home/user"),
    }).then(
      () => controllerSide.end(),
      () => controllerSide.end(),
    );
    const guest: Guest = {
      exited,
      async kill() {
        killed = true;
        current?.guest.close();
        await exited;
      },
    };
    return { connections: controllerSide.channels(), guest };
  }

  private childGuest(vm: Vm, capability: string) {
    const faults = this.options.faults ?? {};
    const entry = this.options.entry ?? guestEntry();
    const args = this.options.entry ? [entry] : ["--import", "tsx", entry];
    const child: ChildProcess = spawn(process.execPath, args, {
      cwd: path.dirname(entry),
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      // Like a VM, the guest gets none of this process's keys: live runs let a model run commands.
      env: {
        PATH: process.env.PATH,
        TANGOW_WORKER_CAPABILITY: capability,
        TANGOW_WORKER_HARNESS: this.harness.declaration.name,
        TANGOW_WORKER_ROOT: vm.root,
        TANGOW_WORKER_HOME: path.join(vm.root, "home/user"),
      },
    });
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      child.once("exit", () => resolve());
    });
    // A frame written after the guest exited fails with EPIPE; a channel drops it, as on a cut socket.
    child.stdin!.on("error", () => undefined);
    const stdio = streamChannel(child.stdout!, child.stdin!, WORKER_LIMITS.modelRequestBytes);
    const channel: FrameChannel = {
      frames: stdio.frames,
      async send(frame) {
        if (faults.guestIgnoresCancel && isCancel(frame)) return;
        await stdio.send(frame);
      },
      close() {
        stdio.close();
        child.stdout?.destroy();
      },
    };
    async function* connections() {
      yield channel;
    }
    const signalGroup = (name: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, name);
      } catch {
        // The group is already gone.
      }
    };
    const guest: Guest = {
      exited,
      async kill() {
        signalGroup("SIGTERM");
        const forced = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
        await exited;
        clearTimeout(forced);
      },
    };
    return { connections: connections(), guest };
  }
}

/**
 * What `createApp` takes to run bots in workers on this machine, each guest a child process by
 * default, on a fake computer whose files are the workers' volumes.
 */
export function localWorkerApp(root: string, mode: "memory" | "child" = "child") {
  const workers = new LocalWorkerProvider({ mode, root });
  return {
    agentRuntime: "worker" as const,
    workers,
    sandbox: new VolumeComputer((volumeRef) => workers.volumePath(volumeRef)),
  };
}

/**
 * Puts a new bot's computer on volumes, as a Docker or E2B deployment creates it: the test
 * providers' computers start on snapshots. Its volumes are created at its first run.
 */
export async function computerOnVolumes(
  prisma: Pick<PrismaClient, "bot" | "computer">,
  botId: string,
): Promise<void> {
  const { computerId } = await prisma.bot.findUniqueOrThrow({
    where: { id: botId },
    select: { computerId: true },
  });
  if (!computerId) return;
  await prisma.computer.update({
    where: { id: computerId },
    data: { kind: "e2b", homeStorage: "volumes" },
  });
}
