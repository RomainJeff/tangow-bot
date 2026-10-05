/**
 * Skills v2 phase 2: user skill content lives on disk, the DB only keeps access rows
 * (SkillSetting / BotSkill). One directory per skill under
 * DATA_DIR/skills/user/<spaceId>/<userId>/<dir>/SKILL.md. spaceId/userId are DB cuids
 * (trusted); the skill directory name is derived from the skill key, never from user input
 * directly, so no path can escape the owner's root.
 */
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable as ReadableStream } from "node:stream";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { SKILL_BUNDLE_MAX_BYTES, SKILL_BUNDLE_MAX_ENTRIES } from "@rakazo/contracts";
import { parseSkillMd, type SkillRecord, userSkillKey } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { extract as tarExtract } from "tar";
import { type Entry, fromBuffer, type ZipFile } from "yauzl";

export type UserSkillFile = SkillRecord & {
  id: string;
  source: "user";
  readOnly: false;
  createdAt: Date;
  updatedAt: Date;
};

export function userSkillsRoot(
  dataDir: string,
  owner: { spaceId: string; userId: string },
): string {
  return path.join(dataDir, "skills", "user", owner.spaceId, owner.userId);
}

/** Directory name: same identity as SkillSetting/BotSkill (lower(name)), made FS-safe. */
// ponytail: URL-encoding is bijective and safe on every FS; readable slugs need a collision table.
export function skillDirName(name: string): string {
  const key = userSkillKey(name).slice("user:".length);
  return encodeURIComponent(key).replace(/^\./, "%2E");
}

