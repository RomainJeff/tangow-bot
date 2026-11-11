import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@tangow/adapter-kit";
import {
  SKILL_BUNDLE_MAX_BYTES,
  SKILL_BUNDLE_MAX_ENTRIES,
  SKILL_DESCRIPTION_MAX_CHARS,
} from "@tangow/contracts";
import type { ParsedSkillMd, SkillLearningMode, SkillRecord } from "@tangow/core";
import {
  asSkillAvailability,
  buildSkillMd,
  containsSecret,
  findSkillByName,
  isSkillVisible,
  mergeManagedSkills,
  parseSkillMd,
  SANDBOX_SKILL_MOUNTS,
  searchSkills,
  userSkillKey,
  validateBotSkill,
  validateBotSkillFile,
} from "@tangow/core";
import type { PrismaClient } from "@tangow/db";
import { getLogger } from "@tangow/logging";
import { loadManagedSkills } from "./managed-skills.js";
import type { SkillOwnerLock } from "./skill-lock.js";
import type { SkillTreeFile } from "./skill-store.js";
import {
  botSkillsRoot,
  hasCode,
  isExists,
  isStorableFile,
  listUserSkills,
  removeUserSkill,
  renameUserSkill,
  replaceUserSkillFiles,
  skillDirName,
  userSkillsRoot,
  writeUserSkill,
  writeUserSkillFiles,
} from "./skill-store.js";

export const SKILL_TOOL_NAMES = new Set([
  "skill_read",
  "skill_search",
  "skill_create",
  "skill_update",
  "skill_delete",
]);

/** Match CreateAgentSkillInput / UpdateAgentSkillInput / parseSkillMd bounds. */
const MAX_SKILL_CONTENT_CHARS = 100_000;
const MAX_SKILL_NAME_CHARS = 80;
/** The one disk cap on what bots write: the owner's skills, all together. */
const BOT_SKILLS_MAX_BYTES = 200 * 1024 * 1024;

type SkillOwner = {
  spaceId: string;
  /** Whose skills: the bot's owner, also in the run of someone the bot is shared with. */
  userId: string;
  /** When set, list/read/update/delete only see skills visible to this bot. */
  botId?: string;
};

export type SkillToolDeps = {
  prisma: PrismaClient;
  dataDir: string;
  /** Off: a created skill's result still asks the bot to mention /Name. */
  learning: SkillLearningMode;
  /** Serializes every write to one owner's skills with the API's and other runs'. */
  lock: SkillOwnerLock;
};

async function managedRecords(): Promise<Array<SkillRecord & { id: string }>> {
  return (await loadManagedSkills()).map((skill) => ({
    id: `builtin:${skill.name}`,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    source: "builtin" as const,
    readOnly: true,
  }));
}

/** The skill's folder inside the computer, derived from its id the way the mounts lay it out. */
export function sandboxSkillDir(skill: { id: string; name: string }): string {
  if (skill.id.startsWith("builtin:")) {
    return `${SANDBOX_SKILL_MOUNTS.managed}/agent/${skillDirName(skill.name)}`;
  }
  return `${SANDBOX_SKILL_MOUNTS.user}/${skillDirName(skill.name)}`;
}

export function userSkillsOpenedIn<T extends { id: string; name: string; source: string }>(
  text: string,
  skills: readonly T[],
): T[] {
  return skills.filter(
    (skill) => skill.source === "user" && text.includes(`${sandboxSkillDir(skill)}/`),
  );
}

function readOnlyError(skill: { source: string; readOnly: boolean }): string | undefined {
  if (skill.readOnly || skill.source !== "user") return "Managed skills are read-only.";
  return undefined;
}

function rejectOversizedContent(content: string): string | undefined {
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return `Skill content must be at most ${MAX_SKILL_CONTENT_CHARS} characters.`;
  }
  return undefined;
}

/** A skill a bot writes stays readable as written (validateBotSkill); the user's own are free. */
function botSkillError(
  owner: SkillOwner,
  content: string,
  prior?: Pick<ParsedSkillMd, "name" | "description" | "frontmatter">,
): string | undefined {
  if (!owner.botId) return undefined;
  const parsed = parseSkillMd(content);
  return "error" in parsed ? parsed.error : validateBotSkill(parsed, content, prior);
}

function rejectInvalidSkillFields(name: string, description: string): string | undefined {
  if (!name) return "Skill name is required.";
  if (!description) return "Skill description is required.";
  if (name.length > MAX_SKILL_NAME_CHARS) {
    return `Skill name must be at most ${MAX_SKILL_NAME_CHARS} characters.`;
  }
  if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
    return `Skill description must be at most ${SKILL_DESCRIPTION_MAX_CHARS} characters.`;
  }
  return undefined;
}

