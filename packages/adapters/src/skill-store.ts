/**
 * Skills v2 phase 2: user skill content lives on disk, the DB only keeps access rows
 * (SkillSetting / BotSkill). One directory per skill under
 * DATA_DIR/skills/user/<spaceId>/<userId>/<dir>/SKILL.md. spaceId/userId are DB cuids
 * (trusted); the skill directory name is derived from the skill key, never from user input
 * directly, so no path can escape the owner's root. Every write goes through skill-library.ts.
 */
import type { Stats } from "node:fs";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
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

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * A file the store may open: a plain file with one name and a bounded size. A link, FIFO or
 * device planted in a skill folder (a bot on desktop can write there) is never followed or read.
 * `hardLinks` admits a second name, for reading only: the store never writes through a file.
 */
export function isStorableFile(info: Stats, options: { hardLinks?: boolean } = {}): boolean {
  return (
    info.isFile() && (options.hardLinks || info.nlink === 1) && info.size <= SKILL_BUNDLE_MAX_BYTES
  );
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
    const dir = path.join(root, entry);
    const file = path.join(dir, "SKILL.md");
    const [dirInfo, info] = await Promise.all([
      lstat(dir).catch(() => null),
      lstat(file).catch(() => null),
    ]);
    if (!dirInfo?.isDirectory() || !info) continue;
    if (!isStorableFile(info, { hardLinks: true })) {
      getLogger().warn(`[skills] ignoring ${file}: not a plain file`);
      continue;
    }
    const content = await readFile(file, "utf8");
    const parsed = parseSkillMd(content);
    if ("error" in parsed) {
      // ponytail: skipped + log; a panel warning waits for a real user hitting this.
      getLogger().warn(`[skills] ignoring ${file}: ${parsed.error}`);
      continue;
    }
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

export type SkillTreeFile = { path: string; bytes: Uint8Array; executable: boolean };

/**
 * Unpacks a `.skill` bundle (a gzip tar or zip with SKILL.md at its root, or inside a single
 * top-level directory, plus any extra files) into `out`, a fresh staging directory, and returns
 * the skill's directory inside it. Same hardening as the marketplace tarball: files and
 * directories only, byte and entry caps.
 */
export async function extractSkillBundle(archive: Buffer, out: string): Promise<string> {
  await extractBundle(archive, out);
  return locateSkillDir(out);
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
  // Entries past the cap are skipped rather than aborted on: an abort leaves file writes in
  // flight, which outlive the rejection and race the caller's cleanup of `out`.
  const unpack = tarExtract({
    cwd: out,
    preservePaths: false,
    filter: (_path, entry) =>
      ++entries <= SKILL_BUNDLE_MAX_ENTRIES &&
      "type" in entry &&
      (entry.type === "File" || entry.type === "Directory"),
  });
  // Explicit gunzip so the byte cap applies to the decompressed tar, not the compressed file.
  await pipeline(Readable.from([archive]), createGunzip(), cap(), unpack);
  if (entries > SKILL_BUNDLE_MAX_ENTRIES) {
    throw new Error(`Skill bundle has too many entries (> ${SKILL_BUNDLE_MAX_ENTRIES}).`);
  }
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
 * instead of the CONFLICT a name clash with another skill gets, and so no host
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
  lstat(file).then(
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
