import { ORPCError } from "@orpc/server";
import {
  BUILTIN_AGENT_SKILLS,
  isExists,
  listUserSkills,
  removeUserSkill,
  type UserSkillFile,
  userSkillsRoot,
  writeUserSkill,
} from "@rakazo/adapters";
import type { Actor, AgentSkill, AgentSkillCatalogEntry } from "@rakazo/contracts";
import {
  asSkillAvailability,
  buildSkillMd,
  isSkillVisible,
  parseSkillMd,
  userSkillKey,
} from "@rakazo/core";
import { IsolationError, type PrismaClient } from "@rakazo/db";

function toAgentSkill(file: UserSkillFile): AgentSkill {
  return {
    id: file.id,
    name: file.name,
    description: file.description,
    content: file.content,
    source: "user",
    readOnly: false,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function builtinCatalog(): AgentSkill[] {
  return BUILTIN_AGENT_SKILLS.map((skill) => ({
    id: `builtin:${skill.name}`,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    source: "builtin" as const,
    readOnly: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }));
}

export function resolveSkillContent(input: {
  content?: string;
  name?: string;
  description?: string;
  body?: string;
  prior?: { content: string };
}): { name: string; description: string; content: string } {
  const ensureContentLimit = (content: string): string => {
    if (content.length > 100_000) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Skill content must be at most 100000 characters.",
      });
    }
    return content;
  };

  if (input.content?.trim()) {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) {
      throw new ORPCError("BAD_REQUEST", { message: parsed.error });
    }
    return {
      name: parsed.name,
      description: parsed.description,
      content: ensureContentLimit(buildSkillMd(parsed)),
    };
  }

  const priorParsed = input.prior ? parseSkillMd(input.prior.content) : null;
  if (priorParsed && "error" in priorParsed) {
    throw new ORPCError("BAD_REQUEST", { message: priorParsed.error });
  }

  const name = (input.name ?? priorParsed?.name ?? "").trim();
  const description = (input.description ?? priorParsed?.description ?? "").trim();
  const body = input.body ?? priorParsed?.body ?? "";
  if (!name || !description) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Provide content (SKILL.md) or name + description (+ optional body)",
    });
  }
  let content: string;
  try {
    content = buildSkillMd({
      name,
      description,
      body,
      frontmatter: priorParsed && !("error" in priorParsed) ? priorParsed.frontmatter : undefined,
    });
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Invalid skill fields.",
    });
  }
  const validated = parseSkillMd(content);
  if ("error" in validated) {
    throw new ORPCError("BAD_REQUEST", { message: validated.error });
  }
  return {
    name: validated.name,
    description: validated.description,
    content: ensureContentLimit(buildSkillMd(validated)),
  };
}

