import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import {
  SKILL_BUNDLE_MAX_BYTES,
  SKILL_BUNDLE_MAX_ENTRIES,
  SKILL_DESCRIPTION_MAX_CHARS,
} from "@rakazo/contracts";
import type { SkillFolderFile, SkillSaveRequest } from "@rakazo/core";
import {
  asSkillAvailability,
  buildSkillMd,
  defaultSkillAvailability,
  findSkillByName,
  hasHiddenText,
  isMarketplaceSkillKey,
  isSkillVisible,
  mergeBuiltinSkills,
  parseSkillMd,
  SANDBOX_SKILL_MOUNTS,
  type SkillRecord,
  searchSkills,
  userSkillKey,
  validateBotSkill,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { loadBuiltinSkills } from "./builtin-skills.js";
import { listMarketplaceSkills, marketplacesRoot } from "./marketplace-store.js";
import type { SkillTreeFile } from "./skill-store.js";
import {
  isExists,
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

type SkillOwner = {
  spaceId: string;
  userId: string;
  /** When set, list/read/update/delete only see skills visible to this bot. */
  botId?: string;
};

export type SkillToolDeps = { prisma: PrismaClient; dataDir: string };

async function builtinRecords(): Promise<Array<SkillRecord & { id: string }>> {
  return (await loadBuiltinSkills()).map((skill) => ({
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
  if (isMarketplaceSkillKey(skill.id)) {
    const [marketplace, plugin, slug] = skill.id.slice("mkt:".length).split("/");
    if (!marketplace || !plugin || !slug) throw new Error(`Malformed skill id ${skill.id}`);
    return `${SANDBOX_SKILL_MOUNTS.marketplaces}/${marketplace}/plugins/${plugin}/skills/${slug}`;
  }
  if (skill.id.startsWith("builtin:")) {
    return `${SANDBOX_SKILL_MOUNTS.managed}/agent/${skillDirName(skill.name)}`;
  }
  return `${SANDBOX_SKILL_MOUNTS.user}/${skillDirName(skill.name)}`;
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
  if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
    return `Skill description must be at most ${SKILL_DESCRIPTION_MAX_CHARS} characters.`;
  }
  return undefined;
}

export async function listAgentSkillRecords(
  deps: SkillToolDeps,
  owner: SkillOwner,
): Promise<Array<SkillRecord & { id: string }>> {
  const [builtins, userSkills, marketplaceSkills] = await Promise.all([
    builtinRecords(),
    listUserSkills(userSkillsRoot(deps.dataDir, owner)),
    listMarketplaceSkills(marketplacesRoot(deps.dataDir, owner.spaceId)),
  ]);
  // Builtins join the catalog before filtering: a user skill shadows a same-named builtin,
  // and per-bot availability applies to builtins too.
  const records = mergeBuiltinSkills(builtins, [...userSkills, ...marketplaceSkills]);
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
  // Source first: a replayed, truncated output still tells whose skill it was (historyExposes).
  return {
    source: skill.source,
    name: skill.name,
    description: skill.description,
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

const unixNewlines = (value: string) => value.replace(/\r\n?/g, "\n");

function parseDraftSkillMd(files: SkillTreeFile[]): ReturnType<typeof parseSkillMd> {
  const skillMd = files.find((file) => file.path === "SKILL.md");
  if (!skillMd) return { error: "No SKILL.md at the root of the skill folder." };
  return parseSkillMd(unixNewlines(new TextDecoder().decode(skillMd.bytes)));
}

/** Keeps a draft file as text when it is UTF-8, so the card can show it in full. */
function snapshotFile(file: SkillTreeFile): SkillFolderFile {
  const kept = { path: file.path, executable: file.executable };
  const text = utf8Text(file.bytes);
  return text === undefined || text.includes("\0")
    ? { ...kept, base64: Buffer.from(file.bytes).toString("base64") }
    : { ...kept, text };
}

function utf8Text(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function treeFile(file: SkillFolderFile): SkillTreeFile {
  const bytes =
    "text" in file ? new TextEncoder().encode(file.text) : Buffer.from(file.base64, "base64");
  return { path: file.path, bytes: new Uint8Array(bytes), executable: file.executable };
}

/** The folder's other files, or the error for a file name that could forge a card line. */
function folderFiles(files: SkillTreeFile[]): SkillFolderFile[] | { error: string } {
  const unreadable = files.find((file) => hasHiddenText(file.path));
  if (unreadable) {
    return { error: `Skill file name ${JSON.stringify(unreadable.path)} must be visible text.` };
  }
  return files.filter((file) => file.path !== "SKILL.md").map(snapshotFile);
}

const BOTH_CREATE_INPUTS = "Pass either path or name/description/body/content, not both.";
const BOTH_UPDATE_INPUTS = "Pass either path or newName/description/body/content, not both.";
const SHARED_SKILL_ERROR = "Ask the user before changing a shared skill.";

/** A bot changes or deletes a skill only if it wrote it and no other bot can see it. */
async function botOwnsPrivateSkill(
  prisma: PrismaClient,
  owner: SkillOwner & { botId: string },
  skillKey: string,
): Promise<boolean> {
  const scope = { spaceId: owner.spaceId, userId: owner.userId, skillKey };
  const [setting, access] = await Promise.all([
    prisma.skillSetting.findUnique({ where: { spaceId_userId_skillKey: scope } }),
    prisma.botSkill.findMany({ where: { ...scope, enabled: true } }),
  ]);
  return (
    setting?.createdByBotId === owner.botId &&
    setting.availability === "selected" &&
    access.length === 1 &&
    access[0]?.botId === owner.botId
  );
}

function botSkillError(owner: SkillOwner, content: string): string | undefined {
  if (!owner.botId) return undefined;
  const parsed = parseSkillMd(content);
  return "error" in parsed ? parsed.error : validateBotSkill(parsed, content);
}

type SkillSaveInput = {
  name?: string;
  skillId?: string;
  newName?: string;
  description?: string;
  body?: string;
  content?: string;
  /** A folder drafted in the bot's workspace, read by readSkillDraft. */
  files?: SkillTreeFile[];
};

/** The SKILL.md rules a saved request must meet, checked again when an approval writes it. */
function validSkillSave(
  owner: SkillOwner,
  request: SkillSaveRequest,
): SkillSaveRequest | { error: string } {
  const invalid = rejectOversizedContent(request.content) ?? botSkillError(owner, request.content);
  return invalid ? { error: invalid } : request;
}

/**
 * The exact skill a skill_create or skill_update call would write, valid on its own, or the tool
 * error. A card shows this request and an approved one is written as is, folder files included.
 * Whether it still fits the stored skills is checkSkillSave's, so a call retried after its save
 * completed can find that save's effect first.
 */
export async function shapeSkillSave(
  deps: SkillToolDeps,
  owner: SkillOwner,
  tool: "skill_create" | "skill_update",
  input: SkillSaveInput,
): Promise<SkillSaveRequest | { error: string }> {
  const content = input.content === undefined ? undefined : unixNewlines(input.content);
  const body = input.body === undefined ? undefined : unixNewlines(input.body);
  const shaped =
    tool === "skill_create"
      ? shapeCreate({ ...input, content, body })
      : await shapeUpdate(deps, owner, { ...input, content, body });
  return "error" in shaped ? shaped : validSkillSave(owner, shaped);
}

/** The tool error when a shaped save no longer fits the stored skills, or undefined. */
export async function checkSkillSave(
  deps: SkillToolDeps,
  owner: SkillOwner,
  request: SkillSaveRequest,
): Promise<string | undefined> {
  const next = parseSkillMd(request.content);
  if ("error" in next) return next.error;
  if (request.change === "created") {
    const existing = await findOwnedSkill(deps, owner, { name: next.name });
    return existing ? `A skill named "${existing.name}" already exists.` : undefined;
  }
  const existing = await findOwnedSkill(deps, owner, { name: request.name });
  if (!existing) return "Skill not found.";
  const readOnly = readOnlyError(existing);
  if (readOnly) return readOnly;
  if (
    owner.botId &&
    !(await botOwnsPrivateSkill(
      deps.prisma,
      { ...owner, botId: owner.botId },
      userSkillKey(existing.name),
    ))
  ) {
    return SHARED_SKILL_ERROR;
  }
  if (next.name.toLowerCase() !== existing.name.toLowerCase()) {
    const clash = await findOwnedSkill(deps, owner, { name: next.name });
    if (clash && clash.id !== existing.id) return `A skill named "${clash.name}" already exists.`;
  }
  return undefined;
}

function shapeCreate(input: SkillSaveInput): SkillSaveRequest | { error: string } {
  if (input.files) {
    if (input.content || input.name || input.description || input.body) {
      return { error: BOTH_CREATE_INPUTS };
    }
    const parsed = parseDraftSkillMd(input.files);
    if ("error" in parsed) return { error: parsed.error };
    const invalid = rejectInvalidSkillFields(parsed.name, parsed.description);
    if (invalid) return { error: invalid };
    const files = folderFiles(input.files);
    if ("error" in files) return files;
    return { change: "created", name: parsed.name, content: buildSkillMd(parsed), files };
  }
  if (input.content?.trim()) {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) return { error: parsed.error };
    return { change: "created", name: parsed.name, content: buildSkillMd(parsed) };
  }
  const name = String(input.name ?? "").trim();
  const description = String(input.description ?? "").trim();
  const body = String(input.body ?? "").trim();
  if (!name || !description) {
    return {
      error: "Provide name and description (and optional body), or full SKILL.md content.",
    };
  }
  const invalid = rejectInvalidSkillFields(name, description);
  if (invalid) return { error: invalid };
  return { change: "created", name, content: buildSkillMd({ name, description, body }) };
}

async function shapeUpdate(
  deps: SkillToolDeps,
  owner: SkillOwner,
  input: SkillSaveInput,
): Promise<SkillSaveRequest | { error: string }> {
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
  let files: SkillFolderFile[] | undefined;

  if (input.files) {
    if (input.content || input.newName || input.description || input.body) {
      return { error: BOTH_UPDATE_INPUTS };
    }
    const parsed = parseDraftSkillMd(input.files);
    if ("error" in parsed) return { error: parsed.error };
    nextName = parsed.name;
    nextDescription = parsed.description;
    nextContent = buildSkillMd(parsed);
    const kept = folderFiles(input.files);
    if ("error" in kept) return kept;
    files = kept;
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
  return {
    change: "updated",
    name: existing.name,
    content: nextContent,
    ...(files ? { files } : {}),
  };
}

async function planSkillSave(
  deps: SkillToolDeps,
  owner: SkillOwner,
  tool: "skill_create" | "skill_update",
  input: SkillSaveInput,
): Promise<SkillSaveRequest | { error: string }> {
  const shaped = await shapeSkillSave(deps, owner, tool, input);
  if ("error" in shaped) return shaped;
  const error = await checkSkillSave(deps, owner, shaped);
  return error ? { error } : shaped;
}

/** Writes a request a card showed, checking it again so a card answered later meets every rule. */
export async function saveSkillFromTool(
  deps: SkillToolDeps,
  owner: SkillOwner,
  request: SkillSaveRequest,
): Promise<Record<string, unknown>> {
  const valid = validSkillSave(owner, request);
  if ("error" in valid) return valid;
  const error = await checkSkillSave(deps, owner, valid);
  return error ? { error } : writeSkillSave(deps, owner, valid);
}

export async function skillCreateFromTool(
  deps: SkillToolDeps,
  owner: SkillOwner,
  input: Omit<SkillSaveInput, "skillId" | "newName">,
): Promise<Record<string, unknown>> {
  const planned = await planSkillSave(deps, owner, "skill_create", input);
  return "error" in planned ? planned : writeSkillSave(deps, owner, planned);
}

export async function skillUpdateFromTool(
  deps: SkillToolDeps,
  owner: SkillOwner,
  input: SkillSaveInput,
): Promise<Record<string, unknown>> {
  const planned = await planSkillSave(deps, owner, "skill_update", input);
  return "error" in planned ? planned : writeSkillSave(deps, owner, planned);
}

function saveError(error: unknown, folder: boolean, name: string, fallback: string): string {
  if (isExists(error)) return `A skill named "${name}" already exists.`;
  // Folder import messages name the offending draft file and carry no host path.
  if (folder && error instanceof Error && !("code" in error)) return error.message;
  return fallback;
}

async function writeSkillSave(
  deps: SkillToolDeps,
  owner: SkillOwner,
  request: SkillSaveRequest,
): Promise<Record<string, unknown>> {
  const next = parseSkillMd(request.content);
  if ("error" in next) return next;
  const skill = { name: next.name, content: request.content };
  const tree = request.files && [
    { path: "SKILL.md", bytes: new TextEncoder().encode(request.content), executable: false },
    ...request.files.map(treeFile),
  ];
  const root = userSkillsRoot(deps.dataDir, owner);
  const scope = { spaceId: owner.spaceId, userId: owner.userId };
  const newKey = userSkillKey(skill.name);

  if (request.change === "created") {
    try {
      if (tree) await writeUserSkillFiles(root, tree, async () => skill);
      else await writeUserSkill(root, skill, "create");
    } catch (error) {
      return { error: saveError(error, Boolean(tree), skill.name, "Could not create skill.") };
    }
    if (owner.botId) {
      // A bot-created skill starts scoped to its creator (design Q2); the user widens it in the UI.
      // API/panel creation (no botId) stays "all agents": no access rows.
      const createdByBotId = owner.botId;
      await deps.prisma.$transaction([
        deps.prisma.skillSetting.upsert({
          where: { spaceId_userId_skillKey: { ...scope, skillKey: newKey } },
          create: { ...scope, skillKey: newKey, availability: "selected", createdByBotId },
          update: { availability: "selected", createdByBotId },
        }),
        deps.prisma.botSkill.upsert({
          where: { botId_skillKey: { botId: owner.botId, skillKey: newKey } },
          create: { ...scope, botId: owner.botId, skillKey: newKey, enabled: true },
          update: { enabled: true },
        }),
      ]);
    }
    return {
      ok: true,
      id: newKey,
      name: skill.name,
      description: next.description,
      hint: owner.botId
        ? `Created skill, available to this agent. Mention /${skill.name} so the user can open it; they can share it with other agents from its settings.`
        : `Created skill. Mention /${skill.name} so the user can open it.`,
    };
  }

  const oldKey = userSkillKey(request.name);
  try {
    if (tree) {
      await replaceUserSkillFiles(root, request.name, tree, async () => skill);
    } else if (oldKey === newKey) {
      await writeUserSkill(root, skill, "replace");
    } else {
      // The whole directory moves, so bundle extras follow the new name.
      await renameUserSkill(root, request.name, skill);
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
    return { error: saveError(error, Boolean(tree), skill.name, "Could not update skill.") };
  }
  return { ok: true, id: newKey, name: skill.name, description: next.description };
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
  if (
    owner.botId &&
    !(await botOwnsPrivateSkill(deps.prisma, { ...owner, botId: owner.botId }, skillKey))
  ) {
    return { error: SHARED_SKILL_ERROR };
  }
  // File first, rows second: orphan rows are harmless, a row-less file would widen to "all".
  await removeUserSkill(userSkillsRoot(deps.dataDir, owner), existing.name);
  await deps.prisma.$transaction([
    deps.prisma.skillSetting.deleteMany({ where: { ...scope, skillKey } }),
    deps.prisma.botSkill.deleteMany({ where: { ...scope, skillKey } }),
  ]);
  return { ok: true, name: existing.name };
}
