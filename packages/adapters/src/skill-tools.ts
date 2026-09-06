import {
  asSkillAvailability,
  buildSkillMd,
  defaultSkillAvailability,
  findSkillByName,
  isMarketplaceSkillKey,
  isSkillVisible,
  mergeBuiltinSkills,
  parseSkillMd,
  type SkillRecord,
  userSkillKey,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";
import { listMarketplaceSkills, marketplacesRoot } from "./marketplace-store.js";
import {
  isExists,
  listUserSkills,
  removeUserSkill,
  renameUserSkill,
  userSkillsRoot,
  writeUserSkill,
} from "./skill-store.js";

export const SKILL_TOOL_NAMES = new Set([
  "skill_read",
  "skill_create",
  "skill_update",
  "skill_delete",
]);

/** Match CreateAgentSkillInput / UpdateAgentSkillInput / parseSkillMd bounds. */
const MAX_SKILL_CONTENT_CHARS = 100_000;
const MAX_SKILL_NAME_CHARS = 80;
const MAX_SKILL_DESCRIPTION_CHARS = 2000;

type SkillOwner = {
  spaceId: string;
  userId: string;
  /** When set, list/read/update/delete only see skills visible to this bot. */
  botId?: string;
};

export type SkillToolDeps = { prisma: PrismaClient; dataDir: string };

function builtinRecords(): Array<SkillRecord & { id: string }> {
  return BUILTIN_AGENT_SKILLS.map((skill) => ({
    id: `builtin:${skill.name}`,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    source: "builtin" as const,
    readOnly: true,
  }));
}

function readOnlyError(skill: {
  id: string;
  source: string;
  readOnly: boolean;
}): string | undefined {
  if (isMarketplaceSkillKey(skill.id)) {
    return "Marketplace skills are read-only; edit them upstream and update the marketplace.";
  }
  if (skill.readOnly || skill.source !== "user") return "Builtin and plugin skills are read-only.";
  return undefined;
}

function rejectOversizedContent(content: string): string | undefined {
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return `Skill content must be at most ${MAX_SKILL_CONTENT_CHARS} characters.`;
  }
  return undefined;
}

function rejectInvalidSkillFields(name: string, description: string): string | undefined {
  if (!name) return "Skill name is required.";
  if (!description) return "Skill description is required.";
  if (name.length > MAX_SKILL_NAME_CHARS) {
    return `Skill name must be at most ${MAX_SKILL_NAME_CHARS} characters.`;
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    return `Skill description must be at most ${MAX_SKILL_DESCRIPTION_CHARS} characters.`;
  }
  return undefined;
}

export async function listAgentSkillRecords(
  deps: SkillToolDeps,
  owner: SkillOwner,
): Promise<Array<SkillRecord & { id: string }>> {
  const [userSkills, marketplaceSkills] = await Promise.all([
    listUserSkills(userSkillsRoot(deps.dataDir, owner)),
    listMarketplaceSkills(marketplacesRoot(deps.dataDir, owner.spaceId)),
  ]);
  // Builtins join the catalog before filtering: a user skill shadows a same-named builtin,
  // and per-bot availability applies to builtins too.
  const records = mergeBuiltinSkills(builtinRecords(), [...userSkills, ...marketplaceSkills]);
  return owner.botId ? await onlyVisibleTo(deps.prisma, owner, owner.botId, records) : records;
}

async function onlyVisibleTo<T extends { id: string }>(
  prisma: PrismaClient,
  owner: SkillOwner,
  botId: string,
  records: T[],
): Promise<T[]> {
  const [settings, overrides] = await Promise.all([
    prisma.skillSetting.findMany({ where: { spaceId: owner.spaceId, userId: owner.userId } }),
    prisma.botSkill.findMany({ where: { botId, spaceId: owner.spaceId, userId: owner.userId } }),
  ]);
  const availability = new Map(
    settings.map((s) => [s.skillKey, asSkillAvailability(s.availability)]),
  );
  const override = new Map(overrides.map((o) => [o.skillKey, o.enabled]));
  return records.filter((record) =>
    isSkillVisible({
      availability: availability.get(record.id) ?? defaultSkillAvailability(record.id),
      override: override.get(record.id),
    }),
  );
}

