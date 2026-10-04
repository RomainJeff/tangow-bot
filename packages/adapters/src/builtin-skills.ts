import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillMd } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { skillDirName } from "./skill-store.js";

/**
 * Built-in Agent Skills (SKILL.md recipes) available to every user, read from `skills/agent/`
 * at the repository root (`/app/skills/agent` in the app image). See `skills/README.md`.
 * Only generic how-tos; no account-specific content.
 * Descriptions show in the / picker (truncated at 72) and inject every turn in the skills catalog.
 */
export const BUILTIN_SKILLS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../skills/agent",
);

export type BuiltinSkill = { name: string; description: string; content: string };

// ponytail: no cache, add one if readdir shows in profiles.
export async function loadBuiltinSkills(root = BUILTIN_SKILLS_ROOT): Promise<BuiltinSkill[]> {
  const entries = await readdir(root).catch(() => [] as string[]);
  const skills: BuiltinSkill[] = [];
  for (const entry of entries) {
    const file = path.join(root, entry, "SKILL.md");
    const content = await readFile(file, "utf8").catch(() => undefined);
    if (content === undefined) continue;
    const parsed = parseSkillMd(content);
    if ("error" in parsed) {
      getLogger().warn(`[skills] ignoring ${file}: ${parsed.error}`);
      continue;
    }
    // The directory is where /managed-skills/agent/<dir>/ files live; it must follow the name.
    if (skillDirName(parsed.name) !== entry) {
      getLogger().warn(`[skills] ignoring ${file}: directory must be ${skillDirName(parsed.name)}`);
      continue;
    }
    skills.push({ name: parsed.name, description: parsed.description, content });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