export async function listAgentSkillRecords(
  deps: Pick<SkillToolDeps, "prisma" | "dataDir">,
  owner: SkillOwner,
): Promise<Array<SkillRecord & { id: string }>> {
  const [managed, userSkills] = await Promise.all([
    managedRecords(),
    listUserSkills(userSkillsRoot(deps.dataDir, owner)),
  ]);
  // Managed skills win name collisions and ignore legacy visibility settings.
  const records = mergeManagedSkills(managed, userSkills);
  return owner.botId ? await onlyVisibleTo(deps.prisma, owner, owner.botId, records) : records;
}

async function onlyVisibleTo<T extends { id: string }>(
  prisma: PrismaClient,
  owner: SkillOwner,
  botId: string,
  records: T[],
): Promise<T[]> {
  const [settings, overrides, bot] = await Promise.all([
    prisma.skillSetting.findMany({ where: { spaceId: owner.spaceId, userId: owner.userId } }),
    prisma.botSkill.findMany({ where: { botId, spaceId: owner.spaceId, userId: owner.userId } }),
    prisma.bot.findFirst({ where: { id: botId }, select: { visibility: true } }),
  ]);
  const availability = new Map(
    settings.map((s) => [s.skillKey, asSkillAvailability(s.availability)]),
  );
  const override = new Map(overrides.map((o) => [o.skillKey, o.enabled]));
  return records.filter(
    (record) =>
      record.id.startsWith("builtin:") ||
      isSkillVisible({
        availability: availability.get(record.id) ?? "all",
        override: override.get(record.id),
        sharedBot: bot !== null && bot.visibility !== "private",
      }),
  );
}

/**
 * Refreshes a shared bot's copy of its owner's skills that are on for it, which its computer
 * mounts in place of anyone's library: the same files whoever runs the bot. Each skill is copied
 * beside the copy, then renamed in, so the mounted folder itself never changes.
 */
export async function copySharedSkills(
  deps: Pick<SkillToolDeps, "prisma" | "dataDir">,
  bot: { id: string; spaceId: string; userId: string },
): Promise<void> {
  const owner = { spaceId: bot.spaceId, userId: bot.userId, botId: bot.id };
  const names = (await listAgentSkillRecords(deps, owner))
    .filter((record) => record.source === "user")
    .map((record) => skillDirName(record.name));
  const from = userSkillsRoot(deps.dataDir, owner);
  const to = botSkillsRoot(deps.dataDir, bot);
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(to)) {
    if (!names.includes(entry)) await rm(path.join(to, entry), { recursive: true, force: true });
  }
  const staging = await mkdtemp(`${to}.copy-`);
  try {
    for (const name of names) {
      // Plain files and folders only, as the store reads them: a link is never followed.
      const copied = await cp(path.join(from, name), path.join(staging, name), {
        recursive: true,
        filter: async (source) => {
          const info = await lstat(source);
          return info.isDirectory() || isStorableFile(info, { hardLinks: true });
        },
      }).then(
        () => true,
        (error: unknown) => {
          // A skill whose folder is not named after it (renamed from a shell) is listed but has
          // no folder here; it is left out rather than keep the bot's computer from starting.
          if (!hasCode(error, "ENOENT")) throw error;
          getLogger().warn("[skills] shared bot skill left out: its folder has another name", {
            botId: bot.id,
            folder: name,
          });
          return false;
        },
      );
      if (!copied) continue;
      await rm(path.join(to, name), { recursive: true, force: true });
      await rename(path.join(staging, name), path.join(to, name));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
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
    dir: sandboxSkillDir(skill),
  };
}

export async function skillSearchFromTool(
  deps: SkillToolDeps,
  owner: SkillOwner,
  input: { query?: string },
): Promise<Record<string, unknown>> {
  const query = input.query?.trim() ?? "";
  if (!query) return { error: "query is required." };
  const hits = searchSkills(await listAgentSkillRecords(deps, owner), query);
  return { skills: hits.map(({ name, description }) => ({ name, description })) };
}

/**
 * Pulls a skill folder the bot drafted in its workspace through the sandbox port. The whole tree
 * is listed and checked against the caps before any file is read.
 */
