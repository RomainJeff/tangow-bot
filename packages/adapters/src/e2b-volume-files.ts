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

/** One sandbox that mounts one volume at `VOLUME_FILES_MOUNT`. Tests stand in for the vendor here. */
export interface VolumeSandbox {
  /** Runs a shell command as root and returns its stdout. Rejects on a non-zero exit. */
  run(command: string, signal: AbortSignal): Promise<string>;
  /** Writes as the guest user, creating missing parent directories, replacing a file. */
  write(path: string, content: Uint8Array, signal: AbortSignal): Promise<void>;
  read(path: string, signal: AbortSignal): Promise<Uint8Array>;
  kill(): Promise<void>;
  /** Whether `error` means the sandbox no longer exists, so a new one must be opened. */
  isGone(error: unknown): boolean;
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
      async run(command, signal) {
        const result = await sandbox.commands.run(command, { user: "root", timeoutMs: 0, signal });
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
        error instanceof SandboxNotFoundError ||
        // The SDK maps envd's 502, which a killed sandbox answers, to this timeout.
        (error instanceof TimeoutError && error.message.includes("likely due to sandbox timeout")),
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

  constructor(private readonly open: OpenVolumeSandbox) {}

  async list(volumeRef: string, context: AdapterContext): Promise<VolumeEntry[]> {
    const listing = await this.withSandbox(volumeRef, (sandbox) =>
      sandbox.run(`node -e ${quoted(LIST_ENTRIES)} ${VOLUME_FILES_MOUNT}`, context.signal),
    );
    return JSON.parse(listing) as VolumeEntry[];
  }

  /**
   * Writes beside the target, sets the mode, then renames over it, so the target never holds part
   * of the file or a wider mode, and a link at the target is replaced rather than followed.
   */
  async write(volumeRef: string, file: PortableFile, context: AdapterContext): Promise<void> {
    const target = volumePath(file.path);
    const temporary = `${target.slice(0, target.lastIndexOf("/") + 1)}.rakazo-${randomUUID()}`;
    const mode = fileMode(file).toString(8);
    await this.withSandbox(volumeRef, async (sandbox) => {
      await sandbox.write(temporary, file.content, context.signal);
      await sandbox.run(
        `node -e ${quoted(PLACE_FILE)} ${quoted(temporary)} ${quoted(target)} ${mode}`,
        context.signal,
      );
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
    const results = await Promise.allSettled(
      opened.map(async (sandbox) => (await sandbox.catch(() => null))?.kill()),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  /** Runs `step` on the volume's sandbox, once more on a new sandbox if the first one is gone. */
  private async withSandbox<T>(
    volumeRef: string,
    step: (sandbox: VolumeSandbox) => Promise<T>,
  ): Promise<T> {
    const opening = this.sandbox(volumeRef);
    const sandbox = await opening;
    try {
      return await step(sandbox);
    } catch (error) {
      if (!sandbox.isGone(error)) throw error;
      if (this.sandboxes.get(volumeRef) === opening) this.sandboxes.delete(volumeRef);
      // Not left running if it only looked gone.
      await sandbox.kill().catch(() => undefined);
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