async function findOwnedSkill(
  deps: SkillToolDeps,
  owner: SkillOwner,
  input: { skillId?: string; name?: string },
): Promise<(SkillRecord & { id: string }) | null> {
  const skills = await listAgentSkillRecords(deps, owner);
  if (input.skillId) {
    return skills.find((skill) => skill.id === input.skillId) ?? null;
  }
  if (input.name) return findSkillByName(skills, input.name) ?? null;
  return null;
}

export async function skillReadFromTool(
  deps: SkillToolDeps,
  owner: SkillOwner,
  input: { name?: string; skillId?: string },
): Promise<Record<string, unknown>> {
  const skill = await findOwnedSkill(deps, owner, input);
  if (!skill) return { error: "Skill not found." };
  return {
    name: skill.name,
    description: skill.description,
    source: skill.source,
    readOnly: skill.readOnly,
    content: skill.content,
  };
}

export async function skillCreateFromTool(
  deps: SkillToolDeps,
  owner: SkillOwner,
  input: { name?: string; description?: string; body?: string; content?: string },
): Promise<Record<string, unknown>> {
  let name = "";
  let description = "";
  let content = "";
  if (input.content?.trim()) {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) return { error: parsed.error };
    name = parsed.name;
    description = parsed.description;
    content = buildSkillMd(parsed);
  } else {
    name = String(input.name ?? "").trim();
    description = String(input.description ?? "").trim();
    const body = String(input.body ?? "").trim();
    if (!name || !description) {
      return {
        error: "Provide name and description (and optional body), or full SKILL.md content.",
      };
    }
    const invalid = rejectInvalidSkillFields(name, description);
    if (invalid) return { error: invalid };
    content = buildSkillMd({ name, description, body });
  }

  const oversized = rejectOversizedContent(content);
  if (oversized) return { error: oversized };

  const existing = await findOwnedSkill(deps, owner, { name });
  if (existing) return { error: `A skill named "${existing.name}" already exists.` };

  const root = userSkillsRoot(deps.dataDir, owner);
  try {
    await writeUserSkill(root, { name, content }, "create");
  } catch (error) {
    return {
      error: isExists(error)
        ? `A skill named "${name}" already exists.`
        : "Could not create skill.",
    };
  }
  const skillKey = userSkillKey(name);
  if (owner.botId) {
    // A bot-created skill starts scoped to its creator (design Q2); the user widens it in the UI.
    // API/panel creation (no botId) stays "all agents": no access rows.
    const scope = { spaceId: owner.spaceId, userId: owner.userId };
    await deps.prisma.$transaction([
      deps.prisma.skillSetting.upsert({
        where: { spaceId_userId_skillKey: { ...scope, skillKey } },
        create: { ...scope, skillKey, availability: "selected" },
        update: { availability: "selected" },
      }),
      deps.prisma.botSkill.upsert({
        where: { botId_skillKey: { botId: owner.botId, skillKey } },
        create: { ...scope, botId: owner.botId, skillKey, enabled: true },
        update: { enabled: true },
      }),
    ]);
  }
  return {
    ok: true,
    id: skillKey,
    name,
    description,
    hint: owner.botId
      ? `Created skill, available to this agent. Mention /${name} so the user can open it; they can share it with other agents from its settings.`
      : `Created skill. Mention /${name} so the user can open it.`,
  };
}

