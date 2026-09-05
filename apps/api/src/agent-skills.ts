import { ORPCError } from "@orpc/server";
import { BUILTIN_AGENT_SKILLS } from "@rakazo/adapters";
import type {
  Actor,
  AgentSkill,
  AgentSkillCatalogEntry,
  AgentSkillSource,
} from "@rakazo/contracts";
import {
  asSkillAvailability,
  buildSkillMd,
  isSkillReadOnly,
  isSkillVisible,
  parseSkillMd,
  type SkillSource,
  userSkillKey,
} from "@rakazo/core";
import { IsolationError, type PrismaClient } from "@rakazo/db";

type AgentSkillRow = {
  id: string;
  name: string;
  description: string;
  content: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
};

function asSource(value: string): AgentSkillSource {
  if (value === "builtin" || value === "plugin" || value === "user") return value;
  return "user";
}

export function mapAgentSkill(row: AgentSkillRow): AgentSkill {
  const source = asSource(row.source);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    source,
    readOnly: isSkillReadOnly(source as SkillSource),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

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

export function createAgentSkillsService(prisma: PrismaClient) {
  async function owned(actor: Actor, skillId: string) {
    const row = await prisma.agentSkill.findFirst({
      where: {
        id: skillId,
        spaceId: actor.spaceId,
        userId: actor.userId,
      },
    });
    if (!row) throw new IsolationError();
    return row;
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
    const [rows, access] = await Promise.all([
      prisma.agentSkill.findMany({
        where: { spaceId: actor.spaceId, userId: actor.userId },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      }),
      accessIndex(actor),
    ]);
    const builtins = builtinCatalog().map((skill) => ({
      ...skill,
      availability: "all" as const,
      visibleBotIds: access.bots,
    }));
    const users = rows.map((row) => ({ ...mapAgentSkill(row), ...access.of(row.name) }));
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
        return mapAgentSkill(await owned(actor, input.skillId));
      }
      const name = input.name?.trim() ?? "";
      const builtin = builtinCatalog().find(
        (skill) => skill.name.toLowerCase() === name.toLowerCase(),
      );
      if (builtin) return builtin;
      const row = await prisma.agentSkill.findFirst({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          name: { equals: name, mode: "insensitive" },
        },
      });
      if (!row) throw new IsolationError();
      return mapAgentSkill(row);
    },

    async create(
      actor: Actor,
      input: { content?: string; name?: string; description?: string; body?: string },
    ): Promise<AgentSkill> {
      const resolved = resolveSkillContent(input);
      const clash = await prisma.agentSkill.findFirst({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          name: { equals: resolved.name, mode: "insensitive" },
        },
      });
      if (
        clash ||
        builtinCatalog().some((s) => s.name.toLowerCase() === resolved.name.toLowerCase())
      ) {
        throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
      }
      try {
        const row = await prisma.agentSkill.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            name: resolved.name,
            description: resolved.description,
            content: resolved.content,
            source: "user",
          },
        });
        return mapAgentSkill(row);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code?: string }).code === "P2002"
        ) {
          throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
        }
        throw error;
      }
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
      if (isSkillReadOnly(asSource(existing.source) as SkillSource)) {
        throw new ORPCError("BAD_REQUEST", { message: "Builtin and plugin skills are read-only." });
      }
      const resolved = resolveSkillContent({ ...input, prior: existing });
      if (resolved.name.toLowerCase() !== existing.name.toLowerCase()) {
        const clash = await prisma.agentSkill.findFirst({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            name: { equals: resolved.name, mode: "insensitive" },
            NOT: { id: existing.id },
          },
        });
        if (
          clash ||
          builtinCatalog().some((s) => s.name.toLowerCase() === resolved.name.toLowerCase())
        ) {
          throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
        }
      }
      // Mutate only owner-scoped user rows (never builtin/plugin), even if source was tampered.
      try {
        const scope = { spaceId: actor.spaceId, userId: actor.userId };
        const oldKey = userSkillKey(existing.name);
        const newKey = userSkillKey(resolved.name);
        const [updated] = await prisma.$transaction([
          prisma.agentSkill.updateMany({
            where: { id: existing.id, ...scope, source: "user" },
            data: {
              name: resolved.name,
              description: resolved.description,
              content: resolved.content,
            },
          }),
          // Rename cascade: access rows follow the skill's key (case-only rename keeps the key).
          ...(oldKey !== newKey
            ? [
                prisma.skillSetting.updateMany({
                  where: { ...scope, skillKey: oldKey },
                  data: { skillKey: newKey },
                }),
                prisma.botSkill.updateMany({
                  where: { ...scope, skillKey: oldKey },
                  data: { skillKey: newKey },
                }),
              ]
            : []),
        ]);
        if (updated.count !== 1) throw new IsolationError();
      } catch (error) {
        if (error instanceof IsolationError) throw error;
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code?: string }).code === "P2002"
        ) {
          throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
        }
        throw error;
      }
      const row = await prisma.agentSkill.findFirst({
        where: {
          id: existing.id,
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
      });
      if (!row) throw new IsolationError();
      return mapAgentSkill(row);
    },

    async remove(actor: Actor, skillId: string): Promise<{ ok: true }> {
      const existing = await owned(actor, skillId);
      if (isSkillReadOnly(asSource(existing.source) as SkillSource)) {
        throw new ORPCError("BAD_REQUEST", { message: "Builtin and plugin skills are read-only." });
      }
      const scope = { spaceId: actor.spaceId, userId: actor.userId };
      const skillKey = userSkillKey(existing.name);
      // GC access rows with the skill so a future skill on the same key starts clean.
      const [deleted] = await prisma.$transaction([
        prisma.agentSkill.deleteMany({ where: { id: existing.id, ...scope, source: "user" } }),
        prisma.skillSetting.deleteMany({ where: { ...scope, skillKey } }),
        prisma.botSkill.deleteMany({ where: { ...scope, skillKey } }),
      ]);
      if (deleted.count !== 1) throw new IsolationError();
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
      const skillKey = userSkillKey(existing.name);
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
