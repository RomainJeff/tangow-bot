import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerFileEntry,
  ComputerRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
} from "@tangow/adapter-kit";
import { E2BSandboxEmulator } from "@tangow/adapters";
import type { VolumeHome } from "@tangow/core";
import { underVolumeMounts } from "@tangow/core";

/**
 * The fake E2B computer, whose files live on the volumes it was provisioned with when its home is
 * on volumes, the way an E2B computer mounts them: the same directories a local worker mounts.
 */
export class VolumeComputer extends E2BSandboxEmulator {
  private readonly homes = new Map<string, VolumeHome>();

  constructor(private readonly volumeDir: (volumeRef: string) => string) {
    super();
  }

  override async provision(
    request: Parameters<SandboxProvider["provision"]>[0],
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const ref = await super.provision(request, context);
    if (request.volumeHome) this.homes.set(ref.id, request.volumeHome);
    return ref;
  }

  private onVolume(computer: ComputerRef, relative: string): string | undefined {
    const home = this.homes.get(computer.id);
    if (!home) return undefined;
    const absolute = path.posix.join(home.root, relative);
    const mount = home.mounts.find(
      (candidate) => absolute === candidate.path || absolute.startsWith(`${candidate.path}/`),
    );
    if (!mount) throw new Error(`${absolute} is on no mounted volume`);
    return path.join(this.volumeDir(mount.volumeRef), absolute.slice(mount.path.length));
  }

  /** Answers a command with where it ran on the computer instead of running it. */
  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const home = this.homes.get(computer.id);
    if (!home) return yield* super.execute(computer, request, context);
    const cwd = request.cwd ?? "";
    const directory = underVolumeMounts(cwd) ? cwd : path.posix.join(home.root, cwd);
    yield { type: "stdout", data: `computer ran ${request.argv.at(-1)} in ${directory}\n` };
    yield { type: "exit", code: 0 };
  }

  override async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const local = this.onVolume(computer, directory);
    if (!local) return super.listFiles(computer, directory, context);
    const prefix = directory ? `${directory.replace(/\/+$/, "")}/` : "";
    return Promise.all(
      (await readdir(local, { withFileTypes: true })).map(async (entry) => ({
        path: `${prefix}${entry.name}`,
        kind: entry.isDirectory() ? ("dir" as const) : ("file" as const),
        size: entry.isDirectory() ? 0 : (await stat(path.join(local, entry.name))).size,
      })),
    );
  }

  override async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const local = this.onVolume(computer, filePath);
    if (!local) return super.readFile(computer, filePath, context, options);
    return new Uint8Array(await readFile(local));
  }

  override async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const local = this.onVolume(computer, file.path);
    if (!local) return super.writeFile(computer, file, context);
    await mkdir(path.dirname(local), { recursive: true });
    await writeFile(local, file.content);
  }
}
