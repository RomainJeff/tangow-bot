import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import type { PortableFile, VolumeEntry, VolumeFiles } from "@tangow/adapter-kit";
import { fileMode, isPortablePath } from "@tangow/adapter-kit";

/**
 * Whole Docker volumes, as directories under `DATA_DIR/volumes`. A guest shapes them, so a link
 * is listed as `other` and never followed, and a write never replaces an entry that exists.
 */
export class DockerVolumeFiles implements VolumeFiles {
  /** `volumes` is `DATA_DIR/volumes`, where a volume's directory is named by its provider ref. */
  constructor(private readonly volumes: string) {}

  async list(volumeRef: string): Promise<VolumeEntry[]> {
    const root = await this.directory(volumeRef, []);
    const entries: VolumeEntry[] = [];
    const walk = async (directory: string, prefix: string) => {
      for (const name of (await readdir(directory)).sort()) {
        const stats = await lstat(path.join(directory, name));
        const relative = prefix ? `${prefix}/${name}` : name;
        const kind = stats.isFile() ? "file" : stats.isDirectory() ? "dir" : "other";
        entries.push({ path: relative, kind, mode: stats.mode & 0o777 });
        if (kind === "dir") await walk(path.join(directory, name), relative);
      }
    };
    await walk(root, "");
    return entries;
  }

  async read(volumeRef: string, file: string): Promise<Uint8Array> {
    const segments = this.segments(file);
    const directory = await this.directory(volumeRef, segments.slice(0, -1));
    const handle = await open(
      path.join(directory, segments.at(-1)!),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  /** Creates the missing parents; fails with `EEXIST` rather than replace what is there. */
  async write(volumeRef: string, file: PortableFile): Promise<void> {
    const segments = this.segments(file.path);
    const directory = await this.directory(volumeRef, segments.slice(0, -1), true);
    const target = path.join(directory, segments.at(-1)!);
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(file.content);
      await handle.chmod(fileMode(file));
    } finally {
      await handle.close();
    }
  }

  private segments(relative: string): string[] {
    if (!isPortablePath(relative)) throw new Error(`Invalid volume path: ${relative}`);
    return relative.split("/");
  }

  /** The directory at `segments` in the volume, each step a real directory, never a link. */
  private async directory(volumeRef: string, segments: string[], create = false) {
    if (!isPortablePath(volumeRef) || volumeRef.includes("/")) throw new Error("Invalid volume");
    let directory = path.join(this.volumes, volumeRef);
    for (const segment of ["", ...segments]) {
      directory = path.join(directory, segment);
      const stats = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && create && segment) return null;
        throw error;
      });
      if (!stats) {
        await mkdir(directory);
        await chmod(directory, 0o755);
      } else if (!stats.isDirectory()) {
        throw Object.assign(new Error(`${directory} is not a directory`), { code: "ENOTDIR" });
      }
    }
    return directory;
  }
}
