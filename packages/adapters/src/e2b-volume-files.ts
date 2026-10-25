import { randomUUID } from "node:crypto";
import type { AdapterContext, PortableFile, VolumeEntry, VolumeFiles } from "@rakazo/adapter-kit";
import { fileMode, isPortablePath } from "@rakazo/adapter-kit";
import { type ConnectionOpts, Sandbox, SandboxNotFoundError, TimeoutError } from "e2b";

/** Where a volume-files sandbox mounts the volume it serves. */
export const VOLUME_FILES_MOUNT = "/mnt/rakazo-volume";

/**
 * How long a volume-files sandbox lives at most. A sandbox `close` never reached, for example after
 * a crash, is killed by E2B after this.
 */
const SANDBOX_TIMEOUT_MS = 60 * 60 * 1000;
/** How long creating a volume-files sandbox may take before the call gives up. */
const CREATE_TIMEOUT_MS = 2 * 60 * 1000;
/** How long removing a staged file may take, whatever happened to the write that staged it. */
const CLEANUP_TIMEOUT_MS = 30 * 1000;

/**
 * Whether `error` proves the sandbox is gone. The SDK reports a dead sandbox as
 * `SandboxNotFoundError` or as a `TimeoutError` that says it was killed or timed out, but it also
 * raises those for a live sandbox behind a failing proxy, from a 502 on its health check or an
 * unavailable connection. So an error only suggests death, and `exists`, the control plane,
 * decides.
 */
export async function isSandboxGone(
  error: unknown,
  exists: () => Promise<boolean>,
): Promise<boolean> {
  const suggestsDeath =
    error instanceof SandboxNotFoundError ||
    (error instanceof TimeoutError &&
      (error.message.includes("killed or reached its end of life") ||
        error.message.includes("likely due to sandbox timeout")));
  if (!suggestsDeath) return false;
  return !(await exists().catch(() => true));
}

/** One sandbox that mounts one volume at `VOLUME_FILES_MOUNT`. Tests stand in for the vendor here. */
export interface VolumeSandbox {
  /** Runs a shell command and returns its stdout. Rejects on a non-zero exit. */
  run(command: string, signal: AbortSignal, user: "root" | "user"): Promise<string>;
  /** Writes as the guest user into the file, keeping the mode of a file that exists. */
  write(path: string, content: Uint8Array, signal: AbortSignal): Promise<void>;
  read(path: string, signal: AbortSignal): Promise<Uint8Array>;
  kill(): Promise<void>;
  /** Whether `error` proves the sandbox no longer exists, so a new one must be opened. */
  isGone(error: unknown): Promise<boolean>;
}

export type OpenVolumeSandbox = (volumeRef: string) => Promise<VolumeSandbox>;

/**
 * Boots a sandbox of `template` with only the volume mounted. It reaches the files through the
 * same mount a run uses, which every E2B deployment serves, where the volume content API is
 * missing on a self-hosted one.
 */
export function e2bVolumeSandbox(options: {
  template: string;
  connection?: ConnectionOpts;
  /** Tags each sandbox, beside `rakazo: "volume-files"`. */
  metadata?: Record<string, string>;
}): OpenVolumeSandbox {
  return async (volumeRef) => {
    const sandbox = await Sandbox.create(options.template, {
      ...options.connection,
      secure: true,
      metadata: { ...options.metadata, rakazo: "volume-files" },
      volumeMounts: { [VOLUME_FILES_MOUNT]: volumeRef },
      timeoutMs: SANDBOX_TIMEOUT_MS,
      lifecycle: { onTimeout: "kill" },
      requestTimeoutMs: CREATE_TIMEOUT_MS,
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    });
    return {
      async run(command, signal, user) {
        const result = await sandbox.commands.run(command, { user, timeoutMs: 0, signal });
        return result.stdout;
      },
      async write(path, content, signal) {
        const copy = content.slice();
        await sandbox.files.write(path, copy.buffer, { signal });
      },
      read: (path, signal) => sandbox.files.read(path, { format: "bytes", signal }),
      kill: async () => {
        await sandbox.kill();
      },
      isGone: (error) =>
        isSandboxGone(error, () =>
          Sandbox.getInfo(sandbox.sandboxId, options.connection).then(
            () => true,
            (failure: unknown) => {
              if (failure instanceof SandboxNotFoundError) return false;
              throw failure;
            },
          ),
        ),
    };
  };
}

/** Prints every entry under its argument as JSON `VolumeEntry`s, without following links. */
const LIST_ENTRIES = [
  'const fs = require("fs"), root = process.argv[1], entries = [];',
  "const walk = (dir) => {",
  "  for (const name of fs.readdirSync(root + dir)) {",
  '    const path = dir ? dir.slice(1) + "/" + name : name, info = fs.lstatSync(root + "/" + path);',
  '    const kind = info.isDirectory() ? "dir" : info.isFile() ? "file" : "other";',
  "    entries.push({ path, kind, mode: info.mode & 0o777 });",
  '    if (kind === "dir") walk("/" + path);',
  "  }",
  "};",
  'walk("");',
  "process.stdout.write(JSON.stringify(entries));",
].join("\n");

