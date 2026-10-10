/**
 * The only way to change a user skill. Every write keeps a full copy of the folder as a version,
 * a delete moves the skill to a trash, and both live under DATA_DIR/skill-history, outside the
 * folder mounted into the bot's computer. Changes to one owner's skills are serialized across
 * processes by a SkillOwnerLock.
 *
 * Each operation prepares (claims the folder, writes access rows), commits with one atomic file
 * write, then converges the live folder to the committed state. Its intent is journaled first, so
 * a crash at any step is finished or undone the next time the owner's lock is taken. An operation
 * reads only the skill it touches; the startup and periodic sweep checks every skill.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { SKILL_UID_PATTERN, SKILL_VERSION_ID_PATTERN } from "@rakazo/contracts";
import type { SkillAvailability } from "@rakazo/core";
import {
  asSkillAvailability,
  containsSecret,
  parseSkillMd,
  SKILL_HISTORY_DIR,
  skillHistorySegments,
  userSkillKey,
  validateBotSkillFile,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { SkillOwner, SkillOwnerLock } from "./skill-lock.js";
import type { SkillTreeFile } from "./skill-store.js";
import { extractSkillBundle, hasCode, skillDirName, userSkillsRoot } from "./skill-store.js";
import {
  captureTree,
  fingerprint,
  materialize,
  normalizeTree,
  readdirOrEmpty,
  readHistoryJson,
  SkillRefusal,
  treeBytes,
  unavailable,
  withSkillMd,
  writeDurable,
  writeJsonAtomic,
} from "./skill-tree.js";

export type { SkillRefusalReason } from "./skill-tree.js";
export { SkillRefusal } from "./skill-tree.js";

const KEPT_VERSIONS = 20;
const HISTORY_QUOTA_BYTES = 200 * 1024 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

export type SkillUid = string & { readonly __brand: "SkillUid" };
export type VersionId = string & { readonly __brand: "VersionId" };

export function parseSkillUid(value: string): SkillUid | undefined {
  return SKILL_UID_PATTERN.test(value) ? (value as SkillUid) : undefined;
}

export function parseVersionId(value: string): VersionId | undefined {
  return SKILL_VERSION_ID_PATTERN.test(value) ? (value as VersionId) : undefined;
}

export type SkillAuthor =
  | {
      kind: "bot";
      botId: string;
      botName: string;
      runId: string;
      /** Effect-journal keys of the tool calls folded into this version (one exchange). */
      toolCallIds: string[];
    }
  | { kind: "user" }
  | { kind: "unknown" };

export type VersionNature = "created" | "modified" | "unknown";

/** The access rows of one skill: its SkillSetting availability (null = no row) and BotSkill rows. */
export type SkillAccess = {
  availability: SkillAvailability | null;
  bots: Array<{ botId: string; enabled: boolean }>;
};

export type VersionManifest = {
  versionId: VersionId;
  uid: SkillUid;
  seq: number;
  name: string;
  author: SkillAuthor;
  nature: VersionNature;
  access: SkillAccess;
  files: Array<{ path: string; size: number; executable: boolean }>;
  bytes: number;
  fingerprint: string;
  createdAt: string;
  undoneAt?: string;
};

/** Read from the versions and kept in skill.json, so an operation need not open every skill. */
type SkillSummary = { name: string; bytes: number; botRuns: string[] };

type SkillEntry = {
  uid: SkillUid;
  state:
    | { kind: "live" }
    /** `byRun`: the bot run that deleted it, for that run's line. */
    | { kind: "trashed"; trashedAt: string; access: SkillAccess; byRun?: string };
  /** The version current when a bot first changed this skill: retention never purges it. */
  beforeFirstBot?: VersionId;
  summary?: SkillSummary;
};

/** A journaled operation: the folder it ends at and the state it commits. */
type Intent = {
  uid: SkillUid;
  key: string;
  /** The folder the skill leaves, for a rename or the undo of one. */
  fromKey?: string;
  /** This operation created the `key` folder and wrote its access rows before committing. */
  claimed: boolean;
  target: { kind: "live"; versionId: VersionId } | { kind: "trashed" };
};

/** `lastSeq` counts every version folder, readable or not, so no id is ever handed out twice. */
type Skill = { entry: SkillEntry; versions: VersionManifest[]; lastSeq: number };

export type SkillContent =
  /** Only SKILL.md changes; the skill's other files stay. */
  | { kind: "skill-md"; name: string; content: string }
  /** The whole folder is replaced by `files`, with `content` as its SKILL.md. */
  | { kind: "files"; name: string; content: string; files: SkillTreeFile[] }
  /** The whole folder comes from a `.skill` archive; `resolve` validates its SKILL.md. */
  | {
      kind: "bundle";
      archive: Buffer;
      resolve: (skillMd: string) => Promise<{ name: string; content: string }>;
    };

export type SkillWriteResult = {
  uid: SkillUid;
  versionId: VersionId;
  key: string;
  name: string;
  /** False when nothing was written: identical content, or a replayed tool call. */
  changed: boolean;
};

const NAME_TAKEN = "That name is taken.";
const NOT_FOUND = "Skill not found.";

/** What a bot may do to a skill. It never reaches history, trash or access. */
export interface BotSkillWriter {
  create(content: SkillContent): Promise<SkillWriteResult>;
  update(key: string, content: SkillContent): Promise<SkillWriteResult>;
  /** `uid` is absent when the folder had no history and could not be kept: it is gone for good. */
  delete(key: string): Promise<{ uid?: SkillUid; name: string }>;
  /** What this tool call already wrote, when a crash made it run again; never for the owner. */
  replayed(): Promise<SkillWriteResult | undefined>;
}

export type TrashedSkill = { uid: SkillUid; name: string; trashedAt: string };

/** What one bot run did to one skill, as the line under its message says it. */
export type SkillRunChange = {
  uid: SkillUid;
  /** The skill's id and name now, after any later rename. */
  key: string;
  name: string;
  change: "learned" | "updated" | "deleted";
  /** The run changed the name, description or scripts of a skill other bots read too. */
  reachesOtherBots: boolean;
};

/** What the owner of the skills may do, from the skills screen and the API. */
export interface OwnerSkillAdmin extends BotSkillWriter {
  /** Newest first; the first one not undone is the current content. A read: it records nothing. */
  versions(key: string): Promise<VersionManifest[]>;
  readVersion(
    uid: SkillUid,
    versionId: VersionId,
  ): Promise<{ manifest: VersionManifest; skillMd: string }>;
  /**
   * The uid of each live skill, by key, from the entries alone: no lock, no replay, so a list
   * never waits on a write and an unreadable history only leaves skills without a uid.
   */
  uids(): Promise<Map<string, SkillUid>>;
  trash(): Promise<TrashedSkill[]>;
  /** Back to the version before `expected`, or to the trash for a bot's fresh creation. */
  undo(
    uid: SkillUid,
    expected: VersionId,
  ): Promise<
    { kind: "restored"; versionId: VersionId; key: string; name: string } | { kind: "trashed" }
  >;
  /** Out of the trash, with the access rows it had, minus bots deleted since. */
  restore(uid: SkillUid): Promise<{ key: string; name: string; droppedBotIds: string[] }>;
  purge(uid: SkillUid): Promise<void>;
  deleteVersion(uid: SkillUid, versionId: VersionId): Promise<void>;
  usage(): Promise<{ bytes: number; limit: number }>;
  /** Changes the given rows only, after any interrupted rename has moved them. */
  setAccess(
    key: string,
    change: { availability?: SkillAvailability; bots: Array<{ botId: string; enabled: boolean }> },
  ): Promise<void>;
}

