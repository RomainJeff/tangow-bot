/**
 * Skills v2 phase 2: user skill content lives on disk, the DB only keeps access rows
 * (SkillSetting / BotSkill). One directory per skill under
 * DATA_DIR/skills/user/<spaceId>/<userId>/<dir>/SKILL.md. spaceId/userId are DB cuids
 * (trusted); the skill directory name is derived from the skill key, never from user input
 * directly, so no path can escape the owner's root.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseSkillMd, type SkillRecord, userSkillKey } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";

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