function skillFile(root: string, name: string): string {
  return path.join(root, skillDirName(name), "SKILL.md");
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function isExists(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}

export async function listUserSkills(root: string): Promise<UserSkillFile[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const skills: UserSkillFile[] = [];
  for (const entry of entries) {
    const file = path.join(root, entry, "SKILL.md");
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) continue;
      throw error;
    }
    const parsed = parseSkillMd(content);
    if ("error" in parsed) {
      // ponytail: skipped + log; a panel warning waits for a real user hitting this.
      getLogger().warn(`[skills] ignoring ${file}: ${parsed.error}`);
      continue;
    }
    const info = await stat(file);
    skills.push({
      id: userSkillKey(parsed.name),
      name: parsed.name,
      description: parsed.description,
      content,
      source: "user",
      readOnly: false,
      // ponytail: birthtime is not stable across atomic replaces; both stamps = mtime.
      createdAt: info.mtime,
      updatedAt: info.mtime,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * "create" fails with EEXIST when a skill with the same key exists (the FS is the uniqueness
 * guard the DB index used to be). "replace" writes tmp + rename so a crash never leaves a
 * half-written SKILL.md.
 */
export async function writeUserSkill(
  root: string,
  skill: { name: string; content: string },
  mode: "create" | "replace",
): Promise<void> {
  const file = skillFile(root, skill.name);
  await mkdir(path.dirname(file), { recursive: true });
  if (mode === "create") {
    await writeFile(file, skill.content, { encoding: "utf8", flag: "wx" });
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, skill.content, "utf8");
  await rename(tmp, file);
}

/**
 * Renames a skill: the whole directory moves, so bundle extras (scripts/, references/) follow the
 * new name instead of being dropped, then the new SKILL.md lands. "create" semantics: EEXIST on a
 * name clash, same signal as writeUserSkill "create".
 */
export async function renameUserSkill(
  root: string,
  oldName: string,
  skill: { name: string; content: string },
): Promise<void> {
  const from = path.join(root, skillDirName(oldName));
  const dest = path.join(root, skillDirName(skill.name));
  await mkdir(dest); // EEXIST = name clash
  // rename(2) replaces the empty directory we just claimed.
  await rename(from, dest).catch(async (error) => {
    await rm(dest, { recursive: true, force: true });
    throw error;
  });
  await writeUserSkill(root, skill, "replace");
}

/**
 * Imports a `.skill` bundle: a gzip tar or zip with SKILL.md at its root (or inside a single top-level
 * directory) plus any extra files (scripts/, references/, ...). Same hardening as the marketplace
 * tarball: files and directories only, byte cap.
 */
export async function writeUserSkillBundle(
  root: string,
  archive: Buffer,
  resolve: (skillMd: string) => Promise<{ name: string; content: string }>,
): Promise<void> {
  await importSkillTree(root, (out) => extractBundle(archive, out), resolve, "create");
}

export type SkillTreeFile = { path: string; bytes: Uint8Array; executable: boolean };

/**
 * Imports a skill folder already read into memory (a bot's workspace draft) with the bundle's
 * guarantees: relative paths that stay inside the skill, entry and byte caps.
 */
export async function writeUserSkillFiles(
  root: string,
  files: SkillTreeFile[],
  resolve: (skillMd: string) => Promise<{ name: string; content: string }>,
): Promise<void> {
  await importSkillTree(root, populateFiles(files), resolve, "create");
}

/**
 * Swaps a saved skill's whole folder for `files`. When the new SKILL.md renames the skill, the
 * folder moves with "create" semantics (EEXIST on a clash) and the old one is removed.
 */
export async function replaceUserSkillFiles(
  root: string,
  oldName: string,
  files: SkillTreeFile[],
  resolve: (skillMd: string) => Promise<{ name: string; content: string }>,
): Promise<void> {
  await importSkillTree(root, populateFiles(files), resolve, { replace: oldName });
}

function populateFiles(files: SkillTreeFile[]): (out: string) => Promise<void> {
  if (files.length > SKILL_BUNDLE_MAX_ENTRIES) {
    throw new Error(`Skill has too many files (> ${SKILL_BUNDLE_MAX_ENTRIES}).`);
  }
  const bytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (bytes > SKILL_BUNDLE_MAX_BYTES) {
    throw new Error(`Skill too large (> ${SKILL_BUNDLE_MAX_BYTES} bytes).`);
  }
  return async (out) => {
    const base = path.resolve(out);
    for (const file of files) {
      const target = path.resolve(base, file.path);
      if (
        path.isAbsolute(file.path) ||
        file.path.split(/[\\/]/).includes("..") ||
        !target.startsWith(base + path.sep)
      ) {
        throw new Error(`Skill file escapes the skill folder: ${file.path}.`);
      }
      await mkdir(path.dirname(target), { recursive: true })
        .then(() => writeFile(target, file.bytes, file.executable ? { mode: 0o755 } : {}))
        .catch((error: unknown) => {
          if (error instanceof Error && "code" in error) {
            throw new Error(`Skill file could not be written: ${file.path}.`);
          }
          throw error;
        });
    }
  };
}

/**
 * Populates a temp dir under root, lets `resolve` validate the SKILL.md (and return the normalized
 * content), then moves the tree into place without ever leaving a half-written skill. "create"
 * claims the destination (EEXIST on a name clash); `replace` swaps out the named skill's folder.
 */
async function importSkillTree(
  root: string,
  populate: (out: string) => Promise<void>,
  resolve: (skillMd: string) => Promise<{ name: string; content: string }>,
  target: "create" | { replace: string },
): Promise<void> {
  await mkdir(root, { recursive: true });
  // No SKILL.md directly inside the wrapper, so listUserSkills never sees a half-imported skill.
  const wrapper = await mkdtemp(path.join(root, ".import-"));
  try {
    const out = path.join(wrapper, "bundle");
    await mkdir(out);
    await populate(out);
    const skillDir = await locateSkillDir(out);
    const resolved = await resolve(await readFile(path.join(skillDir, "SKILL.md"), "utf8"));
    await writeFile(path.join(skillDir, "SKILL.md"), resolved.content, "utf8");
    const dest = path.join(root, skillDirName(resolved.name));
    const old = target === "create" ? undefined : path.join(root, skillDirName(target.replace));
    if (old === dest) {
      // The old folder waits in the wrapper (removed below) until the new one is in place.
      const aside = path.join(wrapper, "old");
      await rename(old, aside);
      await rename(skillDir, dest).catch(async (error) => {
        await rename(aside, dest);
        throw error;
      });
      return;
    }
    await mkdir(dest); // EEXIST = name clash, same signal as writeUserSkill "create"
    // rename(2) replaces the empty directory we just claimed.
    await rename(skillDir, dest).catch(async (error) => {
      await rm(dest, { recursive: true, force: true });
      throw error;
    });
    if (old) await rm(old, { recursive: true, force: true });
  } finally {
    await rm(wrapper, { recursive: true, force: true });
  }
}

/**
 * Magic bytes of the archive formats a `.skill` bundle may use, or null for anything else
 * (which the import path then reads as plain SKILL.md text). Two bytes are enough for zip:
 * `50 4b` covers the local-file, central-directory and spanning headers without enumerating
 * them, so an odd variant fails downstream with a real message instead of "not a .skill file".
 * A valid SKILL.md always starts with a `---` frontmatter fence (see parseSkillMd), so it can
 * never collide with either signature.
 */
export function bundleFormat(bytes: Buffer): "tar" | "zip" | null {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "tar";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "zip";
  return null;
}

/**
 * One byte budget for the whole bundle, whatever the format. The factory hands out a fresh
 * Transform per stream — zip extracts one entry at a time, each its own pipeline — while every
 * one of them spends the same counter, so the cap is on observed decompressed bytes rather than
 * any size an archive declares about itself.
 */
function capStream(): () => Transform {
  let bytes = 0;
  return () =>
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > SKILL_BUNDLE_MAX_BYTES) {
          callback(new Error(`Skill bundle too large (> ${SKILL_BUNDLE_MAX_BYTES} bytes).`));
          return;
        }
        callback(null, chunk);
      },
    });
}

