import type { AdapterContext, PortableFile } from "./types.js";

/** An entry of a volume, by its path from the volume root with no leading slash. */
export interface VolumeEntry {
  path: string;
  kind: "file" | "dir" | "other";
  /** Permission bits (`0o777`). */
  mode: number;
}

/** A relative path with no empty, `.` or `..` segment, and no backslash or NUL. */
export function isPortablePath(path: string): boolean {
  return (
    !/[\\\0]/.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** The file's permission bits, or `0o755` / `0o644` by its executable bit when it has none. */
export function fileMode(file: Pick<PortableFile, "mode" | "executable">): number {
  return file.mode ?? (file.executable ? 0o755 : 0o644);
}

/**
 * The files of a whole volume, reached from the controller by the provider reference that
 * `WorkerProvider.ensureVolume` returned. For operator work such as moving a home onto volumes,
 * never for runs: a run reaches its files only from inside its worker. Every path must pass
 * `isPortablePath`.
 */
export interface VolumeFiles {
  /** Every entry under the root, at any depth. */
  list(volumeRef: string, context: AdapterContext): Promise<VolumeEntry[]>;
  /** Creates the missing parent directories. What it writes belongs to the guest user. */
  write(volumeRef: string, file: PortableFile, context: AdapterContext): Promise<void>;
  read(volumeRef: string, path: string, context: AdapterContext): Promise<Uint8Array>;
}
