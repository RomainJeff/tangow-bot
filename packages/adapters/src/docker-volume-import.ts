import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { isPortablePath } from "@rakazo/adapter-kit";
import { z } from "zod";

// Reads are bounded because the provider's file API returns a single byte array.
export const MAX_IMPORT_FILE_BYTES = 256 * 1024 ** 2;
const portable = z.string().refine(isPortablePath, "Invalid volume path");
const mode = z.number().int().min(0).max(0o777);
const entry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dir"), path: portable, mode }),
  z.object({
    kind: z.literal("file"),
    path: portable,
    mode,
    size: z.number().int().min(0).max(MAX_IMPORT_FILE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
export const volumeManifestSchema = z.object({ mode, entries: z.array(entry) });
export type VolumeManifest = z.infer<typeof volumeManifestSchema>;
export type VolumeImportSource = {
  inspect(volumeRef: string, context: AdapterContext): Promise<VolumeManifest>;
  read(volumeRef: string, file: string, context: AdapterContext): Promise<Uint8Array>;
};

export function volumeManifest(value: unknown): VolumeManifest {
  const manifest = volumeManifestSchema.parse(value);
  const names = new Set<string>();
  for (const item of manifest.entries) {
    if (names.has(item.path)) throw new Error("Duplicate volume entry");
    names.add(item.path);
  }
  return { ...manifest, entries: manifest.entries.sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function inspectLocalVolume(root: string): Promise<VolumeManifest> {
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error("Volume root is not a directory");
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid)
    throw new Error("Docker volume is not owned by the application user");
  const entries: VolumeManifest["entries"] = [];
  async function walk(directory: string, prefix: string) {
    for (const name of await readdir(directory)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!isPortablePath(relative)) throw new Error("Unsupported volume path");
      const file = path.join(directory, name);
      const info = await lstat(file);
      if (uid !== undefined && info.uid !== uid)
        throw new Error("Docker volume entry is not owned by the application user");
      if (info.isDirectory()) {
        entries.push({ kind: "dir", path: relative, mode: info.mode & 0o777 });
        await walk(file, relative);
      } else if (info.isFile()) {
        if (info.size > MAX_IMPORT_FILE_BYTES) throw new Error("Volume file exceeds 256 MiB");
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const hash = createHash("sha256");
          for await (const chunk of handle.createReadStream({ autoClose: false }))
            hash.update(chunk);
          entries.push({
            kind: "file",
            path: relative,
            mode: info.mode & 0o777,
            size: info.size,
            sha256: hash.digest("hex"),
          });
        } finally {
          await handle.close();
        }
      } else throw new Error("Volume contains a symbolic link or special file");
    }
  }
  await walk(root, "");
  return volumeManifest({ mode: info.mode & 0o777, entries });
}

export function sameVolume(left: VolumeManifest, right: VolumeManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

/** Publishes only a verified whole volume. A retry discards only its own incomplete staging. */
export async function importDockerVolume(options: {
  source: VolumeImportSource;
  sourceRef: string;
  destination: string;
  staging: string;
  context: AdapterContext;
}): Promise<VolumeManifest> {
  const { source, sourceRef, destination, staging, context } = options;
  const manifest = volumeManifest(await source.inspect(sourceRef, context));
  if (await exists(destination)) {
    if (!sameVolume(manifest, await inspectLocalVolume(destination))) {
      throw new Error("Existing Docker volume differs from E2B; both copies were retained");
    }
    return manifest;
  }
  await mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await rm(staging, { recursive: true, force: true });
  const storage = await statfs(path.dirname(staging));
  const bytes = manifest.entries.reduce(
    (total, item) => total + (item.kind === "file" ? item.size : 0),
    0,
  );
  if (storage.bavail * storage.bsize < bytes) throw new Error("Insufficient disk space for volume");
  await mkdir(staging, { mode: 0o700 });
  for (const item of manifest.entries.filter((item) => item.kind === "dir")) {
    await mkdir(path.join(staging, item.path), { recursive: true, mode: 0o700 });
  }
  for (const item of manifest.entries) {
    context.signal.throwIfAborted();
    if (item.kind !== "file") continue;
    const content = await source.read(sourceRef, item.path, context);
    if (
      content.byteLength !== item.size ||
      createHash("sha256").update(content).digest("hex") !== item.sha256
    ) {
      throw new Error("E2B volume changed while copying");
    }
    const handle = await open(path.join(staging, item.path), "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.chmod(item.mode);
    } finally {
      await handle.close();
    }
  }
  for (const item of [...manifest.entries].reverse()) {
    if (item.kind === "dir") await chmod(path.join(staging, item.path), item.mode);
  }
  await chmod(staging, manifest.mode);
  if (
    !sameVolume(manifest, await inspectLocalVolume(staging)) ||
    !sameVolume(manifest, volumeManifest(await source.inspect(sourceRef, context)))
  ) {
    throw new Error("Volume verification failed; source retained");
  }
  context.signal.throwIfAborted();
  await rename(staging, destination);
  return manifest;
}
