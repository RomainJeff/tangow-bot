/**
 * Skills v2 phase 2: user skill content lives on disk, the DB only keeps access rows
 * (SkillSetting / BotSkill). One directory per skill under
 * DATA_DIR/skills/user/<spaceId>/<userId>/<dir>/SKILL.md. spaceId/userId are DB cuids
 * (trusted); the skill directory name is derived from the skill key, never from user input
 * directly, so no path can escape the owner's root.
 */
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { SKILL_BUNDLE_MAX_BYTES, SKILL_BUNDLE_MAX_ENTRIES } from "@rakazo/contracts";
import { parseSkillMd, type SkillRecord, userSkillKey } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { extract as tarExtract } from "tar";

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
 * Imports a `.skill` bundle: a gzip tar with SKILL.md at its root (or inside a single top-level
 * directory) plus any extra files (scripts/, references/, ...). Extracts into a temp dir under
 * root, lets `resolve` validate the SKILL.md (and return the normalized content), then renames
 * the tree into place with "create" semantics: EEXIST on a name clash, never a half-written
 * skill. Same hardening as the marketplace tarball: files and directories only, byte cap.
 */
export async function writeUserSkillBundle(
  root: string,
  archive: Buffer,
  resolve: (skillMd: string) => Promise<{ name: string; content: string }>,
): Promise<void> {
  await mkdir(root, { recursive: true });
  // No SKILL.md directly inside the wrapper, so listUserSkills never sees a half-imported skill.
  const wrapper = await mkdtemp(path.join(root, ".import-"));
  try {
    const out = path.join(wrapper, "bundle");
    await mkdir(out);
    await extractBundle(archive, out);
    const skillDir = await locateSkillDir(out);
    const resolved = await resolve(await readFile(path.join(skillDir, "SKILL.md"), "utf8"));
    await writeFile(path.join(skillDir, "SKILL.md"), resolved.content, "utf8");
    const dest = path.join(root, skillDirName(resolved.name));
    await mkdir(dest); // EEXIST = name clash, same signal as writeUserSkill "create"
    // rename(2) replaces the empty directory we just claimed.
    await rename(skillDir, dest).catch(async (error) => {
      await rm(dest, { recursive: true, force: true });
      throw error;
    });
  } finally {
    await rm(wrapper, { recursive: true, force: true });
  }
}

async function extractBundle(archive: Buffer, out: string): Promise<void> {
  let bytes = 0;
  let entries = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > SKILL_BUNDLE_MAX_BYTES) {
        callback(new Error(`Skill bundle too large (> ${SKILL_BUNDLE_MAX_BYTES} bytes).`));
        return;
      }
      callback(null, chunk);
    },
  });
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
  await pipeline(Readable.from([archive]), createGunzip(), limit, unpack);
}

const isFile = (file: string) =>
  stat(file).then(
    (info) => info.isFile(),
    () => false,
  );

async function locateSkillDir(out: string): Promise<string> {
  if (await isFile(path.join(out, "SKILL.md"))) return out;
  const entries = await readdir(out);
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
