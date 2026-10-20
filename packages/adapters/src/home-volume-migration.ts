import { createHash } from "node:crypto";
import type { AdapterContext, AgentHomeStore, VolumeEntry, VolumeFiles } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { shouldSkipPortableWorkspaceFile } from "./computer-workspace.js";
import type {
  HomeAdoption,
  HomeMoveBlocker,
  VolumeOwner,
  WorkerLifecycle,
} from "./worker-lifecycle.js";

/** Where a home file lands: its bot's private volume, or the space's shared volume. */
export type HomeDestination = { scope: "private"; botId: string } | { scope: "shared" };

export type HomeFile = {
  homePath: string;
  destination: HomeDestination;
  volumePath: string;
  size: number;
  sha256: string;
  executable: boolean;
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
  /** Files outside every destination, kept only in the AgentHomeStore original. */
  leftInHome: string[];
};

/** What a target volume holds that the move did not plan, and which planned files it lacks. */
export type VolumeConflict = {
  destination: HomeDestination;
  volumeId: string | null;
  foreign: string[];
  missing: string[];
};

export type HomeMoveRefusal =
  | { code: HomeMoveBlocker | "volume_missing" }
  | { code: "unmapped_files"; paths: string[] }
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
  /** Leaves files outside every destination in the original instead of refusing. */
  leaveUnmapped: boolean;
};

type HomeComputer = {
  id: string;
  scope: "team" | "dedicated";
  spaceId: string;
  homeKey: string;
  homeRevision: string;
  homeStorage: string;
  botIds: Set<string>;
};

type TargetVolume = ManifestVolume & { files: HomeFile[] };

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
          entry.executable === file.executable;
    if (ours && entry.kind === "file") present.add(entry.path);
    if (!ours) foreign.push(entry.path);
  }
  return { foreign, missing: planned.filter((file) => !present.has(file.volumePath)) };
}

/**
 * Moves one computer's home from AgentHomeStore snapshots onto its bots' private volumes and the
 * space's shared volume, then adopts it. Never writes over a file it did not plan, verifies every
 * copied file by hash before adopting, and leaves the AgentHomeStore copy untouched.
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
  const startedAt = new Date().toISOString();
  const computer = await readComputer(prisma, options.computerId);
  if (computer.homeStorage === "volumes") return { outcome: "already_on_volumes" };
  const blocker = await workers.homeMoveBlocker(computer.id);
  if (blocker) return { outcome: "refused", refusal: { code: blocker } };

  const planned: HomeFile[] = [];
  const unmapped: string[] = [];
  for await (const file of home.exportHome(computer.homeKey, context)) {
    if (shouldSkipPortableWorkspaceFile(file.path)) continue;
    const target = homeDestination(computer, file.path);
    if (!target) unmapped.push(file.path);
    else {
      planned.push({
        ...target,
        homePath: file.path,
        size: file.content.byteLength,
        sha256: sha256(file.content),
        executable: Boolean(file.executable),
      });
    }
  }
  if (unmapped.length > 0 && !options.leaveUnmapped) {
    return { outcome: "refused", refusal: { code: "unmapped_files", paths: unmapped.sort() } };
  }

  const targets: TargetVolume[] = destinationsOf(computer, planned).map((destination) => ({
    destination,
    volumeId: null,
    providerRef: null,
    files: planned.filter((file) => sameDestination(file.destination, destination)),
  }));
  const manifest = (adoptedAt: string | null): HomeManifest => ({
    version: 1,
    computerId: computer.id,
    homeKey: computer.homeKey,
    scope: computer.scope,
    homeRevision: computer.homeRevision,
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
    leftInHome: unmapped.sort(),
  });

  for (const target of targets) {
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
      manifest: manifest(null),
    };
  }
  if (options.dryRun) return { outcome: "planned", manifest: manifest(null) };

  const toWrite = new Map(
    before.flatMap(({ target, missing }) =>
      missing.map((file) => [file.homePath, { file, volumeRef: target.providerRef }] as const),
    ),
  );
  const changed: string[] = [];
  for await (const source of home.exportHome(computer.homeKey, context)) {
    const pending = toWrite.get(source.path);
    if (!pending) continue;
    toWrite.delete(source.path);
    if (sha256(source.content) !== pending.file.sha256) {
      changed.push(source.path);
      continue;
    }
    const { volumePath, executable } = pending.file;
    if (!pending.volumeRef) throw new Error(`No provisioned volume for ${source.path}`);
    await files.write(
      pending.volumeRef,
      { path: volumePath, content: source.content, executable },
      context,
    );
  }
  changed.push(...toWrite.keys());
  if (changed.length > 0) {
    return {
      outcome: "refused",
      refusal: { code: "home_changed", paths: changed.sort() },
      manifest: manifest(null),
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
      manifest: manifest(null),
    };
  }

  const adoption: HomeAdoption = await workers.adoptVolumeHome(computer.id);
  if (adoption !== "adopted") {
    return { outcome: "refused", refusal: { code: adoption }, manifest: manifest(null) };
  }
  return { outcome: "adopted", manifest: manifest(new Date().toISOString()) };
}

async function readComputer(prisma: PrismaClient, computerId: string): Promise<HomeComputer> {
  const computer = await prisma.computer.findUniqueOrThrow({
    where: { id: computerId },
    select: {
      id: true,
      scope: true,
      spaceId: true,
      homeKey: true,
      homeRevision: true,
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
