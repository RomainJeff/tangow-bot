import { ORPCError } from "@orpc/server";
import type {
  MarketplaceSkillFile,
  SkillOwnerLock,
  UserSkillFile,
  VersionManifest,
} from "@rakazo/adapters";
import {
  bundleFormat,
  createSkillLibrary,
  listMarketplaceSkills,
  listUserSkills,
  loadBuiltinSkills,
  marketplacesRoot,
  parseSkillUid,
  parseVersionId,
  SkillRefusal,
  userSkillsRoot,
} from "@rakazo/adapters";
import type {
  Actor,
  AgentSkill,
  AgentSkillCatalogEntry,
  SkillAvailability,
  SkillVersion,
  SkillVersionDetail,
  TrashedSkill,
} from "@rakazo/contracts";
import {
  asSkillAvailability,
  buildSkillMd,
  defaultSkillAvailability,
  findSkillByName,
  isSkillVisible,
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

function toSkillVersion(manifest: VersionManifest, versions: VersionManifest[]): SkillVersion {
  const { author } = manifest;
  return {
    versionId: manifest.versionId,
    createdAt: manifest.createdAt,
    author:
      author.kind === "bot"
        ? { kind: "bot", botId: author.botId, botName: author.botName }
        : { kind: author.kind },
    nature: manifest.nature,
    current: versions.find((version) => !version.undoneAt)?.versionId === manifest.versionId,
    undone: manifest.undoneAt !== undefined,
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
  const library = createSkillLibrary({ prisma, dataDir, lock });
  const files = (actor: Actor) => listUserSkills(userSkillsRoot(dataDir, actor));
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

  function rethrowRefusal(error: unknown): never {
    if (!(error instanceof SkillRefusal)) throw error;
    if (error.reason === "name_taken") {
      throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
    }
    if (error.reason === "not_found") throw new IsolationError();
    if (error.reason === "stale") throw new ORPCError("CONFLICT", { message: error.message });
    if (error.reason === "unavailable") {
      throw new ORPCError("SERVICE_UNAVAILABLE", { message: error.message });
    }
    throw new ORPCError("BAD_REQUEST", { message: error.message });
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
      availability: "all" as const,
      visibleBotIds: access.bots,
    }));
    const users = rows.map((file) => ({ ...toAgentSkill(file), ...access.of(file.id) }));
    const entries = mergeBuiltinSkills(builtins, users);
    return botId ? entries.filter((entry) => entry.visibleBotIds.includes(botId)) : entries;
  }

  async function list(actor: Actor, input?: { botId?: string }): Promise<AgentSkillCatalogEntry[]> {
    return (await catalog(actor, input?.botId)).map(({ content: _content, ...entry }) => entry);
  }

  const admin = (actor: Actor) => library.forOwner(actor);

  async function history(actor: Actor, skillId: string) {
    const versions = await admin(actor).versions(skillId).catch(rethrowRefusal);
    const uid = versions[0]?.uid;
    if (!uid) throw new IsolationError();
    return { uid, versions };
  }

  const versionIdOf = (value: string) => {
    const versionId = parseVersionId(value);
    if (!versionId) throw new IsolationError();
    return versionId;
  };

  const trashedUidOf = (value: string) => {
    const uid = parseSkillUid(value);
    if (!uid) throw new IsolationError();
    return uid;
  };

  async function create(
    actor: Actor,
    input: { content?: string; name?: string; description?: string; body?: string },
  ): Promise<AgentSkill> {
    const resolved = resolveSkillContent(input);
    await assertNameFree(await files(actor), resolved.name);
    await library
      .forOwner(actor)
      .create({ kind: "skill-md", ...resolved })
      .catch(rethrowRefusal);
    return toAgentSkill(await owned(actor, userSkillKey(resolved.name)));
  }

  return {
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
      const saved = await library
        .forOwner(actor)
        .create({
          kind: "bundle",
          archive: bytes,
          resolve: async (skillMd) => {
            const resolved = resolveSkillContent({ content: skillMd });
            await assertNameFree(await files(actor), resolved.name);
            return resolved;
          },
        })
        .catch(rethrowRefusal);
      return toAgentSkill(await owned(actor, saved.key));
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
      const newKey = userSkillKey(resolved.name);
      if (newKey !== existing.id) {
        await assertNameFree(await files(actor), resolved.name, existing.id);
      }
      // A rename moves the whole folder and its access rows with it.
      await library
        .forOwner(actor)
        .update(existing.id, { kind: "skill-md", ...resolved })
        .catch(rethrowRefusal);
      return toAgentSkill(await owned(actor, newKey));
    },

    async remove(actor: Actor, skillId: string): Promise<{ ok: true }> {
      const existing = await owned(actor, skillId);
      assertWritable(existing);
      // To the trash, access rows included, rather than gone.
      await library.forOwner(actor).delete(existing.id).catch(rethrowRefusal);
      return { ok: true };
    },

    async versions(actor: Actor, input: { skillId: string }): Promise<SkillVersion[]> {
      const versions = await admin(actor).versions(input.skillId).catch(rethrowRefusal);
      if (versions.length === 0) await owned(actor, input.skillId);
      return versions.map((version) => toSkillVersion(version, versions));
    },

    async version(
      actor: Actor,
      input: { skillId: string; versionId: string },
    ): Promise<SkillVersionDetail> {
      const { uid, versions } = await history(actor, input.skillId);
      const { manifest, skillMd } = await admin(actor)
        .readVersion(uid, versionIdOf(input.versionId))
        .catch(rethrowRefusal);
      return {
        ...toSkillVersion(manifest, versions),
        content: skillMd,
        files: manifest.files.map(({ path, size }) => ({ path, size })),
      };
    },

    async undo(
      actor: Actor,
      input: { skillId: string; expectedVersionId: string },
    ): Promise<{ kind: "restored"; skillId: string; name: string } | { kind: "trashed" }> {
      const { uid } = await history(actor, input.skillId);
      const result = await admin(actor)
        .undo(uid, versionIdOf(input.expectedVersionId))
        .catch(rethrowRefusal);
      return result.kind === "trashed"
        ? result
        : { kind: "restored", skillId: result.key, name: result.name };
    },

    async deleteVersion(
      actor: Actor,
      input: { skillId: string; versionId: string },
    ): Promise<{ ok: true }> {
      const { uid } = await history(actor, input.skillId);
      await admin(actor).deleteVersion(uid, versionIdOf(input.versionId)).catch(rethrowRefusal);
      return { ok: true };
    },

    async trash(actor: Actor): Promise<TrashedSkill[]> {
      return admin(actor).trash().catch(rethrowRefusal);
    },

    async restore(
      actor: Actor,
      input: { uid: string },
    ): Promise<{ skillId: string; name: string; botGone: boolean }> {
      const restored = await admin(actor).restore(trashedUidOf(input.uid)).catch(rethrowRefusal);
      const botGone =
        restored.droppedBotIds.length > 0 &&
        (await accessIndex(actor)).of(restored.key).visibleBotIds.length === 0;
      return { skillId: restored.key, name: restored.name, botGone };
    },

    async purge(actor: Actor, input: { uid: string }): Promise<{ ok: true }> {
      await admin(actor).purge(trashedUidOf(input.uid)).catch(rethrowRefusal);
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
      const scope = { spaceId: actor.spaceId, userId: actor.userId };
      const existing = await owned(actor, input.skillId);
      const bots = input.bots ?? [];
      if (bots.length > 0) {
        const ids = [...new Set(bots.map((bot) => bot.botId))];
        const known = await prisma.bot.findMany({
          where: { id: { in: ids }, ...scope },
          select: { id: true },
        });
        if (known.length !== ids.length) throw new IsolationError();
      }
      // In the library, so a rename interrupted mid-way moves the rows before this change lands.
      await library
        .forOwner(actor)
        .setAccess(existing.id, { availability: input.availability, bots })
        .catch(rethrowRefusal);
      const entry = (await list(actor)).find((skill) => skill.id === existing.id);
      if (!entry) throw new IsolationError();
      return entry;
    },
  };
}

export type AgentSkillsService = ReturnType<typeof createAgentSkillsService>;
