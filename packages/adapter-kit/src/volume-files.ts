import type { AdapterContext, PortableFile } from "./types.js";

/** An entry of a volume, by its path from the volume root with no leading slash. */
export interface VolumeEntry {
  path: string;
  kind: "file" | "dir" | "other";
  executable: boolean;
}

/**
 * The files of a whole volume, reached from the controller by the provider reference that
 * `WorkerProvider.ensureVolume` returned. For operator work such as moving a home onto volumes,
 * never for runs: a run reaches its files only from inside its worker.
 */
export interface VolumeFiles {
  /** Every entry under the root, at any depth. */
  list(volumeRef: string, context: AdapterContext): Promise<VolumeEntry[]>;
  /** Creates the missing parent directories. What it writes belongs to the guest user. */
  write(volumeRef: string, file: PortableFile, context: AdapterContext): Promise<void>;
  read(volumeRef: string, path: string, context: AdapterContext): Promise<Uint8Array>;
}
