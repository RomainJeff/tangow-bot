import type { Stats } from "node:fs";
import { lstat, readdir, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type {
  HomeAdoption,
  HomeMoveBlocker,
  VolumeOwner,
  WorkerLifecycle,
} from "./worker-lifecycle.js";

export type DockerHomeMove =
  | { outcome: "already_on_volumes" }
  | { outcome: "refused"; code: HomeMoveBlocker | Exclude<HomeAdoption, "adopted"> }
  | { outcome: "adopted"; moved: string[] };

/**
 * Moves one idle Docker computer's home onto its volumes by renaming, on the storage that holds
 * both `DATA_DIR/homes` and `DATA_DIR/volumes`. A team home gives `bots/<botId>` to each bot's
 * private volume and `shared` to the space volume; a dedicated home gives every root entry but its
 * dot entries to its bot's private volume. What stays, dotfiles and browser profiles, is still
 * `/home/rakazo`. Nothing is copied or left behind, and a move interrupted after some renames
 * resumes: a target whose source is gone is done.
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
  if (computer.homeStorage === "volumes") return { outcome: "already_on_volumes" };
  if (computer.kind !== "docker") throw new Error(`${computerId} is not a Docker computer`);
  const { start } = await workers.inspectHomeMove(computerId);
  const reservation = await workers.reserveHomeMove(computerId);
  if ("blocker" in reservation) return { outcome: "refused", code: reservation.blocker };
  try {
    const team = computer.scope === "team";
    const volumeRef = async (owner: VolumeOwner) =>
      (await workers.ensureVolume(owner, context)).providerRef;
    const privates = new Map<string, string>();
    for (const bot of computer.bots) {
      privates.set(
        bot.id,
        await volumeRef({ kind: "bot_private", spaceId: computer.spaceId, botId: bot.id }),
      );
    }
    const shared = team
      ? await volumeRef({ kind: "space_shared", spaceId: computer.spaceId })
      : null;

    const data = path.resolve(deps.dataDir);
    const home = await realDirectory(path.join(data, "homes"), computer.homeKey);
    const volumes = await realDirectory(data, "volumes");
    if (!volumes) throw new Error(`${path.join(data, "volumes")} does not exist`);
    const target = async (ref: string) => {
      const directory = await realDirectory(volumes, ref);
      if (!directory) throw new Error(`The volume ${ref} has no directory`);
      return directory;
    };
    const moved: string[] = [];
    if (home && team) {
      const bots = await realDirectory(home, "bots");
      for (const [botId, ref] of privates) {
        if (bots && (await moveDirectory(path.join(bots, botId), await target(ref)))) {
          moved.push(`bots/${botId}`);
        }
      }
      if (shared && (await moveDirectory(path.join(home, "shared"), await target(shared)))) {
        moved.push("shared");
      }
    } else if (home) {
      const ref = privates.get(computer.homeKey);
      if (!ref)
        throw new Error(`The dedicated computer ${computerId} has no bot ${computer.homeKey}`);
      const into = await target(ref);
      for (const name of (await readdir(home)).sort()) {
        if (name.startsWith(".")) continue;
        await moveEntry(path.join(home, name), path.join(into, name));
        moved.push(name);
      }
    }

    const adoption = await workers.adoptVolumeHome(computerId, start, reservation.marker);
    if (adoption !== "adopted") return { outcome: "refused", code: adoption };
    return { outcome: "adopted", moved };
  } finally {
    await workers.releaseHomeMove(reservation.marker);
  }
}

/**
 * Moves the Docker homes still off volumes whose computer is idle now, every one or only
 * `computerId`. A busy one is skipped: it moves the next time it suspends.
 */
export async function moveIdleDockerHomes(
  deps: { prisma: PrismaClient; workers: WorkerLifecycle; dataDir: string },
  context: AdapterContext,
  computerId?: string,
): Promise<{ adopted: number; deferred: number }> {
  const computers = await deps.prisma.computer.findMany({
    where: { kind: "docker", homeStorage: "snapshot", ...(computerId && { id: computerId }) },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const counts = { adopted: 0, deferred: 0 };
  for (const { id } of computers) {
    const move = await moveDockerHomeToVolumes(deps, id, context);
    if (move.outcome === "adopted") counts.adopted += 1;
    if (move.outcome === "refused") {
      counts.deferred += 1;
      getLogger().info("docker home move deferred", { computerId: id, reason: move.code });
    }
  }
  return counts;
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  return lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

/** `parent/name` when it is a real directory, null when absent. A link there is refused. */
async function realDirectory(parent: string, name: string): Promise<string | null> {
  const directory = path.join(parent, name);
  const stats = await lstatOrNull(directory);
  if (!stats) return null;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${directory} is not a directory`);
  }
  return directory;
}

/**
 * Renames `source` onto the volume directory `target`, which `ensureVolume` created empty. A rename
 * replaces an empty directory. With the source gone, an earlier run already moved it; an empty
 * source next to a filled target is what a later boot recreated, and goes.
 */
async function moveDirectory(source: string, target: string): Promise<boolean> {
  const stats = await lstatOrNull(source);
  if (!stats) return false;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${source} is not a directory`);
  }
  const sourceEmpty = (await readdir(source)).length === 0;
  const targetEmpty = (await readdir(target)).length === 0;
  if (!targetEmpty) {
    if (sourceEmpty) {
      await rmdir(source);
      return false;
    }
    throw new Error(`Both ${source} and ${target} hold files`);
  }
  await renameOnStorage(source, target);
  return true;
}

/** One entry of a dedicated home, moved as it is: a link or a special file is never followed. */
async function moveEntry(source: string, target: string): Promise<void> {
  if (await lstatOrNull(target)) throw new Error(`${target} already exists`);
  await renameOnStorage(source, target);
}

async function renameOnStorage(source: string, target: string): Promise<void> {
  await rename(source, target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EXDEV") {
      throw new Error(
        `${source} and ${target} are on different storage: DATA_DIR/homes and DATA_DIR/volumes must share it`,
      );
    }
    throw error;
  });
}
