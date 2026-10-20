import type {
  AdapterDescriptor,
  WorkerCapabilities,
  WorkerProvider,
  WorkerSpec,
} from "@rakazo/adapter-kit";
import { volumeMountPath } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { CommandExitError, type ConnectionOpts, Sandbox, type SandboxOpts, Volume } from "e2b";
import { encodeFrameLine, type FrameChannel, readFrameLines } from "./runtime-worker/framing.js";
import type { GuestConnector } from "./runtime-worker/launcher.js";
import { WORKER_LIMITS } from "./runtime-worker/limits.js";

/** Where the worker template puts the guest bundle. */
export const E2B_WORKER_GUEST_ENTRY = "/opt/rakazo/agent-run-worker.mjs";

/**
 * `ensure` stops creating this long before the shared ensure deadline, so a create the server
 * accepted lands and is tagged before a release trusts `absent`.
 */
export const E2B_CREATE_MARGIN_MS = 60_000;

/**
 * The longest sandbox timeout E2B accepts by default: its base plan, and a self-hosted deployment
 * left at its default, refuse a create that asks for more. A worker outliving it is killed.
 */
export const E2B_DEFAULT_MAX_TIMEOUT_MS = 60 * 60 * 1000;

const LOG_TEXT_CHARS = 2048;
const UNPRINTABLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters escaped
  /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