export type BotWriteContext = {
  botId: string;
  botName: string;
  runId: string;
  toolCallId: string;
  /** The run's secret values; a bot write holding one is refused. */
  secrets: string[];
};

export type SkillLibraryDeps = {
  prisma: PrismaClient;
  dataDir: string;
  lock: SkillOwnerLock;
  now?: () => Date;
  quotaBytes?: number;
};

type Layout = { live: string; skills: string; staging: string; journal: string };

function layoutOf(dataDir: string, owner: SkillOwner): Layout {
  const history = path.join(dataDir, ...skillHistorySegments(owner));
  return {
    live: userSkillsRoot(dataDir, owner),
    skills: path.join(history, "skills"),
    staging: path.join(history, "staging"),
    journal: path.join(history, "journal"),
  };
}

const keyName = (key: string) => key.slice("user:".length);

const versionSeq = (versionId: VersionId) => Number(versionId.slice(1, 7));

/** Ids sort like the versions they name: `v<seq>-<random>`. */
function nextVersionId(skill: Skill): VersionId {
  const seq = String(skill.lastSeq + 1).padStart(6, "0");
  return `v${seq}-${randomBytes(4).toString("hex")}` as VersionId;
}

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const damagedVersion = () =>
  new SkillRefusal("invalid", "This skill version is damaged and cannot be used.");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEntry =
  (uid: SkillUid) =>
  (value: unknown): value is SkillEntry =>
    isRecord(value) &&
    value.uid === uid &&
    isRecord(value.state) &&
    (value.state.kind === "live" ||
      (value.state.kind === "trashed" &&
        typeof value.state.trashedAt === "string" &&
        isRecord(value.state.access)));

const isSummary = (value: unknown): value is SkillSummary =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.bytes === "number" &&
  Array.isArray(value.botRuns);

const isManifest =
  (uid: SkillUid, versionId: VersionId) =>
  (value: unknown): value is VersionManifest =>
    isRecord(value) &&
    value.uid === uid &&
    value.versionId === versionId &&
    value.seq === versionSeq(versionId) &&
    typeof value.name === "string" &&
    typeof value.fingerprint === "string" &&
    typeof value.bytes === "number" &&
    Array.isArray(value.files) &&
    isRecord(value.author) &&
    isRecord(value.access);

const isKey = (value: unknown) => typeof value === "string" && value.startsWith("user:");

const isIntent =
  (uid: SkillUid) =>
  (value: unknown): value is Intent =>
    isRecord(value) &&
    value.uid === uid &&
    isKey(value.key) &&
    (value.fromKey === undefined || isKey(value.fromKey)) &&
    typeof value.claimed === "boolean" &&
    isRecord(value.target) &&
    (value.target.kind === "trashed" ||
      (value.target.kind === "live" &&
        typeof value.target.versionId === "string" &&
        parseVersionId(value.target.versionId) !== undefined));

const NO_ACCESS: SkillAccess = { availability: null, bots: [] };
/** Visible to no bot: what a skill gets when the store cannot tell what access it had. */
const NARROWEST: SkillAccess = { availability: "selected", bots: [] };

const currentVersion = (skill: Skill) => skill.versions.filter((v) => !v.undoneAt).at(-1);

const keyOf = (skill: Skill) => {
  const current = currentVersion(skill);
  return current ? userSkillKey(current.name) : undefined;
};

function summarize(skill: Skill): SkillSummary {
  return {
    name: (currentVersion(skill) ?? skill.versions.at(-1))?.name ?? "",
    bytes: skill.versions.reduce((sum, version) => sum + version.bytes, 0),
    botRuns: [
      ...new Set(skill.versions.flatMap((v) => (v.author.kind === "bot" ? [v.author.runId] : []))),
    ],
  };
}

/** Never purged by retention: the last version the user wrote and the one before the first bot write. */
function protectedVersionIds(skill: Skill): Set<string> {
  const ids = new Set<string>();
  const lastUser = skill.versions.findLast((version) => version.author.kind === "user");
  if (lastUser) ids.add(lastUser.versionId);
  if (skill.entry.beforeFirstBot) ids.add(skill.entry.beforeFirstBot);
  return ids;
}

type Loaded =
  | { kind: "skill"; skill: Skill }
  /** No version was ever committed: an interrupted creation. */
  | { kind: "empty" }
  /** Versions exist but none can be read: kept on disk, left alone. */
  | { kind: "unreadable" };

/** One operation's view of the owner's skills: every entry, and the skills it opened in full. */
type Store = {
  /** Every skill's uid, state and summary; an opened skill's summary is recomputed. */
  headers(): Array<{ uid: SkillUid; state: SkillEntry["state"]; summary: SkillSummary }>;
  skill(uid: SkillUid): Promise<Skill | undefined>;
  /** The live skill whose current name is `key`. */
  live(key: string): Promise<Skill | undefined>;
  all(): Promise<Skill[]>;
  adopt(skill: Skill): void;
  forget(uid: SkillUid): void;
  opened(): Skill[];
};