export async function readSkillDraft(
  sandbox: Pick<SandboxProvider, "listFiles" | "readFile">,
  computer: ComputerRef,
  dir: string,
  context: AdapterContext,
): Promise<SkillTreeFile[] | { error: string }> {
  const found: Array<{ source: string; path: string; executable: boolean }> = [];
  let entries = 0;
  let bytes = 0;
  const tooBig = () =>
    entries > SKILL_BUNDLE_MAX_ENTRIES
      ? `Skill folder has too many entries (> ${SKILL_BUNDLE_MAX_ENTRIES}).`
      : bytes > SKILL_BUNDLE_MAX_BYTES
        ? `Skill folder too large (> ${SKILL_BUNDLE_MAX_BYTES} bytes).`
        : undefined;
  // Relative paths are rebuilt from entry names: providers list workspace-relative paths, but
  // the draft dir may be spelled differently (leading slash, team bot prefix).
  const walk = async (source: string, relative: string): Promise<string | undefined> => {
    for (const entry of await sandbox.listFiles(computer, source, context)) {
      const name = entry.path.split("/").pop() ?? "";
      const child = relative ? `${relative}/${name}` : name;
      entries += 1;
      if (entry.kind === "file") {
        bytes += entry.size;
        found.push({ source: entry.path, path: child, executable: entry.executable === true });
      }
      const failure =
        tooBig() ?? (entry.kind === "dir" ? await walk(entry.path, child) : undefined);
      if (failure) return failure;
    }
    return undefined;
  };
  let failure: string | undefined;
  try {
    failure = await walk(dir, "");
  } catch {
    return { error: "Could not read the skill folder." };
  }
  if (failure) return { error: failure };
  if (!found.some((file) => file.path === "SKILL.md")) {
    return { error: "No SKILL.md at the root of the skill folder." };
  }
  const files: SkillTreeFile[] = [];
  for (const file of found) {
    try {
      const content = await sandbox.readFile(computer, file.source, context, {
        maxBytes: SKILL_BUNDLE_MAX_BYTES,
      });
      files.push({ path: file.path, bytes: content, executable: file.executable });
    } catch {
      return { error: `Could not read ${file.path} from the skill folder.` };
    }
  }
  return files;
}

function parseDraftSkillMd(files: SkillTreeFile[]): ReturnType<typeof parseSkillMd> {
  const skillMd = files.find((file) => file.path === "SKILL.md");
  if (!skillMd) return { error: "No SKILL.md at the root of the skill folder." };
  return parseSkillMd(new TextDecoder().decode(skillMd.bytes));
}