/** Gives a written temporary file its mode, then renames it over its target, never into a directory. */
const PLACE_FILE = [
  'const fs = require("fs"), [temporary, target, mode] = process.argv.slice(1);',
  "try {",
  "  fs.chmodSync(temporary, Number.parseInt(mode, 8));",
  "  fs.renameSync(temporary, target);",
  "} catch (error) {",
  "  fs.rmSync(temporary, { force: true });",
  "  throw error;",
  "}",
].join("\n");

/** A single-quoted shell word. */
const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * Whole E2B volumes, by the name the E2B worker provider records as their provider reference,
 * each through a sandbox that mounts it. `close` destroys those sandboxes.
 */
export class E2BVolumeFiles implements VolumeFiles {
  private readonly sandboxes = new Map<string, Promise<VolumeSandbox>>();
  /** Sandboxes replaced after they died whose destroy failed; `close` tries them again. */
  private readonly undestroyed: VolumeSandbox[] = [];

  constructor(private readonly open: OpenVolumeSandbox) {}

  async list(volumeRef: string, context: AdapterContext): Promise<VolumeEntry[]> {
    const listing = await this.withSandbox(volumeRef, (sandbox) =>
      sandbox.run(`node -e ${quoted(LIST_ENTRIES)} ${VOLUME_FILES_MOUNT}`, context.signal, "root"),
    );
    return JSON.parse(listing) as VolumeEntry[];
  }

  /**
   * Stages the file beside its target, created 0600 before any byte lands, then sets its mode and
   * renames it over the target. The target never holds part of the file or a wider mode, and a link
   * at the target is replaced rather than followed. A staged file the write could not place is
   * removed, also when the write was cancelled.
   */
  async write(volumeRef: string, file: PortableFile, context: AdapterContext): Promise<void> {
    const target = volumePath(file.path);
    const directory = target.slice(0, target.lastIndexOf("/") + 1);
    const mode = fileMode(file).toString(8);
    const staged: string[] = [];
    await this.withSandbox(volumeRef, async (sandbox) => {
      const remove = (path: string) =>
        sandbox
          .run(`rm -f ${quoted(path)}`, AbortSignal.timeout(CLEANUP_TIMEOUT_MS), "root")
          .catch(() => undefined);
      // Left by an attempt on a sandbox that died.
      for (const path of staged.splice(0)) await remove(path);
      const temporary = `${directory}.rakazo-${randomUUID()}`;
      staged.push(temporary);
      try {
        await sandbox.run(
          `mkdir -p ${quoted(directory)} && (set -C; umask 077; : > ${quoted(temporary)})`,
          context.signal,
          "user",
        );
        await sandbox.write(temporary, file.content, context.signal);
        await sandbox.run(
          `node -e ${quoted(PLACE_FILE)} ${quoted(temporary)} ${quoted(target)} ${mode}`,
          context.signal,
          "root",
        );
        staged.pop();
      } catch (error) {
        if (!(await sandbox.isGone(error))) {
          await remove(temporary);
          staged.pop();
        }
        throw error;
      }
    });
  }

  async read(volumeRef: string, path: string, context: AdapterContext): Promise<Uint8Array> {
    const target = volumePath(path);
    return this.withSandbox(volumeRef, (sandbox) => sandbox.read(target, context.signal));
  }

  /** Destroys every sandbox opened, and reports the first failure once all were tried. */
  async close(): Promise<void> {
    const opened = [...this.sandboxes.values()];
    this.sandboxes.clear();
    const leftover = this.undestroyed.splice(0);
    const results = await Promise.allSettled([
      ...opened.map(async (sandbox) => (await sandbox.catch(() => null))?.kill()),
      ...leftover.map((sandbox) => sandbox.kill()),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  /**
   * Runs `step` on the volume's sandbox. Only when the failure proves that sandbox gone does it run
   * `step` once more on a new one, so two sandboxes never write for the same call.
   */
  private async withSandbox<T>(
    volumeRef: string,
    step: (sandbox: VolumeSandbox) => Promise<T>,
  ): Promise<T> {
    const opening = this.sandbox(volumeRef);
    const sandbox = await opening;
    try {
      return await step(sandbox);
    } catch (error) {
      if (!(await sandbox.isGone(error))) throw error;
      if (this.sandboxes.get(volumeRef) === opening) this.sandboxes.delete(volumeRef);
      await sandbox.kill().catch(() => this.undestroyed.push(sandbox));
      return step(await this.sandbox(volumeRef));
    }
  }

  private sandbox(volumeRef: string): Promise<VolumeSandbox> {
    const known = this.sandboxes.get(volumeRef);
    if (known) return known;
    const opening = this.open(volumeRef);
    this.sandboxes.set(volumeRef, opening);
    opening.catch(() => this.sandboxes.delete(volumeRef));
    return opening;
  }
}

function volumePath(path: string): string {
  if (!isPortablePath(path)) throw new Error(`Refusing the volume path ${JSON.stringify(path)}`);
  return `${VOLUME_FILES_MOUNT}/${path}`;
}
