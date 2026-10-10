/**
 * A skill's files as the store sees them: relative paths with their bytes, read without following
 * anything, held to the import caps, and written so a power cut leaves the old or the new file.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { SKILL_BUNDLE_MAX_BYTES, SKILL_BUNDLE_MAX_ENTRIES } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { SkillTreeFile } from "./skill-store.js";
import { hasCode, isStorableFile } from "./skill-store.js";

export type SkillRefusalReason =
  | "invalid"
  | "name_taken"
  | "not_found"
  | "quota"
  | "stale"
  | "not_undoable"
  | "current_version"
  | "unavailable";

export class SkillRefusal extends Error {
  constructor(
    readonly reason: SkillRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "SkillRefusal";
  }
}

/** The store or its lock failed for a reason the owner cannot fix; the details go to the log. */
export const unavailable = () =>
  new SkillRefusal("unavailable", "Skills are unavailable right now. Try again later.");

/** Nothing there: absent, or a stray file where a folder of the path belongs. */
const isMissing = (error: unknown) => hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR");

export async function readdirOrEmpty(dir: string): Promise<string[]> {
  return readdir(dir).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
}

/** Written and flushed to disk before the caller moves on. */
export async function writeDurable(file: string, bytes: Uint8Array | string, mode = 0o644) {
  const handle = await open(file, "w", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The old file or the new one, never a torn one: a unique temp beside it, flushed, renamed. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeDurable(tmp, JSON.stringify(value));
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  await syncDir(path.dirname(file));
}

export type HistoryRead<T> =
  | { state: "missing" }
  | { state: "unreadable" }
  | { state: "ok"; value: T };

/**
 * A JSON file of the history, which is never mounted: hard links are fine there, links are not.
 * An unreadable file is reported, never thrown, so one torn file cannot block an owner's writes.
 */
export async function readHistoryJson<T>(
  file: string,
  isValid: (value: unknown) => value is T,
): Promise<HistoryRead<T>> {
  const info = await lstat(file).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!info) return { state: "missing" };
  let value: unknown;
  try {
    if (!info.isFile() || info.size > SKILL_BUNDLE_MAX_BYTES) throw new Error("not a plain file");
    value = JSON.parse(await readFile(file, "utf8"));
  } catch {
    getLogger().warn(`[skills] ignoring unreadable ${file}`);
    return { state: "unreadable" };
  }
  if (!isValid(value)) {
    getLogger().warn(`[skills] ignoring malformed ${file}`);
    return { state: "unreadable" };
  }
  return { state: "ok", value };
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const comparePaths = (a: SkillTreeFile, b: SkillTreeFile) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export function fingerprint(tree: SkillTreeFile[]): string {
  return sha256(
    JSON.stringify(
      [...tree].sort(comparePaths).map((file) => [file.path, file.executable, sha256(file.bytes)]),
    ),
  );
}

export const treeBytes = (tree: SkillTreeFile[]) =>
  tree.reduce((sum, file) => sum + file.bytes.length, 0);

const folderPaths = (paths: string[]) =>
  new Set(
    paths.flatMap((file) =>
      file
        .split("/")
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
    ),
  );

/** Files and the folders that hold them, counted the way the import counts archive entries. */
const entryCount = (paths: string[]) => paths.length + folderPaths(paths).size;

const tooManyEntries = () =>
  new SkillRefusal(
    "invalid",
    `Skill has too many files and folders (> ${SKILL_BUNDLE_MAX_ENTRIES}).`,
  );

const tooLarge = () =>
  new SkillRefusal("invalid", `Skill too large (> ${SKILL_BUNDLE_MAX_BYTES} bytes).`);

/**
 * Relative POSIX paths that stay inside the skill, within the entry and byte caps, sorted; the
 * executable bit survives only under scripts/.
 */
export function normalizeTree(files: SkillTreeFile[]): SkillTreeFile[] {
  const byPath = new Map<string, SkillTreeFile>();
  for (const file of files) {
    const segments = file.path.split(/[\\/]/);
    const clean = segments.filter((segment) => segment !== "" && segment !== ".");
    if (
      path.posix.isAbsolute(file.path) ||
      path.win32.isAbsolute(file.path) ||
      segments.includes("..") ||
      clean.length === 0
    ) {
      throw new SkillRefusal("invalid", `Skill file escapes the skill folder: ${file.path}.`);
    }
    const relative = clean.join("/");
    byPath.set(relative, {
      path: relative,
      bytes: file.bytes,
      executable: file.executable && relative.startsWith("scripts/"),
    });
  }
  if (entryCount([...byPath.keys()]) > SKILL_BUNDLE_MAX_ENTRIES) throw tooManyEntries();
  if (treeBytes([...byPath.values()]) > SKILL_BUNDLE_MAX_BYTES) throw tooLarge();
  for (const relative of byPath.keys()) {
    const parts = relative.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      if (byPath.has(parts.slice(0, depth).join("/"))) {
        throw new SkillRefusal("invalid", `Skill has conflicting entries: ${relative}.`);
      }
    }
  }
  return [...byPath.values()].sort(comparePaths);
}

