import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  PortableFile,
  VolumeEntry,
  VolumeFiles,
} from "@rakazo/adapter-kit";
import { fileMode, isPortablePath } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { shouldSkipPortableWorkspaceFile } from "./computer-workspace.js";
import type { HomeAdoption, VolumeOwner, WorkerLifecycle } from "./worker-lifecycle.js";
import { HOME_MOVE_TTL_MS } from "./worker-lifecycle.js";

const HOME_MOVE_RENEW_MS = 10_000;
const HOME_MOVE_RENEW_TIMEOUT_MS = 5_000;
const HOME_MOVE_SAFETY_MS = 5_000;

/** Where a home file lands: its bot's private volume, or the space's shared volume. */
export type HomeDestination = { scope: "private"; botId: string } | { scope: "shared" };

export type HomeFile = {
  homePath: string;
  destination: HomeDestination;
  volumePath: string;
  size: number;
  sha256: string;
  /** Permission bits (`0o777`). */
  mode: number;
};

/**
 * Why a home entry stays only in the AgentHomeStore original: outside every destination, a path
 * a volume cannot hold, one of several files bound for the same volume path, an entry that is not
 * a regular file or a directory with something in it, or a file the export did not yield (it
 * walks a symlinked directory once, under the link's name).
 */
export type NotCopied = {
  homePath: string;
  kind:
    | "unmapped"
    | "invalid_path"
    | "duplicate"
    | "symlink"
    | "empty_dir"
    | "special"
    | "not_exported";
};

export type ManifestVolume = {
  destination: HomeDestination;
  volumeId: string | null;
  providerRef: string | null;
};

/** The record of one move, written by the operator's command. Also the dry run's plan. */
export type HomeManifest = {
  version: 1;
  computerId: string;
  homeKey: string;
  scope: "team" | "dedicated";
  homeRevision: string;
  startedAt: string;
  adoptedAt: string | null;
  volumes: ManifestVolume[];
  files: Array<HomeFile & { volumeId: string | null }>;
  notCopied: NotCopied[];
};

/** What a target volume holds that the move did not plan, and which planned files it lacks. */
export type VolumeConflict = {
  destination: HomeDestination;
  volumeId: string | null;
  foreign: string[];
  missing: string[];
};

export type HomeMoveRefusal =
  | { code: Exclude<HomeAdoption, "adopted"> }
  | { code: "not_copied"; entries: NotCopied[] }
  | { code: "volume_not_empty"; volumes: VolumeConflict[] }
  | { code: "home_changed"; paths: string[] }
  | { code: "copy_mismatch"; volumes: VolumeConflict[] };

export type HomeMoveReport =
  | { outcome: "already_on_volumes" }
  | { outcome: "planned"; manifest: HomeManifest }
  | { outcome: "refused"; refusal: HomeMoveRefusal; manifest?: HomeManifest }
  | { outcome: "adopted"; manifest: HomeManifest };

export type HomeMoveOptions = {
  computerId: string;
  /** Plans and checks without creating, writing or adopting anything. */
  dryRun: boolean;
  /** Leaves every entry it cannot copy in the original instead of refusing. */
  leaveUnmapped: boolean;
  /**
   * Where the manifest is written once the move creates anything, even when it stops on an
   * error. Must not exist yet. Ignored on a dry run.
   */
  manifestPath: string | null;
};

type HomeComputer = {
  id: string;
  scope: "team" | "dedicated";
  spaceId: string;
  homeKey: string;
  homeStorage: string;
  botIds: Set<string>;
};

type TargetVolume = ManifestVolume & { files: HomeFile[] };

type HomePlan = {
  planned: HomeFile[];
  notCopied: NotCopied[];
  /** Content and mode of every file the export yielded, to compare the copy's export with. */
  exported: Map<string, string>;
  links: string[];
};

/**
 * Maps a home path to its volume. A team home holds `shared/` and `bots/<botId>/` for each bot on
 * the computer; a dedicated home is its bot's private volume as a whole.
 */