export function createSkillLibrary(deps: SkillLibraryDeps) {
  const now = deps.now ?? (() => new Date());
  const quota = deps.quotaBytes ?? HISTORY_QUOTA_BYTES;

  function forOwner(
    owner: SkillOwner,
    bot?: BotWriteContext,
  ): {
    admin: OwnerSkillAdmin;
    repair: () => Promise<void>;
    changesByRun: (runIds: Iterable<string>) => Promise<Map<string, SkillRunChange[]>>;
  } {
    const { prisma } = deps;
    const L = layoutOf(deps.dataDir, owner);
    const scope = { spaceId: owner.spaceId, userId: owner.userId };
    const liveDir = (key: string) => path.join(L.live, skillDirName(keyName(key)));
    const skillDir = (uid: SkillUid) => path.join(L.skills, uid);
    const versionDir = (uid: SkillUid, versionId: VersionId) =>
      path.join(L.skills, uid, "versions", versionId);
    const entryFile = (uid: SkillUid) => path.join(skillDir(uid), "skill.json");
    const manifestFile = (uid: SkillUid, versionId: VersionId) =>
      path.join(versionDir(uid, versionId), "manifest.json");

    async function readAccess(key: string): Promise<SkillAccess> {
      const [settings, bots] = await Promise.all([
        prisma.skillSetting.findMany({ where: { ...scope, skillKey: key } }),
        prisma.botSkill.findMany({ where: { ...scope, skillKey: key } }),
      ]);
      return {
        availability: settings[0] ? asSkillAvailability(settings[0].availability) : null,
        bots: bots
          .map((row) => ({ botId: row.botId, enabled: row.enabled }))
          .sort((a, b) => a.botId.localeCompare(b.botId)),
      };
    }

    async function replaceAccess(key: string, access: SkillAccess): Promise<void> {
      await prisma.$transaction([
        prisma.skillSetting.deleteMany({ where: { ...scope, skillKey: key } }),
        prisma.botSkill.deleteMany({ where: { ...scope, skillKey: key } }),
        ...(access.availability
          ? [
              prisma.skillSetting.upsert({
                where: { spaceId_userId_skillKey: { ...scope, skillKey: key } },
                create: { ...scope, skillKey: key, availability: access.availability },
                update: { availability: access.availability },
              }),
            ]
          : []),
        ...access.bots.map((row) =>
          prisma.botSkill.upsert({
            where: { botId_skillKey: { botId: row.botId, skillKey: key } },
            create: { ...scope, botId: row.botId, skillKey: key, enabled: row.enabled },
            update: { enabled: row.enabled },
          }),
        ),
      ]);
    }

    async function hasSkillMd(dir: string): Promise<boolean> {
      const [folder, file] = await Promise.all([
        lstat(dir).catch(() => null),
        lstat(path.join(dir, "SKILL.md")).catch(() => null),
      ]);
      return folder?.isDirectory() === true && file?.isFile() === true;
    }

    /**
     * A skill.json lost to corruption, rebuilt from its versions: live only while its folder holds
     * its current version, otherwise in the trash, visible to no bot, so a damaged entry never
     * brings a deleted skill back nor widens who sees it.
     */
    async function recoverEntry(uid: SkillUid, versions: VersionManifest[]): Promise<SkillEntry> {
      const firstBot = versions.findIndex((version) => version.author.kind === "bot");
      const beforeFirstBot = firstBot > 0 ? versions[firstBot - 1]?.versionId : undefined;
      const current = versions.filter((version) => !version.undoneAt).at(-1);
      const folder = current
        ? await captureTree(liveDir(userSkillKey(current.name))).catch(() => undefined)
        : undefined;
      const live = folder !== undefined && fingerprint(folder) === current?.fingerprint;
      getLogger().warn(`[skills] rebuilt the entry of ${uid} from its versions`, { live });
      return {
        uid,
        state: live
          ? { kind: "live" }
          : { kind: "trashed", trashedAt: now().toISOString(), access: NARROWEST },
        ...(beforeFirstBot ? { beforeFirstBot } : {}),
      };
    }

    async function loadSkill(uid: SkillUid): Promise<Loaded> {
      const versions: VersionManifest[] = [];
      let lastSeq = 0;
      let committedVersions = 0;
      for (const name of await readdirOrEmpty(path.join(skillDir(uid), "versions"))) {
        const versionId = parseVersionId(name);
        if (!versionId) continue;
        lastSeq = Math.max(lastSeq, versionSeq(versionId));
        const read = await readHistoryJson(
          manifestFile(uid, versionId),
          isManifest(uid, versionId),
        );
        if (read.state === "missing") continue;
        committedVersions += 1;
        if (read.state === "ok") versions.push(read.value);
      }
      if (committedVersions === 0) return { kind: "empty" };
      if (versions.length === 0) return { kind: "unreadable" };
      versions.sort((a, b) => a.seq - b.seq);
      const read = await readHistoryJson(entryFile(uid), isEntry(uid));
      const entry = read.state === "ok" ? read.value : await recoverEntry(uid, versions);
      return { kind: "skill", skill: { entry, versions, lastSeq } };
    }

    const writeEntry = (entry: SkillEntry) => writeJsonAtomic(entryFile(entry.uid), entry);

    async function saveSummary(skill: Skill): Promise<void> {
      const summary = summarize(skill);
      if (JSON.stringify(skill.entry.summary) === JSON.stringify(summary)) return;
      skill.entry = { ...skill.entry, summary };
      await writeEntry(skill.entry);
    }

    /** Every skill opened in full is tidied first, so no operation sees what retention drops. */
    async function openStore(): Promise<Store> {
      const entries = new Map<SkillUid, SkillEntry>();
      const loaded = new Map<SkillUid, Skill>();
      const open = async (uid: SkillUid) => {
        const full = await loadSkill(uid);
        if (full.kind !== "skill" || !(await tidy(full.skill))) {
          entries.delete(uid);
          return undefined;
        }
        entries.set(uid, full.skill.entry);
        loaded.set(uid, full.skill);
        return full.skill;
      };
      for (const name of await readdirOrEmpty(L.skills)) {
        const uid = parseSkillUid(name);
        if (!uid) continue;
        const read = await readHistoryJson(entryFile(uid), isEntry(uid));
        if (read.state === "ok" && isSummary(read.value.summary) && !expired(read.value)) {
          entries.set(uid, read.value);
        } else await open(uid);
      }
      const skill = async (uid: SkillUid) =>
        loaded.get(uid) ?? (entries.has(uid) ? await open(uid) : undefined);
      const headers = () =>
        [...entries.keys()].flatMap((uid) => {
          const open = loaded.get(uid);
          const entry = open?.entry ?? entries.get(uid);
          const summary = open ? summarize(open) : entry?.summary;
          return entry && summary ? [{ uid, state: entry.state, summary }] : [];
        });
      const liveAt = async (key: string, uids: SkillUid[]) => {
        const found: Skill[] = [];
        for (const uid of uids) {
          const candidate = await skill(uid);
          if (candidate?.entry.state.kind === "live" && keyOf(candidate) === key) {
            found.push(candidate);
          }
        }
        return found.sort((a, b) =>
          (currentVersion(a)?.createdAt ?? "").localeCompare(currentVersion(b)?.createdAt ?? ""),
        );
      };
      return {
        headers,
        skill,
        async live(key) {
          const named = headers()
            .filter((h) => h.state.kind === "live" && userSkillKey(h.summary.name) === key)
            .map((h) => h.uid);
          // A summary left stale by a crash must never mint a second history for one folder.
          const found = named.length > 0 ? await liveAt(key, named) : [];
          return (found.length > 0 ? found : await liveAt(key, [...entries.keys()])).at(-1);
        },
        async all() {
          const all: Skill[] = [];
          for (const uid of entries.keys()) {
            const full = await skill(uid);
            if (full) all.push(full);
          }
          return all;
        },
        adopt(skill) {
          entries.set(skill.entry.uid, skill.entry);
          loaded.set(skill.entry.uid, skill);
        },
        forget(uid) {
          entries.delete(uid);
          loaded.delete(uid);
        },
        opened: () => [...loaded.values()],
      };
    }

    /** Files first, the manifest last: a version exists once its manifest does. */
    async function writeVersion(
      skill: Skill,
      tree: SkillTreeFile[],
      fields: Pick<VersionManifest, "name" | "author" | "nature" | "access">,
      versionId = nextVersionId(skill),
    ): Promise<VersionManifest> {
      const manifest: VersionManifest = {
        versionId,
        uid: skill.entry.uid,
        seq: versionSeq(versionId),
        ...fields,
        files: tree.map((file) => ({
          path: file.path,
          size: file.bytes.length,
          executable: file.executable,
        })),
        bytes: treeBytes(tree),
        fingerprint: fingerprint(tree),
        createdAt: now().toISOString(),
      };
      const dir = versionDir(skill.entry.uid, versionId);
      for (const file of tree) {
        const target = path.join(dir, "files", file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeDurable(target, file.bytes);
      }
      await writeJsonAtomic(manifestFile(skill.entry.uid, versionId), manifest);
      skill.versions.push(manifest);
      skill.lastSeq = Math.max(skill.lastSeq, manifest.seq);
      return manifest;
    }

    /**
     * A version's files read back like an import: only plain files inside its folder, within the
     * caps, the executable bit only under scripts/, and exactly the content its manifest names.
     */
    async function readVersionTree(manifest: VersionManifest): Promise<SkillTreeFile[]> {
      const executable = new Map(manifest.files.map((file) => [file.path, file.executable]));
      let tree: SkillTreeFile[];
      try {
        const stored = await captureTree(
          path.join(versionDir(manifest.uid, manifest.versionId), "files"),
          { hardLinks: true },
        );
        tree = normalizeTree(
          stored.map((file) => ({ ...file, executable: executable.get(file.path) === true })),
        );
      } catch {
        throw damagedVersion();
      }
      const listed = manifest.files.map((file) => [file.path, file.size, file.executable]);
      const found = tree.map((file) => [file.path, file.bytes.length, file.executable]);
      if (
        JSON.stringify(listed) !== JSON.stringify(found) ||
        fingerprint(tree) !== manifest.fingerprint
      ) {
        throw damagedVersion();
      }
      return tree;
    }

    async function removeVersion(skill: Skill, versionId: VersionId): Promise<void> {
      await moveAway(versionDir(skill.entry.uid, versionId));
      skill.versions = skill.versions.filter((version) => version.versionId !== versionId);
    }

    /**
     * Gone in one rename into staging, outside the mounted root, then removed: a crash leaves at
     * most a part of it in staging, which every operation empties, never a part in place.
     */
    async function moveAway(dir: string): Promise<void> {
      const aside = path.join(L.staging, randomUUID());
      await mkdir(L.staging, { recursive: true });
      try {
        await rename(dir, aside);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return;
        throw error;
      }
      await rm(aside, { recursive: true, force: true });
    }

    const journalFile = (uid: SkillUid) => path.join(L.journal, `${uid}.json`);
    const journal = (intent: Intent) => writeJsonAtomic(journalFile(intent.uid), intent);
    const dropJournal = (intent: Intent) => rm(journalFile(intent.uid), { force: true });

    async function committed(intent: Intent): Promise<boolean> {
      const loaded = await loadSkill(intent.uid);
      if (loaded.kind !== "skill") return false;
      const { skill } = loaded;
      if (intent.target.kind === "trashed") return skill.entry.state.kind === "trashed";
      return (
        skill.entry.state.kind === "live" &&
        currentVersion(skill)?.versionId === intent.target.versionId
      );
    }

    /** From a committed intent to the matching live folders and access rows; safe to rerun. */
    async function converge(intent: Intent): Promise<void> {
      const { target } = intent;
      if (target.kind === "trashed") {
        await moveAway(liveDir(intent.key));
        await replaceAccess(intent.key, NO_ACCESS);
        return;
      }
      const loaded = await loadSkill(intent.uid);
      const version =
        loaded.kind === "skill"
          ? loaded.skill.versions.find((v) => v.versionId === target.versionId)
          : undefined;
      if (!version) throw new Error(`Skill version ${target.versionId} is missing.`);
      await materialize(await readVersionTree(version), liveDir(intent.key), L.staging);
      if (intent.fromKey && intent.fromKey !== intent.key) {
        await moveAway(liveDir(intent.fromKey));
        await replaceAccess(intent.fromKey, NO_ACCESS);
      }
    }

    /** The journaled steps after the commit: converge, keep the summary true, forget the intent. */
    async function finish(intent: Intent, skill: Skill): Promise<void> {
      await converge(intent);
      await saveSummary(skill);
      await dropJournal(intent);
    }

    /** Before the commit nothing is visible: drop the claimed folder, its rows, its empty history. */
    async function rollback(intent: Intent): Promise<void> {
      if ((await loadSkill(intent.uid)).kind === "empty") await moveAway(skillDir(intent.uid));
      if (!intent.claimed || (await hasSkillMd(liveDir(intent.key)))) return;
      await rm(liveDir(intent.key), { recursive: true, force: true });
      await replaceAccess(intent.key, NO_ACCESS);
    }

    /**
     * Finishes or undoes interrupted operations. An intent is flushed before its operation does
     * anything, so one that cannot be read never started; a committed one whose version cannot be
     * used is logged and dropped rather than block the owner's every write.
     */
    async function replayJournal(): Promise<void> {
      for (const name of await readdirOrEmpty(L.journal)) {
        const file = path.join(L.journal, name);
        const uid = name.endsWith(".json") ? parseSkillUid(name.slice(0, -5)) : undefined;
        const read = uid ? await readHistoryJson(file, isIntent(uid)) : undefined;
        if (uid && read?.state === "ok") {
          try {
            if (await committed(read.value)) await converge(read.value);
            else await rollback(read.value);
          } catch (error) {
            if (!(error instanceof SkillRefusal)) throw error;
            getLogger().error(`[skills] could not finish an operation on ${uid}: ${error.message}`);
          }
          const loaded = await loadSkill(uid);
          if (loaded.kind === "skill") await saveSummary(loaded.skill);
        }
        await rm(file, { force: true });
      }
    }

    /**
     * A live skill whose folder was removed outside the store goes to the trash with the access
     * rows it has now, or visible to no bot without any: a version's own rows never return.
     * A missing skills root is an unmounted volume, not every skill deleted: nothing moves.
     */
    async function trashOutOfStore(skill: Skill, key: string): Promise<void> {
      if (!(await lstat(L.live).catch(() => null))) return;
      getLogger().warn(`[skills] ${skill.entry.uid} left its folder outside the store; trashed`);
      const rows = await readAccess(key);
      const access = rows.availability || rows.bots.length > 0 ? rows : NARROWEST;
      skill.entry = {
        ...skill.entry,
        state: { kind: "trashed", trashedAt: now().toISOString(), access },
      };
      await writeEntry(skill.entry);
    }

    /** Every skill checked: leftovers removed, out-of-store deletions trashed. */
    async function sweep(store: Store): Promise<void> {
      for (const name of await readdirOrEmpty(L.live)) {
        const dir = path.join(L.live, name);
        if (name.startsWith(".import-")) await rm(dir, { recursive: true, force: true });
        else if ((await lstat(dir)).isDirectory() && (await readdir(dir)).length === 0) {
          await rmdir(dir);
        }
      }
      for (const name of await readdirOrEmpty(L.skills)) {
        const uid = parseSkillUid(name);
        if (!uid) continue;
        if (!(await store.skill(uid))) {
          if ((await loadSkill(uid)).kind === "empty") await moveAway(skillDir(uid));
          continue;
        }
        for (const versionName of await readdirOrEmpty(path.join(skillDir(uid), "versions"))) {
          const versionId = parseVersionId(versionName);
          if (versionId && !(await lstat(manifestFile(uid, versionId)).catch(() => null))) {
            await moveAway(versionDir(uid, versionId));
          }
        }
      }
      for (const skill of await store.all()) {
        const key = keyOf(skill);
        if (skill.entry.state.kind === "live" && key && !(await hasSkillMd(liveDir(key)))) {
          await trashOutOfStore(skill, key);
        }
      }
    }

    /**
     * One operation under the owner's lock. A filesystem error refuses it as unavailable and is
     * logged: the journal finishes or undoes it once the folder is usable again.
     */
    async function run<T>(
      op: (store: Store) => Promise<T>,
      mode: "operation" | "sweep" = "operation",
    ): Promise<T> {
      try {
        return await deps.lock.run(owner, async () => {
          await replayJournal();
          await rm(L.staging, { recursive: true, force: true });
          const store = await openStore();
          if (mode === "sweep") await sweep(store);
          const result = await op(store);
          for (const skill of store.opened()) {
            if (await tidy(skill)) await saveSummary(skill);
          }
          await rm(L.staging, { recursive: true, force: true });
          await rmdir(L.journal).catch(() => undefined);
          return result;
        });
      } catch (error) {
        if (!(error instanceof Error) || !("syscall" in error)) throw error;
        getLogger().error(`[skills] ${owner.spaceId}/${owner.userId}: ${error.message}`);
        throw unavailable();
      }
    }

    /**
     * Claims a skill folder: the exclusive mkdir is the name-uniqueness guard. A skill whose folder
     * vanished outside the store is trashed first, and an empty folder left by a crash is reused.
     */
    async function claim(store: Store, key: string): Promise<void> {
      const dir = liveDir(key);
      await mkdir(L.live, { recursive: true });
      if (!(await hasSkillMd(dir))) {
        for (const header of store.headers()) {
          if (header.state.kind !== "live" || userSkillKey(header.summary.name) !== key) continue;
          const skill = await store.skill(header.uid);
          if (skill?.entry.state.kind === "live" && keyOf(skill) === key) {
            await trashOutOfStore(skill, key);
          }
        }
      }
      const made = () =>
        mkdir(dir).then(
          () => true,
          (error: unknown) => {
            if (hasCode(error, "EEXIST")) return false;
            if (hasCode(error, "ENAMETOOLONG")) {
              throw new SkillRefusal("invalid", "Skill name is too long for a folder.");
            }
            throw error;
          },
        );
      if (await made()) return;
      const info = await lstat(dir);
      if (!info.isDirectory() || (await readdir(dir)).length > 0) {
        throw new SkillRefusal("name_taken", NAME_TAKEN);
      }
      await rmdir(dir);
      if (!(await made())) throw new SkillRefusal("name_taken", NAME_TAKEN);
    }

    /**
     * The live skill at `key`, its uid and current files. A skill with no history yet gets its
     * current content as a base version; content changed outside the store is recorded first.
     */
    async function reconcile(
      store: Store,
      key: string,
    ): Promise<{ skill: Skill; tree: SkillTreeFile[] }> {
      const dir = liveDir(key);
      if (!(await hasSkillMd(dir))) throw new SkillRefusal("not_found", NOT_FOUND);
      const tree = await captureTree(dir);
      const skillMd = tree.find((file) => file.path === "SKILL.md");
      const parsed = parseSkillMd(skillMd ? textOf(skillMd.bytes) : "");
      const name = "error" in parsed ? keyName(key) : parsed.name;
      let skill = await store.live(key);
      if (!skill) {
        const uid = randomBytes(16).toString("hex") as SkillUid;
        skill = { entry: { uid, state: { kind: "live" } }, versions: [], lastSeq: 0 };
        await writeEntry(skill.entry);
        await writeVersion(skill, tree, {
          name,
          author: { kind: "unknown" },
          nature: "created",
          access: await readAccess(key),
        });
        store.adopt(skill);
      } else if (currentVersion(skill)?.fingerprint !== fingerprint(tree)) {
        await writeVersion(skill, tree, {
          name,
          author: { kind: "unknown" },
          nature: "unknown",
          access: await readAccess(key),
        });
      }
      return { skill, tree };
    }

    async function stage(
      content: SkillContent,
      current: SkillTreeFile[],
    ): Promise<{ name: string; tree: SkillTreeFile[] }> {
      if (content.kind === "skill-md") {
        return { name: content.name, tree: withSkillMd(current, content.content) };
      }
      if (content.kind === "files") {
        return { name: content.name, tree: withSkillMd(content.files, content.content) };
      }
      const out = path.join(L.staging, randomUUID());
      await mkdir(out, { recursive: true });
      try {
        const dir = await extractSkillBundle(content.archive, out).catch((error: unknown) => {
          throw new SkillRefusal(
            "invalid",
            error instanceof Error ? error.message : "Invalid skill bundle.",
          );
        });
        const tree = await captureTree(dir);
        const skillMd = tree.find((file) => file.path === "SKILL.md");
        const resolved = await content.resolve(skillMd ? textOf(skillMd.bytes) : "");
        return { name: resolved.name, tree: withSkillMd(tree, resolved.content) };
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    }

    /** A bot answers for the files it changes: readable text, no run secret, room in the quota. */
    function checkBotWrite(
      store: Store,
      tree: SkillTreeFile[],
      prior: SkillTreeFile[],
      writer: BotWriteContext,
    ): void {
      const before = new Map(prior.map((file) => [file.path, file.bytes]));
      const changed = tree.filter((file) => {
        const old = before.get(file.path);
        return !old || Buffer.compare(Buffer.from(old), Buffer.from(file.bytes)) !== 0;
      });
      for (const file of changed) {
        const error = validateBotSkillFile(file);
        if (error) throw new SkillRefusal("invalid", error);
      }
      if (
        containsSecret(
          changed.flatMap((file) => [file.path, textOf(file.bytes)]),
          writer.secrets,
        )
      ) {
        throw new SkillRefusal("invalid", "Skill files must not contain a secret from this run.");
      }
      if (usage(store) + treeBytes(tree) > quota) {
        throw new SkillRefusal(
          "quota",
          "Skill history is full. The user can free space by deleting skills from Recently deleted.",
        );
      }
    }

    function replayIn(skill: Skill, writer: BotWriteContext): SkillWriteResult | undefined {
      const hit = skill.versions.some(
        (version) =>
          version.author.kind === "bot" &&
          version.author.runId === writer.runId &&
          version.author.toolCallIds.includes(writer.toolCallId),
      );
      const current = currentVersion(skill);
      if (!hit || !current) return undefined;
      return {
        uid: skill.entry.uid,
        versionId: current.versionId,
        key: userSkillKey(current.name),
        name: current.name,
        changed: false,
      };
    }

    /** Only skills this run wrote can hold the replayed call. */
    async function replayOf(store: Store, writer: BotWriteContext) {
      for (const header of store.headers()) {
        if (!header.summary.botRuns.includes(writer.runId)) continue;
        const skill = await store.skill(header.uid);
        const replayed = skill && replayIn(skill, writer);
        if (replayed) return replayed;
      }
      return undefined;
    }

    const author = (): SkillAuthor =>
      bot
        ? {
            kind: "bot",
            botId: bot.botId,
            botName: bot.botName,
            runId: bot.runId,
            toolCallIds: [bot.toolCallId],
          }
        : { kind: "user" };

    const expiredAt = (at: string | undefined) =>
      at !== undefined && Date.parse(at) < now().getTime() - RETENTION_MS;
    const expired = (entry: SkillEntry) =>
      entry.state.kind === "trashed" && expiredAt(entry.state.trashedAt);

    /**
     * Retention and the thirty-day purge of the trash and of undone versions, whenever a skill is
     * opened and after each operation; false once the skill itself expired.
     */
    async function tidy(skill: Skill): Promise<boolean> {
      if (expired(skill.entry)) {
        await moveAway(skillDir(skill.entry.uid));
        return false;
      }
      for (const version of skill.versions) {
        if (expiredAt(version.undoneAt)) {
          await removeVersion(skill, version.versionId);
        }
      }
      const keep = protectedVersionIds(skill);
      const purgeable = skill.versions.filter((v) => !v.undoneAt && !keep.has(v.versionId));
      for (const version of purgeable.slice(0, Math.max(0, purgeable.length - KEPT_VERSIONS))) {
        await removeVersion(skill, version.versionId);
      }
      return true;
    }

    async function trashSkill(skill: Skill, key: string): Promise<void> {
      const intent: Intent = {
        uid: skill.entry.uid,
        key,
        claimed: false,
        target: { kind: "trashed" },
      };
      await journal(intent);
      skill.entry = {
        ...skill.entry,
        state: {
          kind: "trashed",
          trashedAt: now().toISOString(),
          access: await readAccess(key),
          ...(bot ? { byRun: bot.runId } : {}),
        },
      };
      await writeEntry(skill.entry);
      await finish(intent, skill);
    }

    const create = (content: SkillContent): Promise<SkillWriteResult> =>
      run(async (store) => {
        const replayed = bot && (await replayOf(store, bot));
        if (replayed) return replayed;
        const { name, tree } = await stage(content, []);
        if (bot) checkBotWrite(store, tree, [], bot);
        const key = userSkillKey(name);
        await claim(store, key);
        const uid = randomBytes(16).toString("hex") as SkillUid;
        const skill: Skill = { entry: { uid, state: { kind: "live" } }, versions: [], lastSeq: 0 };
        const access: SkillAccess = bot
          ? { availability: "selected", bots: [{ botId: bot.botId, enabled: true }] }
          : NO_ACCESS;
        const versionId = nextVersionId(skill);
        const intent: Intent = { uid, key, claimed: true, target: { kind: "live", versionId } };
        await journal(intent);
        await replaceAccess(key, access);
        await writeEntry(skill.entry);
        await writeVersion(
          skill,
          tree,
          { name, author: author(), nature: "created", access },
          versionId,
        );
        store.adopt(skill);
        await finish(intent, skill);
        return { uid, versionId, key, name, changed: true };
      });

    const update = (key: string, content: SkillContent): Promise<SkillWriteResult> =>
      run(async (store) => {
        // Before the lookup: a replayed rename no longer finds its old key.
        const replayed = bot && (await replayOf(store, bot));
        if (replayed) return replayed;
        const live = await reconcile(store, key);
        const { skill } = live;
        const current = currentVersion(skill);
        if (!current) throw new SkillRefusal("not_found", NOT_FOUND);
        const { name, tree } = await stage(content, live.tree);
        if (name === current.name && fingerprint(tree) === current.fingerprint) {
          return { uid: skill.entry.uid, versionId: current.versionId, key, name, changed: false };
        }
        if (bot) checkBotWrite(store, tree, live.tree, bot);
        const newKey = userSkillKey(name);
        const renamed = newKey !== key;
        if (renamed) await claim(store, newKey);
        const folded =
          bot &&
          current.author.kind === "bot" &&
          current.author.botId === bot.botId &&
          current.author.runId === bot.runId
            ? current
            : undefined;
        const versionId = nextVersionId(skill);
        const intent: Intent = {
          uid: skill.entry.uid,
          key: newKey,
          ...(renamed ? { fromKey: key } : {}),
          claimed: renamed,
          target: { kind: "live", versionId },
        };
        await journal(intent);
        if (renamed) await replaceAccess(newKey, await readAccess(key));
        if (
          bot &&
          !skill.entry.beforeFirstBot &&
          !skill.versions.some((version) => version.author.kind === "bot")
        ) {
          skill.entry = { ...skill.entry, beforeFirstBot: current.versionId };
          await writeEntry(skill.entry);
        }
        const writer = author();
        await writeVersion(
          skill,
          tree,
          {
            name,
            author:
              folded?.author.kind === "bot" && writer.kind === "bot"
                ? { ...writer, toolCallIds: [...folded.author.toolCallIds, ...writer.toolCallIds] }
                : writer,
            nature: folded ? folded.nature : "modified",
            access: await readAccess(newKey),
          },
          versionId,
        );
        await finish(intent, skill);
        if (folded) await removeVersion(skill, folded.versionId);
        return { uid: skill.entry.uid, versionId, key: newKey, name, changed: true };
      });

    /**
     * Never blocked by a folder the store cannot copy: the trash then keeps the last version, and
     * a folder that never had one is removed for good, as before the store existed.
     */
    const remove = (key: string) =>
      run(async (store): Promise<{ uid?: SkillUid; name: string }> => {
        let skill: Skill;
        try {
          ({ skill } = await reconcile(store, key));
        } catch (error) {
          if (!(error instanceof SkillRefusal) || error.reason !== "invalid") throw error;
          const known = await store.live(key);
          getLogger().warn(`[skills] deleting ${key} without a new version: ${error.message}`);
          if (!known) {
            await moveAway(liveDir(key));
            await replaceAccess(key, NO_ACCESS);
            return { name: keyName(key) };
          }
          skill = known;
        }
        await trashSkill(skill, key);
        return { uid: skill.entry.uid, name: currentVersion(skill)?.name ?? keyName(key) };
      });

    const findSkill = async (store: Store, uid: SkillUid, state: "live" | "trashed") => {
      const skill = await store.skill(uid);
      if (!skill || skill.entry.state.kind !== state) {
        throw new SkillRefusal("not_found", NOT_FOUND);
      }
      return skill;
    };

    const admin: OwnerSkillAdmin = {
      create,
      update,
      delete: remove,
      replayed: () => run(async (store) => (bot ? await replayOf(store, bot) : undefined)),

      setAccess: (key, change) =>
        run(async () => {
          if (key.startsWith("user:") && !(await hasSkillMd(liveDir(key)))) {
            throw new SkillRefusal("not_found", NOT_FOUND);
          }
          await prisma.$transaction([
            ...(change.availability
              ? [
                  prisma.skillSetting.upsert({
                    where: { spaceId_userId_skillKey: { ...scope, skillKey: key } },
                    create: { ...scope, skillKey: key, availability: change.availability },
                    update: { availability: change.availability },
                  }),
                ]
              : []),
            ...change.bots.map((row) =>
              prisma.botSkill.upsert({
                where: { botId_skillKey: { botId: row.botId, skillKey: key } },
                create: { ...scope, botId: row.botId, skillKey: key, enabled: row.enabled },
                update: { enabled: row.enabled },
              }),
            ),
          ]);
        }),

      versions: (key) =>
        run(async (store) => {
          const skill = await store.live(key);
          return skill ? [...skill.versions].reverse() : [];
        }),

      readVersion: (uid, versionId) =>
        run(async (store) => {
          const manifest = (await store.skill(uid))?.versions.find(
            (v) => v.versionId === versionId,
          );
          if (!manifest) throw new SkillRefusal("not_found", NOT_FOUND);
          const skillMd = (await readVersionTree(manifest)).find((f) => f.path === "SKILL.md");
          if (!skillMd) throw damagedVersion();
          return { manifest, skillMd: textOf(skillMd.bytes) };
        }),

      uids: async () => {
        const uids = new Map<string, SkillUid>();
        try {
          for (const name of await readdirOrEmpty(L.skills)) {
            const uid = parseSkillUid(name);
            const read = uid ? await readHistoryJson(entryFile(uid), isEntry(uid)) : undefined;
            if (uid && read?.state === "ok" && read.value.state.kind === "live") {
              const { summary } = read.value;
              if (isSummary(summary)) uids.set(userSkillKey(summary.name), uid);
            }
          }
        } catch (error) {
          getLogger().warn(`[skills] ${owner.spaceId}/${owner.userId}: uids unreadable`, { error });
        }
        return uids;
      },

      trash: () =>
        run(async (store) => {
          for (const header of store.headers()) {
            const key = userSkillKey(header.summary.name);
            if (header.state.kind !== "live" || (await hasSkillMd(liveDir(key)))) continue;
            const skill = await store.skill(header.uid);
            if (skill?.entry.state.kind === "live" && keyOf(skill) === key) {
              await trashOutOfStore(skill, key);
            }
          }
          return store
            .headers()
            .flatMap(({ uid, state, summary }) =>
              state.kind === "trashed"
                ? [{ uid, name: summary.name, trashedAt: state.trashedAt }]
                : [],
            )
            .sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
        }),

      undo: (uid, expected) =>
        run(async (store) => {
          const key = keyOf(await findSkill(store, uid, "live"));
          if (!key) throw new SkillRefusal("not_found", NOT_FOUND);
          const { skill } = await reconcile(store, key);
          const kept = skill.versions.filter((v) => !v.undoneAt);
          const current = kept.at(-1);
          const previous = kept.at(-2);
          if (current?.versionId !== expected) {
            throw new SkillRefusal("stale", "This skill changed. Reload and try again.");
          }
          if (!previous) {
            if (current.author.kind !== "bot" || current.nature !== "created") {
              throw new SkillRefusal("not_undoable", "There is no earlier version.");
            }
            await trashSkill(skill, key);
            return { kind: "trashed" as const };
          }
          await readVersionTree(previous);
          const toKey = userSkillKey(previous.name);
          const renamed = toKey !== key;
          if (renamed) await claim(store, toKey);
          const intent: Intent = {
            uid,
            key: toKey,
            ...(renamed ? { fromKey: key } : {}),
            claimed: renamed,
            target: { kind: "live", versionId: previous.versionId },
          };
          await journal(intent);
          // A rename moves the current rows to the old name; a version's own rows never return.
          if (renamed) await replaceAccess(toKey, await readAccess(key));
          const undone = { ...current, undoneAt: now().toISOString() };
          await writeJsonAtomic(manifestFile(uid, current.versionId), undone);
          skill.versions = skill.versions.map((v) => (v === current ? undone : v));
          await finish(intent, skill);
          return {
            kind: "restored" as const,
            versionId: previous.versionId,
            key: toKey,
            name: previous.name,
          };
        }),

      restore: (uid) =>
        run(async (store) => {
          const skill = await findSkill(store, uid, "trashed");
          const current = currentVersion(skill);
          if (!current || skill.entry.state.kind !== "trashed") {
            throw new SkillRefusal("not_found", NOT_FOUND);
          }
          await readVersionTree(current);
          const { access } = skill.entry.state;
          const key = userSkillKey(current.name);
          await claim(store, key);
          const intent: Intent = {
            uid,
            key,
            claimed: true,
            target: { kind: "live", versionId: current.versionId },
          };
          await journal(intent);
          const known = new Set(
            (
              await prisma.bot.findMany({
                where: { ...scope, id: { in: access.bots.map((row) => row.botId) } },
                select: { id: true },
              })
            ).map((row) => row.id),
          );
          await replaceAccess(key, {
            availability: access.availability,
            bots: access.bots.filter((row) => known.has(row.botId)),
          });
          skill.entry = { ...skill.entry, state: { kind: "live" } };
          await writeEntry(skill.entry);
          await finish(intent, skill);
          return {
            key,
            name: current.name,
            droppedBotIds: access.bots
              .filter((row) => !known.has(row.botId))
              .map((row) => row.botId),
          };
        }),

      purge: (uid) =>
        run(async (store) => {
          await findSkill(store, uid, "trashed");
          await moveAway(skillDir(uid));
          store.forget(uid);
        }),

      deleteVersion: (uid, versionId) =>
        run(async (store) => {
          const skill = await store.skill(uid);
          const version = skill?.versions.find((v) => v.versionId === versionId);
          if (!skill || !version) throw new SkillRefusal("not_found", NOT_FOUND);
          if (currentVersion(skill)?.versionId === versionId) {
            throw new SkillRefusal("current_version", "The current version cannot be deleted.");
          }
          await removeVersion(skill, versionId);
        }),

      usage: () => run(async (store) => ({ bytes: usage(store), limit: quota })),
    };

    /** Whether the run's last write changed what another bot reads of the skill. */
    async function reachesOtherBots(skill: Skill, own: VersionManifest[]): Promise<boolean> {
      const first = own[0];
      const last = own.at(-1);
      if (!first || !last || last.author.kind !== "bot") return false;
      const writer = last.author.botId;
      const { availability, bots } = last.access;
      const shared =
        availability !== "disabled" &&
        ((availability ?? "all") === "all" ||
          bots.some((row) => row.enabled && row.botId !== writer));
      if (!shared) return false;
      const before = skill.versions.filter((v) => v.seq < first.seq && !v.undoneAt).at(-1);
      if (!before || before.name !== last.name) return true;
      let prior: SkillTreeFile[];
      let next: SkillTreeFile[];
      try {
        [prior, next] = await Promise.all([readVersionTree(before), readVersionTree(last)]);
      } catch (error) {
        if (error instanceof SkillRefusal) return true;
        throw error;
      }
      const description = (tree: SkillTreeFile[]) => {
        const skillMd = tree.find((file) => file.path === "SKILL.md");
        const parsed = parseSkillMd(skillMd ? textOf(skillMd.bytes) : "");
        return "error" in parsed ? undefined : parsed.description;
      };
      const scripts = (tree: SkillTreeFile[]) =>
        fingerprint(tree.filter((file) => file.path.startsWith("scripts/")));
      return description(prior) !== description(next) || scripts(prior) !== scripts(next);
    }

    /**
     * For each run asked, what it did to each skill: one entry per (run, skill), read from the
     * history, in the order the run first touched them. Only those runs' versions are compared.
     */
    const changesByRun = (asked: Iterable<string>) =>
      run(async (store) => {
        const wanted = new Set(asked);
        const byRun = new Map<string, Array<SkillRunChange & { at: string }>>();
        for (const skill of await store.all()) {
          const name = (currentVersion(skill) ?? skill.versions.at(-1))?.name;
          if (!name) continue;
          const { state } = skill.entry;
          const deletedBy = state.kind === "trashed" ? state.byRun : undefined;
          const runIds = new Set(
            skill.versions.flatMap((v) =>
              v.author.kind === "bot" && wanted.has(v.author.runId) ? [v.author.runId] : [],
            ),
          );
          if (deletedBy && wanted.has(deletedBy)) runIds.add(deletedBy);
          for (const runId of runIds) {
            const own = skill.versions.filter(
              (v) => v.author.kind === "bot" && v.author.runId === runId,
            );
            const change =
              runId === deletedBy
                ? "deleted"
                : own.some((v) => v.nature === "created")
                  ? "learned"
                  : "updated";
            byRun.set(runId, [
              ...(byRun.get(runId) ?? []),
              {
                uid: skill.entry.uid,
                key: userSkillKey(name),
                name,
                change,
                reachesOtherBots: change === "updated" && (await reachesOtherBots(skill, own)),
                at: own[0]?.createdAt ?? (state.kind === "trashed" ? state.trashedAt : ""),
              },
            ]);
          }
        }
        return new Map(
          [...byRun].map(([runId, changes]) => [
            runId,
            changes.sort((a, b) => a.at.localeCompare(b.at)).map(({ at: _, ...change }) => change),
          ]),
        );
      });

    /**
     * Sweeps the store. Rows whose folder is gone stay: a folder that comes back without its rows
     * would be visible to every bot, while a row without a folder grants nothing.
     */
    const repair = () => run(async () => undefined, "sweep");

    return { admin, repair, changesByRun };
  }

  return {
    /** The three writes and their replay, so no bot tool can reach the owner's history or trash. */
    forBot(owner: SkillOwner, bot: BotWriteContext): BotSkillWriter {
      const { admin } = forOwner(owner, bot);
      return {
        create: admin.create,
        update: admin.update,
        delete: admin.delete,
        replayed: admin.replayed,
      };
    },
    forOwner: (owner: SkillOwner): OwnerSkillAdmin => forOwner(owner).admin,
    repair: (owner: SkillOwner): Promise<void> => forOwner(owner).repair(),
    changesByRun: (
      owner: SkillOwner,
      runIds: Iterable<string>,
    ): Promise<Map<string, SkillRunChange[]>> => forOwner(owner).changesByRun(runIds),
  };
}

export type SkillLibrary = ReturnType<typeof createSkillLibrary>;

/** Bytes kept in an owner's versions and trash. */
function usage(store: Store): number {
  return store.headers().reduce((sum, header) => sum + header.summary.bytes, 0);
}

/**
 * The startup and periodic sweep for the API and the worker: each owner's interrupted operations
 * are finished or undone and every skill is checked under that owner's lock. One owner's failure
 * is logged and the sweep moves on. It never erases history: a user who looks absent may be a
 * database that is empty or mis-pointed, so only account deletion (purgeUserSkills) erases it.
 */
export async function repairSkillLibrary(deps: SkillLibraryDeps): Promise<void> {
  const library = createSkillLibrary(deps);
  const owners = new Map<string, SkillOwner>();
  for (const base of [
    path.join(deps.dataDir, "skills", "user"),
    path.join(deps.dataDir, SKILL_HISTORY_DIR),
  ]) {
    for (const spaceId of await readdirOrEmpty(base)) {
      for (const userId of await readdirOrEmpty(path.join(base, spaceId))) {
        owners.set(`${spaceId}/${userId}`, { spaceId, userId });
      }
    }
  }
  for (const owner of owners.values()) {
    try {
      const user = await deps.prisma.user.findUnique({
        where: { id: owner.userId },
        select: { id: true },
      });
      if (user) await library.repair(owner);
    } catch (error) {
      getLogger().error(`[skills] could not sweep ${owner.spaceId}/${owner.userId}`, { error });
    }
  }
}

/** Sweeps now and every few hours, so an owner who stops writing is still kept tidy. */
export function scheduleSkillLibraryRepair(deps: SkillLibraryDeps): () => void {
  const sweep = () =>
    void repairSkillLibrary(deps).catch((error: unknown) =>
      getLogger().warn("[skills] sweep failed", { error }),
    );
  sweep();
  const timer = setInterval(sweep, SWEEP_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Account deletion: the user's skills, their versions and their trash, in every space. */
export async function purgeUserSkills(dataDir: string, userId: string): Promise<void> {
  for (const base of [
    path.join(dataDir, "skills", "user"),
    path.join(dataDir, SKILL_HISTORY_DIR),
  ]) {
    for (const spaceId of await readdirOrEmpty(base)) {
      await rm(path.join(base, spaceId, userId), { recursive: true, force: true });
    }
  }
}
