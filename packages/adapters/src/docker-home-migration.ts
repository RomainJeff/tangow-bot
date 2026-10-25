import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { HomeAdoption, HomeMoveBlocker, WorkerLifecycle } from "./worker-lifecycle.js";
import { HOME_MOVE_TTL_MS } from "./worker-lifecycle.js";

export type DockerHomeMove =
  | { outcome: "already_on_volumes" }
  | { outcome: "refused"; code: HomeMoveBlocker | Exclude<HomeAdoption, "adopted"> }
  | { outcome: "adopted"; moved: string[] };

/** A home whose content conflicts with its volumes: only that computer waits for an operator. */
export class DockerHomeConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerHomeConflict";
  }
}

/** Homes and volumes on different filesystems: no home can move until the deployment is fixed. */
export class DockerHomeStorageError extends Error {
  constructor(source: string, target: string) {
    super(
      `${source} and ${target} are on different filesystems. DATA_DIR/homes and DATA_DIR/volumes must live on the same DATA_DIR storage.`,
    );
    this.name = "DockerHomeStorageError";
  }
}

type Destination = { scope: "private"; botId: string } | { scope: "shared" };
/** A home entry still to move, as `lstat` saw it: never followed. */
type Leftover = { source: string; label: string; stats: Stats; destination: Destination };
type Rename =
  | { kind: "replace" | "into"; source: string; target: string; label: string }
  | { kind: "drop"; source: string; label: string };

const RENEW_AFTER_MS = HOME_MOVE_TTL_MS / 3;
/** A dot entry, so it stays in the home and is never one of the entries the move renames. */
export const HOME_MOVE_MARKER = ".rakazo-move-pending";

/**
 * Moves one idle Docker computer's home onto its volumes by renaming, on the storage that holds
 * both `DATA_DIR/homes` and `DATA_DIR/volumes`. A team home gives `bots/<botId>` to each bot's
 * private volume and `shared` to the space volume; a dedicated home gives every root entry but its
 * dot entries to its bot's private volume. Dotfiles and browser profiles stay in `/home/rakazo`.
 *
 * Every conflict is checked first. Then a marker file in the home directory records the move, the
 * computer adopts its volumes, the renames run, and the marker goes. While the marker exists the
 * computer refuses to boot (`homeMovePending`), so a half-moved home never runs, and the next sweep
 * resumes the move. A computer already on volumes is visited again only when it has the marker.
 */
export async function moveDockerHomeToVolumes(
  deps: { prisma: PrismaClient; workers: WorkerLifecycle; dataDir: string },
  computerId: string,
  context: AdapterContext,
): Promise<DockerHomeMove> {
  const { prisma, workers } = deps;
  const computer = await prisma.computer.findUniqueOrThrow({
    where: { id: computerId },
    select: {
      kind: true,
      scope: true,
      spaceId: true,
      homeKey: true,
      homeStorage: true,
      bots: { select: { id: true } },
    },
  });
  if (computer.kind !== "docker") throw new Error(`${computerId} is not a Docker computer`);
  const onVolumes = computer.homeStorage === "volumes";
  const data = path.resolve(deps.dataDir);
  const home = path.join(data, "homes", computer.homeKey);
  const layout = {
    team: computer.scope === "team",
    botIds: computer.bots.map((bot) => bot.id),
    homeKey: computer.homeKey,
  };
  if (onVolumes && !(await homeMovePending(home))) return { outcome: "already_on_volumes" };

  const { start } = await workers.inspectHomeMove(computerId);
  const reservation = await workers.reserveHomeMove(computerId);
  if ("blocker" in reservation) return { outcome: "refused", code: reservation.blocker };
  let renewedAt = Date.now();
  // A boot waits while the reservation holds, so it must not lapse in the middle of the renames.
  const keepReserved = async () => {
    if (Date.now() - renewedAt < RENEW_AFTER_MS) return;
    const started = Date.now();
    if (!(await workers.renewHomeMove(reservation.marker))) {
      throw new Error(`The home move reservation of ${computerId} expired`);
    }
    renewedAt = started;
  };
  try {
    const refs = new Map<string, string>();
    for (const botId of layout.botIds) {
      await keepReserved();
      const owner = { kind: "bot_private" as const, spaceId: computer.spaceId, botId };
      refs.set(botId, (await workers.ensureVolume(owner, context)).providerRef);
    }
    if (layout.team) {
      const owner = { kind: "space_shared" as const, spaceId: computer.spaceId };
      refs.set("", (await workers.ensureVolume(owner, context)).providerRef);
    }
    const volumes = await realDirectory(data, "volumes");
    const volumeOf = async (destination: Destination) => {
      const ref = refs.get(destination.scope === "shared" ? "" : destination.botId);
      const directory = ref && (await realDirectory(volumes, ref));
      if (!directory) throw new Error(`No volume directory for ${JSON.stringify(destination)}`);
      return directory;
    };
    // Every conflict is found before anything moves or the computer adopts its volumes.
    const renames: Rename[] = [];
    for (const leftover of await leftovers(home, layout)) {
      renames.push(await planRename(leftover, await volumeOf(leftover.destination)));
    }

    if (renames.length > 0) await writeMarker(home);
    if (!onVolumes) {
      await keepReserved();
      const adoption = await workers.adoptVolumeHome(computerId, start, reservation.marker);
      if (adoption !== "adopted") {
        // Nothing moved yet: the computer boots on its whole home again.
        if (renames.length > 0) await unlink(path.join(home, HOME_MOVE_MARKER));
        return { outcome: "refused", code: adoption };
      }
    }
    const moved: string[] = [];
    for (const step of renames) {
      await keepReserved();
      if (step.kind === "drop") await rmdir(step.source);
      else await renameOnStorage(step.source, step.target);
      if (step.kind !== "drop") moved.push(step.label);
    }
    await rm(path.join(home, HOME_MOVE_MARKER), { force: true });
    return { outcome: "adopted", moved };
  } finally {
    await workers.releaseHomeMove(reservation.marker);
  }
}