export function withSkillMd(files: SkillTreeFile[], content: string): SkillTreeFile[] {
  const rest = normalizeTree(files).filter((file) => file.path !== "SKILL.md");
  return normalizeTree([
    ...rest,
    { path: "SKILL.md", bytes: new TextEncoder().encode(content), executable: false },
  ]);
}

const problem = (info: Stats) =>
  info.isSymbolicLink()
    ? "is a link"
    : !info.isFile()
      ? "is not a regular file"
      : info.nlink > 1
        ? "is a hard link"
        : info.size > SKILL_BUNDLE_MAX_BYTES
          ? `is larger than ${SKILL_BUNDLE_MAX_BYTES / 1024 / 1024} MB`
          : "has a backslash in its name";

const unkept = (relative: string, what: string) =>
  new SkillRefusal(
    "invalid",
    `${relative} ${what}, and a skill keeps only plain files. Remove it and try again.`,
  );

/**
 * Reads a folder without following anything. Anything the store could not keep (a link, a FIFO,
 * a device, a hard link, an oversized file) refuses the capture, so no later write drops it.
 * `hardLinks` admits hard links, for the history: it is never mounted, and a snapshot of the
 * data folder may hard-link every file.
 */
export async function captureTree(
  dir: string,
  options: { hardLinks?: boolean } = {},
): Promise<SkillTreeFile[]> {
  const root = await lstat(dir);
  if (!root.isDirectory()) throw unkept(".", problem(root));
  const files: SkillTreeFile[] = [];
  let entries = 0;
  let bytes = 0;
  const read = async (absolute: string, relative: string, name: string): Promise<void> => {
    const check = (info: Stats) => {
      if (name.includes("\\") || !isStorableFile(info, options)) {
        throw unkept(relative, problem(info));
      }
    };
    check(await lstat(absolute));
    // The lstat above spares a FIFO or device the open; the handle's own stat is what counts,
    // since a link swapped in after the lstat fails the open instead of being followed.
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error: unknown) => {
      throw hasCode(error, "ELOOP") ? unkept(relative, "is a link") : error;
    });
    try {
      const info = await handle.stat();
      check(info);
      bytes += info.size;
      if (bytes > SKILL_BUNDLE_MAX_BYTES) throw tooLarge();
      // Exactly the size the caps vetted: a file that grew since its stat is refused, not read.
      const content = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(content, 0, info.size, 0);
      const { bytesRead: beyond } = await handle.read(new Uint8Array(1), 0, 1, info.size);
      if (bytesRead !== info.size || beyond > 0) {
        throw new SkillRefusal("invalid", `${relative} changed while it was read. Try again.`);
      }
      files.push({ path: relative, bytes: content, executable: (info.mode & 0o111) !== 0 });
    } finally {
      await handle.close();
    }
  };
  const walk = async (absolute: string, relative: string): Promise<void> => {
    for (const name of (await readdir(absolute)).sort()) {
      const child = path.join(absolute, name);
      const childPath = relative ? `${relative}/${name}` : name;
      if (++entries > SKILL_BUNDLE_MAX_ENTRIES) throw tooManyEntries();
      if ((await lstat(child)).isDirectory()) await walk(child, childPath);
      else await read(child, childPath, name);
    }
  };
  await walk(dir, "");
  return normalizeTree(files);
}

/**
 * Brings `dir` to exactly `tree` with no moment where SKILL.md is missing: what the tree drops
 * goes first, then each file is staged in `staging`, outside the mounted root, and renamed into
 * place, SKILL.md last. It never deletes a file it could not have kept: it refuses before
 * deleting anything.
 */
export async function materialize(
  tree: SkillTreeFile[],
  dir: string,
  staging: string,
): Promise<void> {
  const existing = await lstat(dir).catch(() => null);
  if (existing && !existing.isDirectory()) throw unkept(".", problem(existing));
  await mkdir(dir, { recursive: true });
  const files = new Set(tree.map((file) => file.path));
  const folders = folderPaths([...files]);
  const staleFiles: string[] = [];
  const staleFolders: string[] = [];
  const survey = async (absolute: string, relative: string): Promise<void> => {
    for (const name of await readdir(absolute)) {
      const child = path.join(absolute, name);
      const childPath = relative ? `${relative}/${name}` : name;
      const info = await lstat(child);
      if (info.isDirectory()) {
        await survey(child, childPath);
        if (!folders.has(childPath)) staleFolders.push(child);
      } else if (!isStorableFile(info)) throw unkept(childPath, problem(info));
      else if (!files.has(childPath)) staleFiles.push(child);
    }
  };
  await survey(dir, "");
  for (const file of staleFiles) await rm(file, { force: true });
  // Surveyed depth first, so each folder comes after the folders inside it.
  for (const folder of staleFolders) await rmdir(folder);
  const stage = path.join(staging, randomUUID());
  await mkdir(stage, { recursive: true });
  try {
    const ordered = [...tree].sort(
      (a, b) => Number(a.path === "SKILL.md") - Number(b.path === "SKILL.md"),
    );
    for (const [index, file] of ordered.entries()) {
      const staged = path.join(stage, String(index));
      await writeDurable(staged, file.bytes, file.executable ? 0o755 : 0o644);
      const target = path.join(dir, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(staged, target);
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