function homeDestination(
  computer: Pick<HomeComputer, "scope" | "homeKey" | "botIds">,
  homePath: string,
): { destination: HomeDestination; volumePath: string } | null {
  if (computer.scope === "dedicated") {
    return { destination: { scope: "private", botId: computer.homeKey }, volumePath: homePath };
  }
  const [root, ...rest] = homePath.split("/");
  if (root === "shared" && rest.length > 0) {
    return { destination: { scope: "shared" }, volumePath: rest.join("/") };
  }
  const [botId, ...inside] = rest;
  if (root === "bots" && botId && computer.botIds.has(botId) && inside.length > 0) {
    return { destination: { scope: "private", botId }, volumePath: inside.join("/") };
  }
  return null;
}

/** The home's files, without browser caches and without what the export read through a symlink. */
async function* homeFiles(
  home: AgentHomeStore,
  homeKey: string,
  links: string[],
  context: AdapterContext,
): AsyncIterable<PortableFile & { fingerprint: string; sha256: string }> {
  for await (const file of home.exportHome(homeKey, context)) {
    if (shouldSkipPortableWorkspaceFile(file.path)) continue;
    if (links.some((link) => file.path === link || file.path.startsWith(`${link}/`))) continue;
    const hash = sha256(file.content);
    yield { ...file, sha256: hash, fingerprint: `${hash} ${fileMode(file).toString(8)}` };
  }
}

async function planHome(
  home: AgentHomeStore,
  computer: HomeComputer,
  context: AdapterContext,
): Promise<HomePlan> {
  const everything = await home.listTree(computer.homeKey, context);
  // A directory holding only skipped caches is not empty: those caches are meant to go.
  const parents = new Set(everything.flatMap((entry) => ancestors(entry.path)));
  const tree = everything.filter((entry) => !shouldSkipPortableWorkspaceFile(entry.path));
  const links = tree.filter((entry) => entry.kind === "symlink").map((entry) => entry.path);
  const notCopied = tree.flatMap((entry): NotCopied[] => {
    if (entry.kind === "symlink") return [{ homePath: entry.path, kind: "symlink" }];
    if (entry.kind === "other") return [{ homePath: entry.path, kind: "special" }];
    if (entry.kind === "dir" && !parents.has(entry.path)) {
      return [{ homePath: entry.path, kind: "empty_dir" }];
    }
    return [];
  });

  const exported = new Map<string, string>();
  const mapped: HomeFile[] = [];
  for await (const file of homeFiles(home, computer.homeKey, links, context)) {
    exported.set(file.path, file.fingerprint);
    const valid = isPortablePath(file.path);
    const target = valid ? homeDestination(computer, file.path) : null;
    if (!target) notCopied.push({ homePath: file.path, kind: valid ? "unmapped" : "invalid_path" });
    else {
      mapped.push({
        ...target,
        homePath: file.path,
        size: file.content.byteLength,
        sha256: file.sha256,
        mode: fileMode(file),
      });
    }
  }
  const destinationKey = (file: HomeFile) =>
    `${file.destination.scope === "private" ? file.destination.botId : ""}/${file.volumePath}`;
  const bound = new Map<string, number>();
  for (const file of mapped) {
    bound.set(destinationKey(file), (bound.get(destinationKey(file)) ?? 0) + 1);
  }
  const planned: HomeFile[] = [];
  for (const file of mapped) {
    if (bound.get(destinationKey(file)) === 1) planned.push(file);
    else notCopied.push({ homePath: file.homePath, kind: "duplicate" });
  }
  for (const entry of tree) {
    if (entry.kind === "file" && !exported.has(entry.path)) {
      notCopied.push({ homePath: entry.path, kind: "not_exported" });
    }
  }
  notCopied.sort((a, b) => a.homePath.localeCompare(b.homePath));
  return { planned, notCopied, exported, links };
}

/** An E2B computer whose home is still on snapshots, which only the in-process path can run. */
export class E2BHomesNotMigrated extends Error {
  constructor(readonly computerIds: string[]) {
    super(
      [
        `${computerIds.length} E2B computer${computerIds.length === 1 ? " keeps its" : "s keep their"} home on snapshots: ${computerIds.join(", ")}.`,
        "Move each one onto volumes before starting the API:",
        "  pnpm exec tsx scripts/migrate-home-to-volumes.ts --computer <id> --manifest <path>",
        "See docs/self-host-e2b-workers.md#move-existing-homes-onto-volumes.",
      ].join("\n"),
    );
    this.name = "E2BHomesNotMigrated";
  }
}

