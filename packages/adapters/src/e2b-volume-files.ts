import type { AdapterContext, PortableFile, VolumeEntry, VolumeFiles } from "@rakazo/adapter-kit";
import { fileMode, isPortablePath } from "@rakazo/adapter-kit";
import { type ConnectionOpts, Sandbox } from "e2b";

/** Where a volume-files sandbox mounts the volume it serves. */
export const VOLUME_FILES_MOUNT = "/mnt/rakazo-volume";

const SANDBOX_TIMEOUT_MS = 60 * 60 * 1000;

/** One sandbox that mounts one volume at `VOLUME_FILES_MOUNT`. Tests stand in for the vendor here. */
export interface VolumeSandbox {
  /** Runs a shell command as root and returns its stdout. Rejects on a non-zero exit. */
  run(command: string, signal: AbortSignal): Promise<string>;
  /** Writes as the guest user, creating missing parent directories, replacing a file. */
  write(path: string, content: Uint8Array, signal: AbortSignal): Promise<void>;
  read(path: string, signal: AbortSignal): Promise<Uint8Array>;
  kill(): Promise<void>;
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
    const sandbox = await this.sandbox(volumeRef);
    const listing = await sandbox.run(
      `node -e ${quoted(LIST_ENTRIES)} ${VOLUME_FILES_MOUNT}`,
      context.signal,
    );
    return JSON.parse(listing) as VolumeEntry[];
  }

  async write(volumeRef: string, file: PortableFile, context: AdapterContext): Promise<void> {
    const target = volumePath(file.path);
    const sandbox = await this.sandbox(volumeRef);
    await sandbox.write(target, file.content, context.signal);
    await sandbox.run(`chmod ${fileMode(file).toString(8)} ${quoted(target)}`, context.signal);
  }

  async read(volumeRef: string, path: string, context: AdapterContext): Promise<Uint8Array> {
    const target = volumePath(path);
    return (await this.sandbox(volumeRef)).read(target, context.signal);
  }

  async close(): Promise<void> {
    const opened = [...this.sandboxes.values()];
    this.sandboxes.clear();
    await Promise.all(opened.map(async (sandbox) => (await sandbox.catch(() => null))?.kill()));
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