/** Guest or vendor text as an inert log field: its end, cut, with controls and bidi marks escaped. */
function logText(text: string): string {
  return text
    .slice(-LOG_TEXT_CHARS)
    .replace(UNPRINTABLE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export interface E2BWorkerConfig {
  apiKey: string;
  domain?: string;
  apiUrl?: string;
  /** The template built from `apps/agent-run-worker/template`. */
  template: string;
  guestEntry?: string;
  /** The harness the guest runs, by the name it registers. */
  harness?: string;
  /** The deployment's sandbox timeout limit. Default `E2B_DEFAULT_MAX_TIMEOUT_MS`. */
  maxTimeoutMs?: number;
}

export type E2BWorkerSandbox = Pick<
  SandboxOpts,
  "metadata" | "envs" | "timeoutMs" | "requestTimeoutMs" | "signal"
> & {
  template: string;
  secure: true;
  volumeMounts: Record<string, string>;
  lifecycle: { onTimeout: "kill" };
};

export interface E2BGuestCommand {
  sendStdin(data: string): Promise<void>;
  closeStdin(): Promise<void>;
  /** Resolves with the exit code once the command ended. Rejects when its stream broke first. */
  wait(): Promise<number>;
}

/** The E2B calls a worker makes. Tests stand in for the vendor here. */
export interface E2BWorkerSdk {
  listSandboxes(metadata: Record<string, string>): Promise<string[]>;
  createSandbox(options: E2BWorkerSandbox): Promise<string>;
  /** False when the sandbox is already gone. */
  killSandbox(sandboxId: string): Promise<boolean>;
  startGuest(
    sandboxId: string,
    command: string,
    options: {
      envs: Record<string, string>;
      onStdout(data: string): Promise<void>;
      onStderr(data: string): void;
    },
  ): Promise<E2BGuestCommand>;
  listVolumes(): Promise<string[]>;
  createVolume(name: string): Promise<string>;
}

export function e2bWorkerSdk(connection: ConnectionOpts): E2BWorkerSdk {
  const opened = new Map<string, Sandbox>();
  const open = async (sandboxId: string) => {
    const known = opened.get(sandboxId);
    if (known) return known;
    // Connecting sets the sandbox timeout: keep the end `ensure` gave it.
    const { endAt } = await Sandbox.getInfo(sandboxId, connection);
    const sandbox = await Sandbox.connect(sandboxId, {
      ...connection,
      timeoutMs: Math.max(endAt.getTime() - Date.now(), 1_000),
    });
    opened.set(sandboxId, sandbox);
    return sandbox;
  };
  return {
    async listSandboxes(metadata) {
      const ids: string[] = [];
      const pages = Sandbox.list({ ...connection, query: { metadata } });
      while (pages.hasNext) ids.push(...(await pages.nextItems()).map((info) => info.sandboxId));
      return ids;
    },
    async createSandbox({ template, ...options }) {
      const sandbox = await Sandbox.create(template, { ...connection, ...options });
      opened.set(sandbox.sandboxId, sandbox);
      return sandbox.sandboxId;
    },
    killSandbox(sandboxId) {
      opened.delete(sandboxId);
      return Sandbox.kill(sandboxId, connection);
    },
    async startGuest(sandboxId, command, options) {
      const sandbox = await open(sandboxId);
      const handle = await sandbox.commands.run(command, {
        ...options,
        background: true,
        stdin: true,
        timeoutMs: 0,
      });
      return {
        sendStdin: (data) => handle.sendStdin(data),
        closeStdin: () => handle.closeStdin(),
        wait: () =>
          handle.wait().then(
            (result) => result.exitCode,
            (error: unknown) => {
              if (error instanceof CommandExitError) return error.exitCode;
              throw error;
            },
          ),
      };
    },
    async listVolumes() {
      return (await Volume.list(connection)).map((volume) => volume.name);
    },
    async createVolume(name) {
      return (await Volume.create(name, connection)).name;
    },
  };
}

/** Hands each stdout chunk to the reader and resolves once it took it, so a slow reader slows E2B. */
function handoff() {
  const queued: Array<{ chunk: string; taken: () => void }> = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const end = () => {
    ended = true;
    for (const { taken } of queued.splice(0)) taken();
    wake?.();
  };
  return {
    end,
    push(chunk: string): Promise<void> {
      if (ended) return Promise.resolve();
      return new Promise<void>((taken) => {
        queued.push({ chunk, taken });
        wake?.();
      });
    },
    async *chunks(): AsyncGenerator<string> {
      try {
        while (true) {
          const next = queued.shift();
          if (next) {
            next.taken();
            yield next.chunk;
          } else if (ended) return;
          else await new Promise<void>((resume) => (wake = resume));
        }
      } finally {
        end();
      }
    },
  };
}

const attemptTag = (attemptId: string) => ({ rakazo: "worker", attemptId });

/**
 * Run workers as E2B sandboxes, one per attempt, tagged with its id. The guest is the bundle the
 * worker template installs, driven over its stdio through E2B's command API, the only route
 * between controller and guest. Volumes are referenced by name, which is what an E2B mount takes.
 */
export class E2BWorkerProvider implements WorkerProvider, GuestConnector {
  private readonly sdk: E2BWorkerSdk;
  /** What settles each connected guest's `exited`, by sandbox, until it is seen gone. */
  private readonly guests = new Map<string, Set<() => void>>();

  constructor(
    private readonly config: E2BWorkerConfig,
    sdk?: E2BWorkerSdk,
  ) {
    this.sdk =
      sdk ?? e2bWorkerSdk({ apiKey: config.apiKey, domain: config.domain, apiUrl: config.apiUrl });
  }

  describe(): AdapterDescriptor<WorkerCapabilities> {
    return {
      id: "e2b-worker",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { readOnlyMounts: false },
    };
  }

  async ensure(spec: WorkerSpec): Promise<{ providerRef: string }> {
    const deadline = spec.ensureDeadline.getTime() - E2B_CREATE_MARGIN_MS;
    const metadata = attemptTag(spec.attemptId);
    const [existing] = await this.sdk.listSandboxes(metadata);
    if (existing) return { providerRef: existing };
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`The worker of ${spec.attemptId} missed its deadline`);
    const privateMount = volumeMountPath({ kind: "bot_private", botId: spec.botId });
    const providerRef = await this.sdk.createSandbox({
      template: this.config.template,
      secure: true,
      metadata,
      envs: {
        RAKAZO_WORKER_HARNESS: this.config.harness ?? "pi",
        ...(spec.mounts.some((mount) => mount.path === privateMount) && {
          RAKAZO_WORKER_SPOOL_DIR: `${privateMount}/.rakazo/tool-output`,
        }),
      },
      volumeMounts: Object.fromEntries(spec.mounts.map((mount) => [mount.path, mount.volumeRef])),
      timeoutMs: this.sandboxTimeoutMs(spec),
      lifecycle: { onTimeout: "kill" },
      requestTimeoutMs: remainingMs,
      signal: AbortSignal.timeout(remainingMs),
    });
    return { providerRef };
  }

  /**
   * The worker's TTL, or the deployment's limit when that is lower: then the VM dies before the
   * TTL the lifecycle counts on, so the cap is logged.
   */
  private sandboxTimeoutMs(spec: WorkerSpec): number {
    const ttlMs = spec.ttlSeconds * 1000;
    const limitMs = this.config.maxTimeoutMs ?? E2B_DEFAULT_MAX_TIMEOUT_MS;
    if (ttlMs <= limitMs) return ttlMs;
    getLogger().warn("e2b worker sandbox timeout capped below the worker TTL", {
      attemptId: spec.attemptId,
      ttlMs,
      timeoutMs: limitMs,
    });
    return limitMs;
  }

  /** The sandbox runs with its mounts once created; the guest's hello is the readiness check. */
  async prepare(): Promise<void> {}

  async destroy(target: {
    attemptId: string;
    providerRef: string | null;
  }): Promise<"destroyed" | "absent"> {
    const ids = new Set(await this.sdk.listSandboxes(attemptTag(target.attemptId)));
    if (target.providerRef) ids.add(target.providerRef);
    const killed = await Promise.all(
      [...ids].map(async (id) => {
        const existed = await this.sdk.killSandbox(id);
        for (const gone of this.guests.get(id) ?? []) gone();
        return existed;
      }),
    );
    return killed.includes(true) ? "destroyed" : "absent";
  }

  async ensureVolume(input: { name: string }): Promise<{ providerRef: string }> {
    const names = await this.sdk.listVolumes();
    return {
      providerRef: names.includes(input.name)
        ? input.name
        : await this.sdk.createVolume(input.name),
    };
  }

  /**
   * One connection per attempt. Stdio is a single stream: E2B does not replay output produced while
   * the controller was detached, and the guest never learns that its stdout was, so it would not
   * resend. A broken stream or a failed send ends the connection, and the run's next attempt starts
   * a new guest. `exited` settles only once the command's exit was observed or a destroy confirmed
   * the sandbox gone, since the guest may outlive a broken stream.
   */
  connect(
    target: { attemptId: string; providerRef: string },
    capability: string,
  ): { connections: AsyncIterable<FrameChannel>; exited: Promise<void> } {
    const stdout = handoff();
    let stderr = "";
    let resolveExited = () => {};
    let isGone = false;
    const exited = new Promise<void>((resolve) => (resolveExited = resolve));
    const guests = this.guests.get(target.providerRef) ?? new Set();
    this.guests.set(target.providerRef, guests);
    const gone = () => {
      guests.delete(gone);
      if (guests.size === 0 && this.guests.get(target.providerRef) === guests) {
        this.guests.delete(target.providerRef);
      }
      isGone = true;
      stdout.end();
      resolveExited();
    };
    guests.add(gone);
    const lost = (error: unknown) => {
      stdout.end();
      // A destroyed sandbox breaks the stream too: that is no loss.
      if (isGone) return;
      getLogger().info("e2b worker guest connection lost", {
        attemptId: target.attemptId,
        errorName: error instanceof Error ? error.name : typeof error,
        errorText: logText(error instanceof Error ? error.message : String(error)),
        stderrTail: logText(stderr),
      });
    };

    const command = this.sdk.startGuest(
      target.providerRef,
      `node ${this.config.guestEntry ?? E2B_WORKER_GUEST_ENTRY}`,
      {
        envs: { RAKAZO_WORKER_CAPABILITY: capability },
        onStdout: (data) => stdout.push(data),
        onStderr: (data) => {
          stderr = (stderr + data).slice(-LOG_TEXT_CHARS);
        },
      },
    );
    command
      .then((guest) => guest.wait())
      .then((exitCode) => {
        if (exitCode !== 0) {
          getLogger().info("e2b worker guest exited with an error", {
            attemptId: target.attemptId,
            exitCode,
            stderrTail: logText(stderr),
          });
        }
        gone();
      }, lost);

    async function* connections(): AsyncGenerator<FrameChannel> {
      const guest = await command.catch(() => undefined);
      if (!guest) return;
      let sending = Promise.resolve();
      let dead = false;
      const close = () => {
        stdout.end();
        void guest.closeStdin().catch(() => undefined);
      };
      yield {
        frames: readFrameLines(stdout.chunks(), WORKER_LIMITS.modelRequestBytes),
        send(frame) {
          const line = encodeFrameLine(frame);
          sending = sending.then(async () => {
            if (dead) return;
            try {
              await guest.sendStdin(line);
            } catch (error) {
              // Later frames would follow a gap, or glue onto a half-written line.
              dead = true;
              lost(error);
              close();
            }
          });
          return sending;
        },
        close,
      };
    }
    return { connections: connections(), exited };
  }
}