/** Refuses to go on while an E2B computer's home is still on snapshots. */
export async function assertE2BHomesOnVolumes(prisma: PrismaClient): Promise<void> {
  const computers = await prisma.computer.findMany({
    where: { kind: "e2b", homeStorage: "snapshot" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  if (computers.length > 0) throw new E2BHomesNotMigrated(computers.map(({ id }) => id));
}

/** Read-only planning before an operator agrees to an upgrade, including Docker source homes. */
export async function previewHomeVolumeMove(
  deps: { prisma: PrismaClient; home: AgentHomeStore },
  computerId: string,
  context: AdapterContext,
) {
  const computer = await readComputer(deps.prisma, computerId);
  const plan = await planHome(deps.home, computer, context);
  return {
    files: plan.planned.length,
    bytes: plan.planned.reduce((total, file) => total + file.size, 0),
    notCopied: plan.notCopied,
  };
}

/**
 * What already sits on a target volume, against what the move plans for it. A file the move
 * planned with the same content and mode is not foreign, so a move interrupted mid-copy resumes.
 */
function compareVolume(
  planned: HomeFile[],
  entries: VolumeEntry[],
  hashes: ReadonlyMap<string, string>,
): { foreign: string[]; missing: HomeFile[] } {
  const byPath = new Map(planned.map((file) => [file.volumePath, file]));
  const directories = new Set(planned.flatMap((file) => ancestors(file.volumePath)));
  const present = new Set<string>();
  const foreign: string[] = [];
  for (const entry of entries) {
    const file = byPath.get(entry.path);
    const ours =
      entry.kind === "dir"
        ? directories.has(entry.path)
        : entry.kind === "file" &&
          file !== undefined &&
          hashes.get(entry.path) === file.sha256 &&
          entry.mode === file.mode;
    if (ours && entry.kind === "file") present.add(entry.path);
    if (!ours) foreign.push(entry.path);
  }
  return { foreign, missing: planned.filter((file) => !present.has(file.volumePath)) };
}

/**
 * Moves one computer's home from AgentHomeStore snapshots onto its bots' private volumes and the
 * space's shared volume, then adopts it. Never writes over a file it did not plan, verifies every
 * copied file by hash and mode before adopting, and leaves the AgentHomeStore copy untouched.
 */
export async function moveHomeToVolumes(
  deps: {
    prisma: PrismaClient;
    home: AgentHomeStore;
    files: VolumeFiles;
    workers: WorkerLifecycle;
  },
  options: HomeMoveOptions,
  context: AdapterContext,
): Promise<HomeMoveReport> {
  const { prisma, home, files, workers } = deps;
  const manifestPath = options.dryRun ? null : options.manifestPath;
  if (manifestPath) await assertManifestFree(manifestPath);
  const startedAt = new Date().toISOString();
  const computer = await readComputer(prisma, options.computerId);
  if (computer.homeStorage === "volumes") return { outcome: "already_on_volumes" };
  const { blocker, start } = await workers.inspectHomeMove(computer.id);
  if (blocker) return { outcome: "refused", refusal: { code: blocker } };

  const reservationStarted = performance.now();
  const reservation = options.dryRun ? null : await workers.reserveHomeMove(computer.id);
  if (reservation && "blocker" in reservation) {
    return { outcome: "refused", refusal: { code: reservation.blocker } };
  }
  const abort = new AbortController();
  context = { ...context, signal: AbortSignal.any([context.signal, abort.signal]) };
  let deadline = reservationStarted + HOME_MOVE_TTL_MS - HOME_MOVE_SAFETY_MS;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const expire = () => abort.abort(new Error("Home move reservation expired"));
  const assertReservation = () => {
    if (reservation && performance.now() >= deadline) expire();
    context.signal.throwIfAborted();
  };
  const armDeadline = () => {
    clearTimeout(deadlineTimer);
    const remaining = deadline - performance.now();
    if (remaining <= 0) expire();
    else {
      deadlineTimer = setTimeout(expire, remaining);
      deadlineTimer.unref();
    }
  };
  if (reservation) armDeadline();
  let pendingHeartbeat = Promise.resolve();
  const heartbeat = reservation
    ? setInterval(() => {
        pendingHeartbeat = pendingHeartbeat
          .then(async () => {
            assertReservation();
            const started = performance.now();
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
              const renewed = await Promise.race([
                workers.renewHomeMove(reservation.marker),
                new Promise<never>((_, reject) => {
                  timeout = setTimeout(
                    () => reject(new Error("Home move reservation renewal timed out")),
                    HOME_MOVE_RENEW_TIMEOUT_MS,
                  );
                }),
              ]);
              assertReservation();
              if (!renewed) throw new Error("Home move reservation expired");
              // Count from the request's start: time spent waiting for the database is not a lease.
              deadline = started + HOME_MOVE_TTL_MS - HOME_MOVE_SAFETY_MS;
              armDeadline();
            } finally {
              clearTimeout(timeout);
            }
          })
          .catch((error: unknown) => abort.abort(error));
      }, HOME_MOVE_RENEW_MS)
    : null;
  heartbeat?.unref();
  try {
    assertReservation();
    const plan = await planHome(home, computer, context);
    if (plan.notCopied.length > 0 && !options.leaveUnmapped) {
      return { outcome: "refused", refusal: { code: "not_copied", entries: plan.notCopied } };
    }

    const targets: TargetVolume[] = destinationsOf(computer, plan.planned).map((destination) => ({
      destination,
      volumeId: null,
      providerRef: null,
      files: plan.planned.filter((file) => sameDestination(file.destination, destination)),
    }));
    let adoptedAt: string | null = null;
    const manifest = (): HomeManifest => ({
      version: 1,
      computerId: computer.id,
      homeKey: computer.homeKey,
      scope: computer.scope,
      homeRevision: start.homeRevision,
      startedAt,
      adoptedAt,
      volumes: targets.map(({ destination, volumeId, providerRef }) => ({
        destination,
        volumeId,
        providerRef,
      })),
      files: targets.flatMap((target) =>
        target.files.map((file) => ({ ...file, volumeId: target.volumeId })),
      ),
      notCopied: plan.notCopied,
    });

    try {
      for (const target of targets) {
        assertReservation();
        const existing = options.dryRun
          ? await existingVolume(prisma, computer, target.destination)
          : await workers.ensureVolume(ownerOf(computer, target.destination), context);
        target.volumeId = existing?.volumeId ?? null;
        target.providerRef = existing?.providerRef ?? null;
      }
      const before = await inspectTargets(files, targets, context);
      const occupied = before.filter((volume) => volume.foreign.length > 0);
      if (occupied.length > 0) {
        return {
          outcome: "refused",
          refusal: { code: "volume_not_empty", volumes: occupied.map(conflictOf) },
          manifest: manifest(),
        };
      }
      if (options.dryRun) return { outcome: "planned", manifest: manifest() };

      const toWrite = new Map(
        before.flatMap(({ target, missing }) =>
          missing.map((file) => [file.homePath, { file, volumeRef: target.providerRef }] as const),
        ),
      );
      // Every file is compared with the plan, not only those still to write, so a resumed move
      // never adopts copies of a home that changed since an earlier run wrote them.
      const changed: string[] = [];
      const seen = new Set<string>();
      for await (const source of homeFiles(home, computer.homeKey, plan.links, context)) {
        seen.add(source.path);
        if (plan.exported.get(source.path) !== source.fingerprint) {
          changed.push(source.path);
          continue;
        }
        assertReservation();
        const pending = toWrite.get(source.path);
        if (!pending) continue;
        if (!pending.volumeRef) throw new Error(`No provisioned volume for ${source.path}`);
        const { volumePath, mode } = pending.file;
        await files.write(
          pending.volumeRef,
          { path: volumePath, content: source.content, mode },
          context,
        );
      }
      changed.push(...[...plan.exported.keys()].filter((path) => !seen.has(path)));
      if (changed.length > 0) {
        return {
          outcome: "refused",
          refusal: { code: "home_changed", paths: changed.sort() },
          manifest: manifest(),
        };
      }

      const after = await inspectTargets(files, targets, context);
      const mismatched = after.filter(
        (volume) => volume.foreign.length > 0 || volume.missing.length > 0,
      );
      if (mismatched.length > 0) {
        return {
          outcome: "refused",
          refusal: { code: "copy_mismatch", volumes: mismatched.map(conflictOf) },
          manifest: manifest(),
        };
      }

      assertReservation();
      const adoption = await workers.adoptVolumeHome(computer.id, start, reservation?.marker);
      if (adoption !== "adopted") {
        return { outcome: "refused", refusal: { code: adoption }, manifest: manifest() };
      }
      adoptedAt = new Date().toISOString();
      return { outcome: "adopted", manifest: manifest() };
    } finally {
      if (manifestPath) {
        await writeFile(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`, { flag: "wx" });
      }
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await pendingHeartbeat;
    clearTimeout(deadlineTimer);
    if (reservation) await workers.releaseHomeMove(reservation.marker);
  }
}

async function assertManifestFree(path: string): Promise<void> {
  await access(dirname(path), constants.W_OK);
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists) throw new Error(`The manifest ${path} already exists`);
}

async function readComputer(prisma: PrismaClient, computerId: string): Promise<HomeComputer> {
  const computer = await prisma.computer.findUniqueOrThrow({
    where: { id: computerId },
    select: {
      id: true,
      scope: true,
      spaceId: true,
      homeKey: true,
      homeStorage: true,
      bots: { select: { id: true } },
    },
  });
  if (computer.scope !== "team" && computer.scope !== "dedicated") {
    throw new Error(`Unknown computer scope: ${computer.scope}`);
  }
  return {
    ...computer,
    scope: computer.scope,
    botIds: new Set(computer.bots.map((bot) => bot.id)),
  };
}

/** Every volume the adopted home needs, even one no file lands on. */
function destinationsOf(computer: HomeComputer, planned: HomeFile[]): HomeDestination[] {
  const botIds = new Set(computer.botIds);
  for (const file of planned) {
    if (file.destination.scope === "private") botIds.add(file.destination.botId);
  }
  const privates = [...botIds]
    .sort()
    .map((botId): HomeDestination => ({ scope: "private", botId }));
  return computer.scope === "team" ? [...privates, { scope: "shared" }] : privates;
}

function ownerOf(computer: HomeComputer, destination: HomeDestination): VolumeOwner {
  return destination.scope === "shared"
    ? { kind: "space_shared", spaceId: computer.spaceId }
    : { kind: "bot_private", spaceId: computer.spaceId, botId: destination.botId };
}

async function existingVolume(
  prisma: PrismaClient,
  computer: HomeComputer,
  destination: HomeDestination,
): Promise<{ volumeId: string; providerRef: string | null } | null> {
  const volume = await prisma.volume.findFirst({
    where:
      destination.scope === "shared"
        ? { kind: "space_shared", spaceId: computer.spaceId }
        : { kind: "bot_private", botId: destination.botId },
    select: { id: true, providerRef: true },
  });
  return volume ? { volumeId: volume.id, providerRef: volume.providerRef } : null;
}

type Inspection = { target: TargetVolume; foreign: string[]; missing: HomeFile[] };

/** A volume not provisioned yet holds nothing, so every planned file is missing from it. */
async function inspectTargets(
  files: VolumeFiles,
  targets: TargetVolume[],
  context: AdapterContext,
): Promise<Inspection[]> {
  const inspections: Inspection[] = [];
  for (const target of targets) {
    const ref = target.providerRef;
    const entries = ref ? await files.list(ref, context) : [];
    const planned = new Set(target.files.map((file) => file.volumePath));
    const hashes = new Map<string, string>();
    for (const entry of entries) {
      if (ref && entry.kind === "file" && planned.has(entry.path)) {
        hashes.set(entry.path, sha256(await files.read(ref, entry.path, context)));
      }
    }
    inspections.push({ target, ...compareVolume(target.files, entries, hashes) });
  }
  return inspections;
}

function conflictOf({ target, foreign, missing }: Inspection): VolumeConflict {
  return {
    destination: target.destination,
    volumeId: target.volumeId,
    foreign: foreign.sort(),
    missing: missing.map((file) => file.volumePath).sort(),
  };
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function sameDestination(a: HomeDestination, b: HomeDestination): boolean {
  return a.scope === "shared" ? b.scope === "shared" : b.scope === "private" && a.botId === b.botId;
}

function ancestors(path: string): string[] {
  const segments = path.split("/").slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}