async function diskBytes(target: string): Promise<number> {
  const info = await lstat(target).catch(() => null);
  if (!info?.isDirectory()) return info?.isFile() ? info.size : 0;
  const sizes = await Promise.all(
    (await readdir(target)).map((name) => diskBytes(path.join(target, name))),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

/** Whether `dir` already holds `file` as a plain file with these bytes. */
async function onDisk(dir: string, file: SkillTreeFile): Promise<boolean> {
  const target = path.resolve(dir, file.path);
  if (!target.startsWith(dir + path.sep)) return false;
  const info = await lstat(target).catch(() => null);
  if (!info || !isStorableFile(info)) return false;
  return Buffer.compare(await readFile(target), Buffer.from(file.bytes)) === 0;
}

/**
 * What a bot answers for beyond SKILL.md's own rules: every file it changes is readable text
 * holding no secret of the run, and the owner's skills stay under one disk cap. `written` is
 * the whole folder when `replacesFolder`, else SKILL.md alone.
 */
async function botFilesError(
  root: string,
  name: string,
  written: SkillTreeFile[],
  replacesFolder: boolean,
  secrets: string[],
): Promise<string | undefined> {
  const dir = path.join(root, skillDirName(name));
  const changed: SkillTreeFile[] = [];
  for (const file of written) if (!(await onDisk(dir, file))) changed.push(file);
  for (const file of changed) {
    const error = validateBotSkillFile(file);
    if (error) return error;
  }
  const decoder = new TextDecoder();
  if (
    containsSecret(
      changed.flatMap((file) => [file.path, decoder.decode(file.bytes)]),
      secrets,
    )
  ) {
    return "Skill files must not contain a secret from this run.";
  }
  const replaced = await diskBytes(replacesFolder ? dir : path.join(dir, "SKILL.md"));
  const bytes = written.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if ((await diskBytes(root)) - replaced + bytes > BOT_SKILLS_MAX_BYTES) {
    return "The user's skills are full. They can free space by deleting skills they no longer use.";
  }
  return undefined;
}

/** A filesystem or database failure answers `message`; its detail, host paths included, is logged. */
function failed(message: string, error: unknown): { error: string } {
  getLogger().warn(`[skills] ${message} ${error instanceof Error ? error.message : error}`);
  return { error: message };
}

/**
 * Runs one write to the owner's skills under the owner's lock, so no other write (another run's,
 * the API's) changes the folder or the access rows between its checks and its last step. A lock
 * not taken, or any failure the write did not answer itself, answers `message`.
 */
function underOwnerLock(
  deps: SkillToolDeps,
  owner: SkillOwner,
  message: string,
  write: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  return deps.lock.run(owner, write).catch((error: unknown) => failed(message, error));
}

/** The folder a write leaves: the draft with its SKILL.md normalized, or SKILL.md alone. */
function writtenFiles(content: string, files?: SkillTreeFile[]): SkillTreeFile[] {
  const skillMd = { path: "SKILL.md", bytes: new TextEncoder().encode(content), executable: false };
  return [...(files ?? []).filter((file) => file.path !== "SKILL.md"), skillMd];
}

/** With learning on, the app shows the line under the bot's message, so the bot says nothing. */
function createdSkillHint(name: string, forBot: boolean, learning: SkillLearningMode): string {
  if (learning !== "off") {
    return forBot
      ? "Created skill, available to this agent until the user shares it. The app shows the user a line for it: do not announce it."
      : "Created skill. The app shows the user a line for it: do not announce it.";
  }
  return forBot
    ? `Created skill, available to this agent. Mention /${name} so the user can open it; they can share it with other agents from its settings.`
    : `Created skill. Mention /${name} so the user can open it.`;
}

/** A bot's draft refused by the store, with a message safe to show the bot. */
class DraftRefused extends Error {}

export function skillCreateFromTool(...args: Parameters<typeof createSkill>) {
  return underOwnerLock(args[0], args[1], "Could not create skill.", () => createSkill(...args));
}

async function createSkill(
  deps: SkillToolDeps,
  owner: SkillOwner,
  /** The run's secret values: a bot write holding one is refused. */
  secrets: string[],
  input: {
    name?: string;
    description?: string;
    body?: string;
    content?: string;
    files?: SkillTreeFile[];
  },
): Promise<Record<string, unknown>> {
  let name = "";
  let description = "";
  let content = "";
  if (input.files) {
    if (input.content || input.name || input.description || input.body) {
      return { error: "Pass either path or name/description/body/content, not both." };
    }
    const parsed = parseDraftSkillMd(input.files);
    if ("error" in parsed) return { error: parsed.error };
    name = parsed.name;
    description = parsed.description;
    content = buildSkillMd(parsed);
  } else if (input.content?.trim()) {
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

  const rejected = rejectOversizedContent(content) ?? botSkillError(owner, content);
  if (rejected) return { error: rejected };

  const existing = await findOwnedSkill(deps, owner, { name });
  if (existing) return { error: `A skill named "${existing.name}" already exists.` };

  const root = userSkillsRoot(deps.dataDir, owner);
  const taken = { error: `A skill named "${name}" already exists.` };
  if (owner.botId) {
    const refused = await botFilesError(
      root,
      name,
      writtenFiles(content, input.files),
      Boolean(input.files),
      secrets,
    );
    if (refused) return { error: refused };
  }
  const skillKey = userSkillKey(name);
  const dir = path.join(root, skillDirName(name));
  const scope = { spaceId: owner.spaceId, userId: owner.userId };
  if (owner.botId) {
    // The empty folder claims the name, even one hidden from this bot, before the rows narrow it.
    try {
      await mkdir(root, { recursive: true });
      await mkdir(dir);
    } catch (error) {
      if (isExists(error)) return taken;
      throw error;
    }
  }
  try {
    if (owner.botId) {
      // A bot-created skill starts scoped to its creator (design Q2); the user widens it in the UI.
      // The rows land before SKILL.md, so no other bot ever sees it, even one whose row a
      // deleted skill of that name left behind.
      await deps.prisma.$transaction([
        deps.prisma.skillSetting.upsert({
          where: { spaceId_userId_skillKey: { ...scope, skillKey } },
          create: { ...scope, skillKey, availability: "selected" },
          update: { availability: "selected" },
        }),
        deps.prisma.botSkill.deleteMany({ where: { ...scope, skillKey } }),
        deps.prisma.botSkill.upsert({
          where: { botId_skillKey: { botId: owner.botId, skillKey } },
          create: { ...scope, botId: owner.botId, skillKey, enabled: true },
          update: { enabled: true },
        }),
      ]);
    }
    if (input.files) {
      await writeUserSkillFiles(root, input.files, async () => ({ name, content })).catch(
        (error: unknown) => {
          // Its codeless errors name the offending draft file and carry no host path.
          throw error instanceof Error && !("code" in error)
            ? new DraftRefused(error.message)
            : error;
        },
      );
    } else {
      await writeUserSkill(root, { name, content }, "create");
    }
  } catch (error) {
    // The owner's lock keeps every other write out, so the claim holds only this create's files
    // and the rows are its own, narrowed to this bot. They go once the claim is gone.
    if (owner.botId) {
      const freed = await rmdir(dir).then(
        () => true,
        (failure: unknown) => hasCode(failure, "ENOENT"),
      );
      if (freed) {
        await deps.prisma.$transaction([
          deps.prisma.skillSetting.deleteMany({ where: { ...scope, skillKey } }),
          deps.prisma.botSkill.deleteMany({ where: { ...scope, skillKey } }),
        ]);
      }
    }
    if (isExists(error)) return taken;
    if (error instanceof DraftRefused) return { error: error.message };
    throw error;
  }
  return {
    ok: true,
    id: skillKey,
    name,
    description,
    hint: createdSkillHint(name, Boolean(owner.botId), deps.learning),
  };
}

export function skillUpdateFromTool(...args: Parameters<typeof updateSkill>) {
  return underOwnerLock(args[0], args[1], "Could not update skill.", () => updateSkill(...args));
}

async function updateSkill(
  deps: SkillToolDeps,
  owner: SkillOwner,
  /** The run's secret values: a bot write holding one is refused. */
  secrets: string[],
  input: {
    name?: string;
    skillId?: string;
    newName?: string;
    description?: string;
    body?: string;
    content?: string;
    files?: SkillTreeFile[];
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

  if (input.files) {
    if (input.content || input.newName || input.description || input.body) {
      return { error: "Pass either path or newName/description/body/content, not both." };
    }
    const parsed = parseDraftSkillMd(input.files);
    if ("error" in parsed) return { error: parsed.error };
    nextName = parsed.name;
    nextDescription = parsed.description;
    nextContent = buildSkillMd(parsed);
  } else if (input.content?.trim()) {
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
  // A new name changes how every bot finds the skill: only the user renames it, from its settings.
  if (owner.botId && nextName !== existing.name) {
    return { error: `Keep the skill's name "${existing.name}"; the user can rename it.` };
  }
  const stored = parseSkillMd(existing.content);
  const rejected =
    rejectOversizedContent(nextContent) ??
    botSkillError(owner, nextContent, "error" in stored ? undefined : stored);
  if (rejected) return { error: rejected };

  if (nextName.toLowerCase() !== existing.name.toLowerCase()) {
    const clash = await findOwnedSkill(deps, owner, { name: nextName });
    if (clash && clash.id !== existing.id) {
      return { error: `A skill named "${clash.name}" already exists.` };
    }
  }

  const root = userSkillsRoot(deps.dataDir, owner);
  if (owner.botId) {
    const refused = await botFilesError(
      root,
      existing.name,
      writtenFiles(nextContent, input.files),
      Boolean(input.files),
      secrets,
    );
    if (refused) return { error: refused };
  }
  const scope = { spaceId: owner.spaceId, userId: owner.userId };
  const oldKey = userSkillKey(existing.name);
  const newKey = userSkillKey(nextName);
  const skill = { name: nextName, content: nextContent };
  try {
    if (input.files) {
      await replaceUserSkillFiles(root, existing.name, input.files, async () => skill);
    } else if (oldKey === newKey) {
      await writeUserSkill(root, skill, "replace");
    } else {
      // The whole directory moves, so bundle extras follow the new name.
      await renameUserSkill(root, existing.name, skill);
    }
    // Access rows follow the key once the folder has moved.
    if (oldKey !== newKey) {
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
    if (isExists(error)) return { error: `A skill named "${nextName}" already exists.` };
    // replaceUserSkillFiles messages name the offending draft file and carry no host path.
    if (input.files && error instanceof Error && !("code" in error)) {
      return { error: error.message };
    }
    throw error;
  }
  return { ok: true, id: newKey, name: nextName, description: nextDescription };
}

export function skillDeleteFromTool(
  deps: SkillToolDeps,
  owner: SkillOwner,
  input: { name?: string; skillId?: string },
): Promise<Record<string, unknown>> {
  return underOwnerLock(deps, owner, "Could not delete skill.", async () => {
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
  });
}