export async function skillUpdateFromTool(
  deps: SkillToolDeps,
  owner: SkillOwner,
  input: {
    name?: string;
    skillId?: string;
    newName?: string;
    description?: string;
    body?: string;
    content?: string;
  },
): Promise<Record<string, unknown>> {
  const existing = await findOwnedSkill(deps, owner, {
    skillId: input.skillId,
    name: input.name,
  });
  if (!existing) return { error: "Skill not found." };
  const readOnly = readOnlyError(existing);
  if (readOnly) return { error: readOnly };

  let nextContent = existing.content;
  let nextName = existing.name;
  let nextDescription = existing.description;

  if (input.content?.trim()) {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) return { error: parsed.error };
    nextName = parsed.name;
    nextDescription = parsed.description;
    nextContent = buildSkillMd(parsed);
  } else {
    const prior = parseSkillMd(existing.content);
    if ("error" in prior) return { error: prior.error };
    // `name` is only a lookup key (see findOwnedSkill above); renames require `newName`.
    nextName = String(input.newName ?? existing.name).trim() || existing.name;
    nextDescription =
      input.description !== undefined ? String(input.description).trim() : existing.description;
    const body = input.body !== undefined ? String(input.body) : prior.body;
    const invalidFields = rejectInvalidSkillFields(nextName, nextDescription);
    if (invalidFields) return { error: invalidFields };
    nextContent = buildSkillMd({
      name: nextName,
      description: nextDescription,
      body,
      frontmatter: prior.frontmatter,
    });
  }

  const invalid = rejectInvalidSkillFields(nextName, nextDescription);
  if (invalid) return { error: invalid };
  const oversized = rejectOversizedContent(nextContent);
  if (oversized) return { error: oversized };

  if (nextName.toLowerCase() !== existing.name.toLowerCase()) {
    const clash = await findOwnedSkill(deps, owner, { name: nextName });
    if (clash && clash.id !== existing.id) {
      return { error: `A skill named "${clash.name}" already exists.` };
    }
  }

  const root = userSkillsRoot(deps.dataDir, owner);
  const scope = { spaceId: owner.spaceId, userId: owner.userId };
  const oldKey = userSkillKey(existing.name);
  const newKey = userSkillKey(nextName);
  try {
    if (oldKey === newKey) {
      await writeUserSkill(root, { name: nextName, content: nextContent }, "replace");
    } else {
      // Rename: the directory moves first (bundle extras follow), then access rows follow the key.
      await renameUserSkill(root, existing.name, { name: nextName, content: nextContent });
      await deps.prisma.$transaction([
        deps.prisma.skillSetting.updateMany({
          where: { ...scope, skillKey: oldKey },
          data: { skillKey: newKey },
        }),
        deps.prisma.botSkill.updateMany({
          where: { ...scope, skillKey: oldKey },
          data: { skillKey: newKey },
        }),
      ]);
    }
  } catch (error) {
    return {
      error: isExists(error)
        ? `A skill named "${nextName}" already exists.`
        : "Could not update skill.",
    };
  }
  return { ok: true, id: newKey, name: nextName, description: nextDescription };
}

export async function skillDeleteFromTool(
  deps: SkillToolDeps,
  owner: SkillOwner,
  input: { name?: string; skillId?: string },
): Promise<Record<string, unknown>> {
  const existing = await findOwnedSkill(deps, owner, input);
  if (!existing) return { error: "Skill not found." };
  const readOnly = readOnlyError(existing);
  if (readOnly) return { error: readOnly };
  const scope = { spaceId: owner.spaceId, userId: owner.userId };
  const skillKey = userSkillKey(existing.name);
  // File first, rows second: orphan rows are harmless, a row-less file would widen to "all".
  await removeUserSkill(userSkillsRoot(deps.dataDir, owner), existing.name);
  await deps.prisma.$transaction([
    deps.prisma.skillSetting.deleteMany({ where: { ...scope, skillKey } }),
    deps.prisma.botSkill.deleteMany({ where: { ...scope, skillKey } }),
  ]);
  return { ok: true, name: existing.name };
}
