import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterContext,
  AdapterDescriptor,
  WorkerCapabilities,
  WorkerProvider,
  WorkerSpec,
} from "@rakazo/adapter-kit";
import {
  type ChannelFaults,
  type FrameChannel,
  type GuestConnector,
  memoryChannelPair,
  streamChannel,
  WORKER_LIMITS,
} from "@rakazo/adapters/runtime-worker";
import { HARNESSES, runGuest } from "@rakazo/agent-run-worker";

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
const GUEST_ENTRY = fileURLToPath(
  new URL("./main.ts", import.meta.resolve("@rakazo/agent-run-worker")),
);

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
 * Workers on this machine, for tests and P3's local runs: a VM is a directory, its guest runs the
 * harness in this process (`memory`) or as a child process over stdio (`child`). Never composed in
 * production.
 */
export class LocalWorkerProvider implements WorkerProvider, GuestConnector {
  /** Attempt ids whose guest was started, in order. */
  readonly launches: string[] = [];
  private readonly vms = new Map<string, Vm>();

  constructor(
    private readonly options: {
      mode: "memory" | "child";
      /** Each VM gets a directory under it; the guest sees it as `/`. */
      root: string;
      faults?: LocalWorkerFaults;
    },
  ) {}

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
      this.vms.set(providerRef, { spec, root });
    }
    return { providerRef };
  }

  async prepare(): Promise<void> {}

  connect(
    target: { attemptId: string; providerRef: string },
    capability: string,
  ): { connections: AsyncIterable<FrameChannel>; exited: Promise<void> } {
    const vm = this.vms.get(target.providerRef);
    if (!vm) throw new Error(`No local worker ${target.providerRef}`);
    this.launches.push(target.attemptId);
    const { connections, guest } =
      this.options.mode === "memory"
        ? this.memoryGuest(vm, capability)
        : this.childGuest(vm, capability);
    vm.guest = guest;
    return { connections, exited: guest.exited };
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

  async ensureVolume(): Promise<{ providerRef: string }> {
    throw new Error("Local workers mount no volume");
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
      harness: HARNESSES.pi!,
      spoolDir: path.join(vm.root, "tmp", "tool-output"),
      root: vm.root,
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
    const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", GUEST_ENTRY], {
      cwd: path.dirname(GUEST_ENTRY),
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        RAKAZO_WORKER_CAPABILITY: capability,
        RAKAZO_WORKER_HARNESS: "pi",
        RAKAZO_WORKER_ROOT: vm.root,
        RAKAZO_WORKER_SPOOL_DIR: path.join(vm.root, "tmp", "tool-output"),
      },
    });
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      child.once("exit", () => resolve());
    });
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
