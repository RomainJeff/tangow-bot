import type { ConnectionOpts } from "@e2b/desktop";
import { Volume, VolumeFileType } from "@e2b/desktop";
import type { AdapterContext, PortableFile, VolumeEntry, VolumeFiles } from "@rakazo/adapter-kit";

export type GuestOwner = { uid: number; gid: number };

/**
 * E2B runs sandbox commands as `user` (`defaultUsername` in e2b@2.49.1), and the SDK does not
 * state its uid. 1000 is the usual id of the first user of an image: confirm it in the worker
 * template before a real migration.
 */
export const E2B_GUEST_OWNER: GuestOwner = { uid: 1000, gid: 1000 };

/**
 * E2B volumes by the name the E2B worker provider records as their provider reference. The SDK
 * reads its credentials and endpoint from its standard environment unless `connection` says
 * otherwise.
 */
export class E2BVolumeFiles implements VolumeFiles {
  private readonly handles = new Map<string, Promise<Volume>>();
  private readonly directories = new Map<string, Set<string>>();
  private readonly owner: GuestOwner;

  constructor(private readonly options: { owner?: GuestOwner; connection?: ConnectionOpts } = {}) {
    this.owner = options.owner ?? E2B_GUEST_OWNER;
  }

  async list(volumeRef: string, context: AdapterContext): Promise<VolumeEntry[]> {
    const volume = await this.volume(volumeRef);
    const entries: VolumeEntry[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const stat of await volume.list(`/${directory}`, { signal: context.signal })) {
        const path = directory ? `${directory}/${stat.name}` : stat.name;
        const kind =
          stat.type === VolumeFileType.DIRECTORY
            ? "dir"
            : stat.type === VolumeFileType.FILE
              ? "file"
              : "other";
        entries.push({ path, kind, executable: kind === "file" && Boolean(stat.mode & 0o100) });
        if (kind === "dir") await walk(path);
      }
    };
    await walk("");
    return entries;
  }

  async write(volumeRef: string, file: PortableFile, context: AdapterContext): Promise<void> {
    const volume = await this.volume(volumeRef);
    const made = this.directories.get(volumeRef) ?? new Set<string>();
    this.directories.set(volumeRef, made);
    const segments = file.path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const directory = segments.slice(0, depth).join("/");
      if (made.has(directory)) continue;
      await volume.makeDir(`/${directory}`, {
        ...this.owner,
        mode: 0o755,
        force: true,
        signal: context.signal,
      });
      made.add(directory);
    }
    await volume.writeFile(`/${file.path}`, file.content.slice().buffer, {
      ...this.owner,
      mode: file.executable ? 0o755 : 0o644,
      signal: context.signal,
    });
  }

  async read(volumeRef: string, path: string, context: AdapterContext): Promise<Uint8Array> {
    const volume = await this.volume(volumeRef);
    return volume.readFile(`/${path}`, { format: "bytes", signal: context.signal });
  }

  private volume(name: string): Promise<Volume> {
    const known = this.handles.get(name);
    if (known) return known;
    const connecting = connectByName(name, this.options.connection);
    this.handles.set(name, connecting);
    connecting.catch(() => this.handles.delete(name));
    return connecting;
  }
}

async function connectByName(name: string, connection: ConnectionOpts | undefined) {
  const found = (await Volume.list(connection)).find((volume) => volume.name === name);
  if (!found) throw new Error(`No E2B volume is named ${name}`);
  return Volume.connect(found.volumeId, connection);
}