async function extractBundle(archive: Buffer, out: string): Promise<void> {
  const format = bundleFormat(archive);
  if (format === "tar") return extractTar(archive, out, capStream());
  if (format === "zip") return extractZip(archive, out, capStream());
  throw new Error("Skill bundle must be a gzip tar or zip archive.");
}

async function extractTar(archive: Buffer, out: string, cap: () => Transform): Promise<void> {
  let entries = 0;
  const unpack = tarExtract({
    cwd: out,
    preservePaths: false,
    filter: (_path, entry) =>
      "type" in entry && (entry.type === "File" || entry.type === "Directory"),
    onReadEntry: () => {
      if (++entries > SKILL_BUNDLE_MAX_ENTRIES) {
        unpack.abort(
          new Error(`Skill bundle has too many entries (> ${SKILL_BUNDLE_MAX_ENTRIES}).`),
        );
      }
    },
  });
  // Explicit gunzip so the byte cap applies to the decompressed tar, not the compressed file.
  await pipeline(Readable.from([archive]), createGunzip(), cap(), unpack);
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

/**
 * Zip counterpart of extractTar, with the same guarantees: regular files and directories only,
 * nothing outside `out`, one shared byte cap, one entry cap. yauzl reads the whole buffer we
 * already hold (bounded by the base64 length cap on import) and streams entries lazily, one at
 * a time, so nothing is inflated into memory ahead of the cap.
 */
async function extractZip(archive: Buffer, out: string, cap: () => Transform): Promise<void> {
  const zipfile = await new Promise<ZipFile>((resolve, reject) => {
    fromBuffer(archive, { lazyEntries: true }, (error, opened) => {
      if (opened) resolve(opened);
      else reject(error ?? new Error("Skill bundle is not a readable zip archive."));
    });
  });
  let entries = 0;
  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      zipfile.close();
      reject(error);
    };
    zipfile.on("error", fail);
    zipfile.on("end", resolve);
    zipfile.on("entry", (entry: Entry) => {
      // Counted before any per-entry work, so a 10k-entry archive dies on entry 201.
      if (++entries > SKILL_BUNDLE_MAX_ENTRIES) {
        fail(new Error(`Skill bundle has too many entries (> ${SKILL_BUNDLE_MAX_ENTRIES}).`));
        return;
      }
      extractZipEntry(zipfile, entry, out, cap).then(() => {
        zipfile.readEntry();
      }, fail);
    });
    zipfile.readEntry();
  });
}

