import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import type { SkillCollision, WorkerSkill } from "@tangow/adapter-kit";
import { parseSkillMd } from "@tangow/core";
import { hasCode, skillDirName } from "./skill-store.js";

export type SkillRoot = { source: WorkerSkill["source"]; path: string };
export type VolumeSkill = Omit<WorkerSkill, "contentHash" | "files">;
const ORDER = { managed: 0, bot: 1, shared: 2 };
const MAX_SKILL_BYTES = 100_000;
// Legacy SKILL.md accepts 100,000 characters, including multibyte text.
const MAX_DISCOVERY_BYTES = 400_000;
const MAX_REPORT_BYTES = 500_000;

/** Only direct, plain skill directories. Sources never follow a link out of their volume. */
export async function discoverVolumeSkills(roots: readonly SkillRoot[]) {
  const skills: VolumeSkill[] = [];
  const collisions: SkillCollision[] = [];
  const byName = new Map<string, VolumeSkill>();
  for (const root of [...roots].sort((a, b) => ORDER[a.source] - ORDER[b.source])) {
    const entries = await readdir(root.path, { withFileTypes: true }).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const file = path.join(root.path, entry.name, "SKILL.md");
      const info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.size > MAX_DISCOVERY_BYTES) continue;
      const content = await readFile(file, "utf8");
      const parsed = parseSkillMd(content);
      if ("error" in parsed) continue;
      const skill = {
        name: parsed.name,
        description: parsed.description,
        content,
        path: file,
        source: root.source,
      };
      const key = skillDirName(skill.name);
      const kept = byName.get(key);
      if (kept) collisions.push({ name: skill.name, kept: kept.source, ignored: skill.source });
      else {
        byName.set(key, skill);
        skills.push(skill);
      }
    }
  }
  return { skills, collisions };
}

/** A worker starts with a fresh home. Never replace any pre-existing skill entry. */
export async function convergeSkills(home: string, roots: readonly SkillRoot[]) {
  const discovered = await discoverVolumeSkills(roots);
  const agentsDir = path.join(home, ".agents");
  const skillsDir = path.join(agentsDir, "skills");
  const parent = await lstat(agentsDir).catch(() => null);
  if (parent && !parent.isDirectory())
    throw new Error("Agents directory must be a plain directory");
  const info = await lstat(skillsDir).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  });
  if (info && !info.isDirectory()) throw new Error("Skills directory must be a plain directory");
  if (info && (await readdir(skillsDir)).length > 0)
    throw new Error("Skills directory must be empty before convergence");
  await mkdir(skillsDir, { recursive: true });
  for (const skill of discovered.skills) {
    await symlink(path.dirname(skill.path), path.join(skillsDir, skillDirName(skill.name)), "dir");
  }
  return { ...discovered, skillsDir };
}

/** Full text of every plain file for the controller's scan. Oversized/linked bundles stay unindexed. */
export async function reportVolumeSkill(skill: VolumeSkill): Promise<WorkerSkill | undefined> {
  if (skill.content.length > 100_000) return undefined;
  const files: WorkerSkill["files"] = [];
  let bytes = Buffer.byteLength(skill.content);
  const walk = async (dir: string, prefix: string): Promise<boolean> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === "SKILL.md") continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(await walk(file, relative))) return false;
      } else {
        const info = await lstat(file);
        if (!info.isFile() || info.size > MAX_SKILL_BYTES || files.length >= 128) return false;
        const content = await readFile(file, "utf8");
        bytes += Buffer.byteLength(content);
        if (bytes > MAX_REPORT_BYTES || content.includes("\0")) return false;
        files.push({ path: relative, content });
      }
    }
    return true;
  };
  try {
    if (!(await walk(path.dirname(skill.path), ""))) return undefined;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const report = {
    ...skill,
    contentHash: createHash("sha256").update(skill.content).digest("hex"),
    files,
  };
  return Buffer.byteLength(JSON.stringify(report)) <= 512 * 1024 ? report : undefined;
}

/** Native reads, including reads through ~/.agents/skills links, count as skill uses. */
export async function skillReadName(cwd: string, value: unknown): Promise<string | undefined> {
  if (typeof value !== "string" || path.basename(value) !== "SKILL.md") return undefined;
  const file = await realpath(path.resolve(cwd, value)).catch(() => undefined);
  if (!file) return undefined;
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_DISCOVERY_BYTES) return undefined;
  const content = await readFile(file, "utf8").catch(() => undefined);
  if (content === undefined) return undefined;
  const parsed = parseSkillMd(content);
  return "error" in parsed ? undefined : parsed.name;
}
