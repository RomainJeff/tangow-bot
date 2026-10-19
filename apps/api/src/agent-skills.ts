import { ORPCError } from "@orpc/server";
import {
  bundleFormat,
  isExists,
  listMarketplaceSkills,
  listUserSkills,
  loadBuiltinSkills,
  type MarketplaceSkillFile,
  marketplacesRoot,
  removeUserSkill,
  renameUserSkill,
  type SkillOwnerLock,
  type UserSkillFile,
  userSkillsRoot,
  writeUserSkill,
  writeUserSkillBundle,
} from "@rakazo/adapters";
import type {
  Actor,
  AgentSkill,
  AgentSkillCatalogEntry,
  SkillAvailability,
} from "@rakazo/contracts";
import {
  asSkillAvailability,
  buildSkillMd,
  defaultSkillAvailability,
  findSkillByName,
  isSkillVisible,
  MEMORY_MANAGEMENT_SKILL_KEY,
  mergeBuiltinSkills,
  parseSkillMd,
  userSkillKey,
} from "@rakazo/core";
import { IsolationError, type PrismaClient } from "@rakazo/db";

type SkillFile = UserSkillFile | MarketplaceSkillFile;

function toAgentSkill(file: SkillFile): AgentSkill {
  return {
    id: file.id,
    name: file.name,
    description: file.description,
    content: file.content,
    source: file.source,
    readOnly: file.readOnly,
    // ponytail: marketplace files only carry mtime; install time is not tracked.
    createdAt: ("createdAt" in file ? file.createdAt : file.updatedAt).toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

function assertWritable(file: SkillFile): asserts file is UserSkillFile {
  if (file.readOnly) {
    throw new ORPCError("FORBIDDEN", {
      message: "Marketplace skills are read-only; edit them upstream and update the marketplace.",
    });
  }
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function builtinCatalog(): Promise<AgentSkill[]> {
  return (await loadBuiltinSkills()).map((skill) => ({
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

export function createAgentSkillsService(
  prisma: PrismaClient,
  dataDir: string,
  lock: SkillOwnerLock,
) {
  const root = (actor: Actor) => userSkillsRoot(dataDir, actor);
  const files = (actor: Actor) => listUserSkills(root(actor));
  const marketplaceFiles = (actor: Actor) =>
    listMarketplaceSkills(marketplacesRoot(dataDir, actor.spaceId));
  const allFiles = async (actor: Actor): Promise<SkillFile[]> =>
    (await Promise.all([files(actor), marketplaceFiles(actor)])).flat();

  async function owned(actor: Actor, skillId: string): Promise<SkillFile> {
    const file = (await allFiles(actor)).find((skill) => skill.id === skillId);
    if (!file) throw new IsolationError();
    return file;
  }

  async function assertNameFree(existing: UserSkillFile[], name: string, exceptId?: string) {
    const clash =
      existing.some((s) => s.id !== exceptId && sameName(s.name, name)) ||
      (await builtinCatalog()).some((s) => sameName(s.name, name));
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
    of: (key: string) => Access;
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
      of(key) {
        const skillAvailability = availability.get(key) ?? defaultSkillAvailability(key);
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
    const [rows, access, builtinSkills] = await Promise.all([
      allFiles(actor),
      accessIndex(actor),
      builtinCatalog(),
    ]);
    const builtins = builtinSkills.map((skill) => ({
      ...skill,
      ...access.of(skill.id),
    }));
    const users = rows.map((file) => ({ ...toAgentSkill(file), ...access.of(file.id) }));
    const entries = mergeBuiltinSkills(builtins, users);
    return botId ? entries.filter((entry) => entry.visibleBotIds.includes(botId)) : entries;
  }

  async function list(actor: Actor, input?: { botId?: string }): Promise<AgentSkillCatalogEntry[]> {
    return (await catalog(actor, input?.botId)).map(({ content: _content, ...entry }) => entry);
  }

  async function create(
    actor: Actor,
    input: { content?: string; name?: string; description?: string; body?: string },
  ): Promise<AgentSkill> {
    const resolved = resolveSkillContent(input);
    await assertNameFree(await files(actor), resolved.name);
    await writeUserSkill(
      root(actor),
      { name: resolved.name, content: resolved.content },
      "create",
    ).catch(conflictOrRethrow);
    return toAgentSkill(await owned(actor, userSkillKey(resolved.name)));
  }

  const service = {
    list,

    async listWithContent(actor: Actor, botId?: string): Promise<AgentSkill[]> {
      return catalog(actor, botId);
    },

    async get(actor: Actor, input: { skillId?: string; name?: string }): Promise<AgentSkill> {
      if (input.skillId?.startsWith("builtin:")) {
        const builtin = (await builtinCatalog()).find((skill) => skill.id === input.skillId);
        if (!builtin) throw new IsolationError();
        return builtin;
      }
      if (input.skillId) {
        return toAgentSkill(await owned(actor, input.skillId));
      }
      const name = input.name?.trim() ?? "";
      const file = findSkillByName(await allFiles(actor), name);
      if (file) return toAgentSkill(file);
      const builtin = findSkillByName(await builtinCatalog(), name);
      if (!builtin) throw new IsolationError();
      return builtin;
    },

    create,

    /** `.skill` file: gzip tar or zip bundle (sniffed by magic bytes) or plain SKILL.md text. */
    async import(actor: Actor, input: { data: string }): Promise<AgentSkill> {
      const bytes = Buffer.from(input.data, "base64");
      if (!bundleFormat(bytes)) {
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new ORPCError("BAD_REQUEST", {
            message: "Not a .skill file (expected SKILL.md text, or a gzip tar or zip bundle).",
          });
        }
        return create(actor, { content });
      }
      let name = "";
      await writeUserSkillBundle(root(actor), bytes, async (skillMd) => {
        const resolved = resolveSkillContent({ content: skillMd });
        await assertNameFree(await files(actor), resolved.name);
        name = resolved.name;
        return resolved;
      }).catch((error: unknown) => {
        if (error instanceof ORPCError) throw error;
        if (isExists(error)) conflictOrRethrow(error);
        // A filesystem failure is the server's, and its message names a host path.
        if (error instanceof Error && "syscall" in error) throw error;
        // ponytail: archive/layout failures all read fine as-is; no error taxonomy.
        throw new ORPCError("BAD_REQUEST", {
          message: error instanceof Error ? error.message : "Invalid skill bundle.",
        });
      });
      return toAgentSkill(await owned(actor, userSkillKey(name)));
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
      assertWritable(existing);
      const resolved = resolveSkillContent({ ...input, prior: existing });
      const oldKey = existing.id;
      const newKey = userSkillKey(resolved.name);
      const skill = { name: resolved.name, content: resolved.content };
      if (oldKey === newKey) {
        await writeUserSkill(root(actor), skill, "replace");
        return toAgentSkill(await owned(actor, newKey));
      }
      // Rename: the directory moves first (bundle extras follow), then access rows follow the key.
      await assertNameFree(await files(actor), resolved.name, existing.id);
      await renameUserSkill(root(actor), existing.name, skill).catch(conflictOrRethrow);
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
      return toAgentSkill(await owned(actor, newKey));
    },

    async remove(actor: Actor, skillId: string): Promise<{ ok: true }> {
      const existing = await owned(actor, skillId);
      assertWritable(existing);
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
        availability?: SkillAvailability;
        bots?: Array<{ botId: string; enabled: boolean }>;
      },
    ): Promise<AgentSkillCatalogEntry> {
      const existing =
        input.skillId === MEMORY_MANAGEMENT_SKILL_KEY
          ? (await builtinCatalog()).find((skill) => skill.id === input.skillId)!
          : await owned(actor, input.skillId);
      const scope = { spaceId: actor.spaceId, userId: actor.userId };
      const skillKey = existing.id;
      const bots = input.bots ?? [];
      if (bots.length > 0) {
        const ids = [...new Set(bots.map((bot) => bot.botId))];
        const known = await prisma.bot.findMany({
          where: { id: { in: ids }, ...scope },
          select: { id: true },
        });
        if (known.length !== ids.length) throw new IsolationError();
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
        ...bots.map((bot) =>
          prisma.botSkill.upsert({
            where: { botId_skillKey: { botId: bot.botId, skillKey } },
            create: { ...scope, botId: bot.botId, skillKey, enabled: bot.enabled },
            update: { enabled: bot.enabled },
          }),
        ),
      ]);
      const entry = (await list(actor)).find((skill) => skill.id === existing.id);
      if (!entry) throw new IsolationError();
      return entry;
    },
  };

  // Every write runs under the owner's skill lock, which the bots' skill tools take too.
  const locked =
    <A extends unknown[], R>(write: (actor: Actor, ...args: A) => Promise<R>) =>
    (actor: Actor, ...args: A) =>
      lock.run(actor, () => write(actor, ...args));
  return {
    ...service,
    create: locked(service.create),
    import: locked(service.import),
    update: locked(service.update),
    remove: locked(service.remove),
    setAccess: locked(service.setAccess),
  };
}

export type AgentSkillsService = ReturnType<typeof createAgentSkillsService>;