async function extractZipEntry(
  zipfile: ZipFile,
  entry: Entry,
  out: string,
  cap: () => Transform,
): Promise<void> {
  // yauzl's own validateFileName already rejects "..", absolute paths and backslashes; resolving
  // the target again is the belt-and-braces check the marketplace extractor keeps.
  // ponytail: path depth and name length are unguarded here as on the tar side — the entry and
  // byte caps bound the damage; add a depth check if a real bundle ever needs one.
  const root = path.resolve(out);
  const target = path.resolve(root, entry.fileName);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Skill bundle entry escapes the bundle root: ${entry.fileName}.`);
  }
  if (entry.fileName.endsWith("/")) {
    await mkdir(target, { recursive: true }).catch(entryFailure(entry));
    return;
  }
  // Symlinks (S_IFLNK), fifos and devices are dropped silently, like the tar filter drops them.
  // A zero mode is an MS-DOS-authored zip, which carries no unix mode at all: treat it as a file.
  const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
  if (mode !== S_IFREG && mode !== 0) return;
  if (entry.isEncrypted()) {
    throw new Error("Skill bundle uses zip encryption, which is not supported.");
  }
  await mkdir(path.dirname(target), { recursive: true }).catch(entryFailure(entry));
  const stream = await new Promise<ReadableStream>((resolve, reject) => {
    zipfile.openReadStream(entry, (error, readable) => {
      if (readable) resolve(readable);
      else reject(error ?? new Error(`Cannot read skill bundle entry ${entry.fileName}.`));
    });
  });
  // The cap counts the bytes actually observed, across every entry: the central directory's
  // uncompressedSize is attacker-controlled, so a bomb declaring 1 KB and delivering 4 GB of
  // inflated data still stops here rather than filling the disk.
  await pipeline(stream, cap(), createWriteStream(target)).catch(entryFailure(entry));
}

/**
 * A filesystem error in here is about the archive's own layout — a file and a directory claiming
 * the same name, an entry named "." — not about the user's skill list, and its message carries the
 * temp path we extracted into. Reword it so the import answers BAD_REQUEST naming the entry
 * instead of the CONFLICT that the name-clash mkdir in importSkillTree raises, and so no host
 * path reaches the user. The byte cap and yauzl's own stream errors carry no `code` and pass
 * through untouched.
 */
// ponytail: two buckets, no error taxonomy; split further only if a message is ever unactionable.
function entryFailure(entry: Entry): (error: unknown) => never {
  return (error: unknown) => {
    if (hasCode(error, "EEXIST") || hasCode(error, "ENOTDIR") || hasCode(error, "EISDIR")) {
      throw new Error(`Skill bundle has conflicting entries: ${entry.fileName}.`);
    }
    if (error instanceof Error && "code" in error) {
      throw new Error(`Skill bundle entry could not be written: ${entry.fileName}.`);
    }
    throw error;
  };
}

const isFile = (file: string) =>
  stat(file).then(
    (info) => info.isFile(),
    () => false,
  );

/**
 * macOS Finder "Compress" (ditto -c -k --sequesterRsrc --keepParent) adds a `__MACOSX` sibling
 * whenever any file carries an xattr, which quarantine flags and Finder tags routinely do, so the
 * skill directory is no longer the only top-level entry.
 */
// ponytail: only the two names Finder adds, and only for finding the skill directory — a
// `__MACOSX` beside SKILL.md at the archive root still lands inside the skill, harmlessly.
const isFinderJunk = (name: string) => name === "__MACOSX" || name === ".DS_Store";

async function locateSkillDir(out: string): Promise<string> {
  if (await isFile(path.join(out, "SKILL.md"))) return out;
  const entries = (await readdir(out)).filter((name) => !isFinderJunk(name));
  const top = entries.length === 1 ? path.join(out, entries[0] ?? "") : null;
  if (top && (await isFile(path.join(top, "SKILL.md")))) return top;
  throw new Error("Skill bundle must contain SKILL.md at its root.");
}

export async function removeUserSkill(root: string, name: string): Promise<void> {
  await rm(path.join(root, skillDirName(name)), { recursive: true, force: true });
}

/** Account deletion: a user's skills live under every space they belonged to. */
export async function removeUserSkillDirs(dataDir: string, userId: string): Promise<void> {
  const base = path.join(dataDir, "skills", "user");
  const spaces = await readdir(base).catch(() => [] as string[]);
  await Promise.all(
    spaces.map((spaceId) => rm(path.join(base, spaceId, userId), { recursive: true, force: true })),
  );
}
