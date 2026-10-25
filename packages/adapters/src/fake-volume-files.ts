import type { AdapterContext, PortableFile, VolumeEntry, VolumeFiles } from "@rakazo/adapter-kit";
import { fileMode } from "@rakazo/adapter-kit";

type StoredFile = { content: Uint8Array; mode: number };

/** In-memory files of the volumes a `FakeWorkerProvider` names, keyed by provider ref. */
export class MemoryVolumeFiles implements VolumeFiles {
  readonly volumes = new Map<string, Map<string, StoredFile>>();

  async list(volumeRef: string, _context: AdapterContext): Promise<VolumeEntry[]> {
    const files = this.volumes.get(volumeRef) ?? new Map<string, StoredFile>();
    const directories = new Set(
      [...files.keys()].flatMap((file) =>
        file
          .split("/")
          .slice(0, -1)
          .map((_, index, segments) => segments.slice(0, index + 1).join("/")),
      ),
    );
    return [
      ...[...directories].map((path) => ({ path, kind: "dir" as const, mode: 0o755 })),
      ...[...files].map(([path, file]) => ({ path, kind: "file" as const, mode: file.mode })),
    ].sort((a, b) => a.path.localeCompare(b.path));
  }

  async write(volumeRef: string, file: PortableFile, _context: AdapterContext): Promise<void> {
    const files = this.volumes.get(volumeRef) ?? new Map<string, StoredFile>();
    files.set(file.path, { content: file.content.slice(), mode: fileMode(file) });
    this.volumes.set(volumeRef, files);
  }

  async read(volumeRef: string, path: string, _context: AdapterContext): Promise<Uint8Array> {
    const file = this.volumes.get(volumeRef)?.get(path);
    if (!file) throw new Error(`No file ${path} on volume ${volumeRef}`);
    return file.content.slice();
  }

  async remove(volumeRef: string, path: string, _context: AdapterContext): Promise<void> {
    this.volumes.get(volumeRef)?.delete(path);
  }
}