export function createAgentSkillsService(prisma: PrismaClient, dataDir: string) {
  const root = (actor: Actor) => userSkillsRoot(dataDir, actor);
  const files = (actor: Actor) => listUserSkills(root(actor));

  async function owned(actor: Actor, skillId: string): Promise<UserSkillFile> {
    const file = (await files(actor)).find((skill) => skill.id === skillId);
    if (!file) throw new IsolationError();
    return file;
  }

  function assertNameFree(existing: UserSkillFile[], name: string, exceptId?: string) {
    const clash =
      existing.some((s) => s.id !== exceptId && sameName(s.name, name)) ||
      builtinCatalog().some((s) => sameName(s.name, name));
    if (clash) {
      throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
    }
  }

  function conflictOrRethrow(error: unknown): never {
    if (isExists(error)) {
      throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
    }
    throw error;
  }

  type Access = Pick<AgentSkillCatalogEntry, "availability" | "visibleBotIds">;

  /** Resolve availability + visible bots for every skill of the owner in 3 queries. */
  async function accessIndex(actor: Actor): Promise<{
    bots: string[];
    of: (name: string) => Access;
  }> {
    const scope = { spaceId: actor.spaceId, userId: actor.userId };
    const [bots, settings, overrides] = await Promise.all([
      prisma.bot.findMany({
        where: { ...scope, archivedAt: null },
        select: { id: true },
        orderBy: { position: "asc" },
      }),
      prisma.skillSetting.findMany({ where: scope }),
      prisma.botSkill.findMany({ where: scope }),
    ]);
    const availability = new Map(
      settings.map((s) => [s.skillKey, asSkillAvailability(s.availability)]),
    );
    const override = new Map(overrides.map((o) => [`${o.botId}\n${o.skillKey}`, o.enabled]));
    const botIds = bots.map((bot) => bot.id);
    return {
      bots: botIds,
      of(name) {
        const key = userSkillKey(name);
        const skillAvailability = availability.get(key) ?? "all";
        return {
          availability: skillAvailability,
          visibleBotIds: botIds.filter((botId) =>
            isSkillVisible({
              availability: skillAvailability,
              override: override.get(`${botId}\n${key}`),
            }),
          ),
        };
      },
    };
  }

  async function catalog(actor: Actor, botId?: string): Promise<Array<AgentSkill & Access>> {
    const [rows, access] = await Promise.all([files(actor), accessIndex(actor)]);
    const builtins = builtinCatalog().map((skill) => ({
      ...skill,
      availability: "all" as const,
      visibleBotIds: access.bots,
    }));
    const users = rows.map((file) => ({ ...toAgentSkill(file), ...access.of(file.name) }));
    const entries = [...builtins, ...users];
    return botId ? entries.filter((entry) => entry.visibleBotIds.includes(botId)) : entries;
  }

  async function list(actor: Actor, input?: { botId?: string }): Promise<AgentSkillCatalogEntry[]> {
    return (await catalog(actor, input?.botId)).map(({ content: _content, ...entry }) => entry);
  }

  return {
    list,

    async listWithContent(actor: Actor, botId?: string): Promise<AgentSkill[]> {
      return catalog(actor, botId);
    },

    async get(actor: Actor, input: { skillId?: string; name?: string }): Promise<AgentSkill> {
      if (input.skillId?.startsWith("builtin:")) {
        const builtin = builtinCatalog().find((skill) => skill.id === input.skillId);
        if (!builtin) throw new IsolationError();
        return builtin;
      }
      if (input.skillId) {
        return toAgentSkill(await owned(actor, input.skillId));
      }
      const name = input.name?.trim() ?? "";
      const builtin = builtinCatalog().find((skill) => sameName(skill.name, name));
      if (builtin) return builtin;
      const file = (await files(actor)).find((skill) => sameName(skill.name, name));
      if (!file) throw new IsolationError();
      return toAgentSkill(file);
    },

    async create(
      actor: Actor,
      input: { content?: string; name?: string; description?: string; body?: string },
    ): Promise<AgentSkill> {
      const resolved = resolveSkillContent(input);
      assertNameFree(await files(actor), resolved.name);
      await writeUserSkill(
        root(actor),
        { name: resolved.name, content: resolved.content },
        "create",
      ).catch(conflictOrRethrow);
      return toAgentSkill(await owned(actor, userSkillKey(resolved.name)));
    },

    async update(
      actor: Actor,
      input: {
        skillId: string;
        content?: string;
        name?: string;
        description?: string;
        body?: string;
      },
    ): Promise<AgentSkill> {
      const existing = await owned(actor, input.skillId);
      const resolved = resolveSkillContent({ ...input, prior: existing });
      const oldKey = existing.id;
      const newKey = userSkillKey(resolved.name);
      const skill = { name: resolved.name, content: resolved.content };
      if (oldKey === newKey) {
        await writeUserSkill(root(actor), skill, "replace");
        return toAgentSkill(await owned(actor, newKey));
      }
      // Rename: new file first, then access rows follow the key, then the old file goes.
      assertNameFree(await files(actor), resolved.name, existing.id);
      await writeUserSkill(root(actor), skill, "create").catch(conflictOrRethrow);
      const scope = { spaceId: actor.spaceId, userId: actor.userId };
      await prisma.$transaction([
        prisma.skillSetting.updateMany({
          where: { ...scope, skillKey: oldKey },
          data: { skillKey: newKey },
        }),
        prisma.botSkill.updateMany({
          where: { ...scope, skillKey: oldKey },
          data: { skillKey: newKey },
        }),
      ]);
      await removeUserSkill(root(actor), existing.name);
      return toAgentSkill(await owned(actor, newKey));
    },

    async remove(actor: Actor, skillId: string): Promise<{ ok: true }> {
      const existing = await owned(actor, skillId);
      const scope = { spaceId: actor.spaceId, userId: actor.userId };
      // File first, rows second: orphan rows are harmless, a row-less file would widen to "all".
      await removeUserSkill(root(actor), existing.name);
      await prisma.$transaction([
        prisma.skillSetting.deleteMany({ where: { ...scope, skillKey: existing.id } }),
        prisma.botSkill.deleteMany({ where: { ...scope, skillKey: existing.id } }),
      ]);
      return { ok: true };
    },

    async setAccess(
      actor: Actor,
      input: {
        skillId: string;
        availability?: "all" | "selected";
        bot?: { botId: string; enabled: boolean };
      },
    ): Promise<AgentSkillCatalogEntry> {
      const existing = await owned(actor, input.skillId);
      const scope = { spaceId: actor.spaceId, userId: actor.userId };
      const skillKey = existing.id;
      if (input.bot) {
        const bot = await prisma.bot.findFirst({
          where: { id: input.bot.botId, ...scope },
          select: { id: true },
        });
        if (!bot) throw new IsolationError();
      }
      await prisma.$transaction([
        ...(input.availability
          ? [
              prisma.skillSetting.upsert({
                where: { spaceId_userId_skillKey: { ...scope, skillKey } },
                create: { ...scope, skillKey, availability: input.availability },
                update: { availability: input.availability },
              }),
            ]
          : []),
        ...(input.bot
          ? [
              prisma.botSkill.upsert({
                where: { botId_skillKey: { botId: input.bot.botId, skillKey } },
                create: { ...scope, botId: input.bot.botId, skillKey, enabled: input.bot.enabled },
                update: { enabled: input.bot.enabled },
              }),
            ]
          : []),
      ]);
      const entry = (await list(actor)).find((skill) => skill.id === existing.id);
      if (!entry) throw new IsolationError();
      return entry;
    },
  };
}

export type AgentSkillsService = ReturnType<typeof createAgentSkillsService>;