/**
 * Moves the Docker homes left to move, every one or only `computerId`: those still off volumes,
 * and those whose home still holds the move marker. A busy computer, or one whose home conflicts
 * with its volumes, is logged and skipped; the others still move. Any other error throws: storage
 * the move cannot use (EXDEV, EACCES, EROFS, ENOSPC, EIO) or a database failure.
 */
export async function moveIdleDockerHomes(
  deps: { prisma: PrismaClient; workers: WorkerLifecycle; dataDir: string },
  context: AdapterContext,
  computerId?: string,
): Promise<{ adopted: number; deferred: number }> {
  const computers = await deps.prisma.computer.findMany({
    where: { kind: "docker", ...(computerId && { id: computerId }) },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const counts = { adopted: 0, deferred: 0 };
  for (const { id } of computers) {
    try {
      const move = await moveDockerHomeToVolumes(deps, id, context);
      if (move.outcome === "adopted") counts.adopted += 1;
      if (move.outcome === "refused") {
        counts.deferred += 1;
        getLogger().info("docker home move deferred", { computerId: id, reason: move.code });
      }
    } catch (error) {
      if (!isHomeConflict(error)) throw error;
      counts.deferred += 1;
      getLogger().warn("docker home move deferred", {
        computerId: id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return counts;
}

/** What a home or a volume a guest shaped can raise: only that computer waits. */
const CONFLICT_CODES = new Set(["ENOTEMPTY", "EEXIST", "ENOTDIR", "EISDIR"]);

function isHomeConflict(error: unknown): boolean {
  return (
    error instanceof DockerHomeConflict ||
    CONFLICT_CODES.has((error as NodeJS.ErrnoException | undefined)?.code ?? "")
  );
}

/** Records, inside the home itself, that its move started; never through a link a guest made. */
async function writeMarker(home: string): Promise<void> {
  const marker = path.join(home, HOME_MOVE_MARKER);
  try {
    const handle = await open(
      marker,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.close();
  } catch (error) {
    // A move that stopped before resumes on its own marker.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await lstat(marker)).isFile()) throw new DockerHomeConflict(`${marker} is not a file`);
  }
}

/** Whether a Docker home's move onto its volumes started and has not finished. */
export async function homeMovePending(home: string): Promise<boolean> {
  return (await lstatOrNull(path.join(home, HOME_MOVE_MARKER))) !== null;
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  return lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function realDirectory(parent: string, name: string): Promise<string> {
  const directory = path.join(parent, name);
  const stats = await lstatOrNull(directory);
  if (!stats?.isDirectory()) throw new Error(`${directory} is not a directory`);
  return directory;
}

/**
 * What the home still holds for its volumes. The home root and `bots` are descended only when they
 * are real directories, so a link a guest planted there is never followed: a `bots` that is not a
 * directory holds no bot folder. A dedicated home keeps its dot entries, the marker included.
 */
async function leftovers(
  home: string,
  layout: { team: boolean; botIds: string[]; homeKey: string },
): Promise<Leftover[]> {
  const root = await lstatOrNull(home);
  if (!root) return [];
  if (!root.isDirectory()) throw new DockerHomeConflict(`${home} is not a directory`);
  const found: Leftover[] = [];
  const add = async (source: string, label: string, destination: Destination) => {
    const stats = await lstatOrNull(source);
    if (stats) found.push({ source, label, stats, destination });
  };
  if (!layout.team) {
    for (const name of (await readdir(home)).sort()) {
      if (name.startsWith(".")) continue;
      await add(path.join(home, name), name, { scope: "private", botId: layout.homeKey });
    }
    return found;
  }
  if ((await lstatOrNull(path.join(home, "bots")))?.isDirectory()) {
    for (const botId of [...layout.botIds].sort()) {
      await add(path.join(home, "bots", botId), `bots/${botId}`, { scope: "private", botId });
    }
  }
  await add(path.join(home, "shared"), "shared", { scope: "shared" });
  return found;
}

/**
 * How one leftover reaches its volume. A team folder replaces the empty volume directory; an empty
 * one a later boot recreated next to a moved one goes. A link or a file there, and each entry of a
 * dedicated home, moves into the volume as it is.
 */
async function planRename(leftover: Leftover, volume: string): Promise<Rename> {
  const { source, label, stats } = leftover;
  const team = label === "shared" || label.startsWith("bots/");
  if (team && stats.isDirectory()) {
    const sourceEmpty = (await readdir(source)).length === 0;
    const volumeEmpty = (await readdir(volume)).length === 0;
    if (sourceEmpty) return { kind: "drop", source, label };
    if (!volumeEmpty) throw new DockerHomeConflict(`Both ${source} and ${volume} hold files`);
    return { kind: "replace", source, target: volume, label };
  }
  const target = path.join(volume, path.basename(source));
  if (await lstatOrNull(target)) throw new DockerHomeConflict(`${target} already exists`);
  return { kind: "into", source, target, label };
}

async function renameOnStorage(source: string, target: string): Promise<void> {
  await rename(source, target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EXDEV") throw new DockerHomeStorageError(source, target);
    throw error;
  });
}
