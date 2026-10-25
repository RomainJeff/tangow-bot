import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  SandboxProvider,
  VolumeFiles,
  WorkerProvider,
} from "@rakazo/adapter-kit";
import { isPortablePath } from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES, workerEnsureDeadline } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { toComputerRef } from "./computer-support.js";
import { checkpointComputerWorkspace } from "./computer-workspace.js";
import type { DockerWorkerProvider } from "./docker-worker.js";
import type {
  HomeDestination,
  HomeFile,
  NotCopied,
  TargetVolume,
  VolumeConflict,
} from "./home-volume-migration.js";
import { conflictOf, inspectTargets } from "./home-volume-migration.js";
import type { HomeMoveBlocker } from "./worker-lifecycle.js";
import { createWorkerLifecycle, HOME_MOVE_TTL_MS } from "./worker-lifecycle.js";

/** A stopped computer nobody controls or executes on, out of maintenance. */
const RELEASED = {
  screenUrl: null,
  controlHolder: "none",
  controlLeaseId: null,
  controlLeaseExpiresAt: null,
  controlBotId: null,
  controlRunId: null,
  executionRunId: null,
  executionBotId: null,
  executionLeaseExpiresAt: null,
  maintenanceId: null,
  homeMoveExpiresAt: null,
} as const;

/** A computer moved to E2B, stopped, with nothing attached to its previous provider. */
const STOPPED_ON_E2B = { ...RELEASED, kind: "e2b", state: "stopped", providerRef: null } as const;

/** Operator-only preparation while application services are stopped; copying remains the home mover's job. */
export async function prepareHomeForE2B(
  deps: { prisma: PrismaClient; home: AgentHomeStore; source: SandboxProvider },
  computerId: string,
  context: AdapterContext,
): Promise<void> {
  const { prisma, home, source } = deps;
  const scope = await prisma.computer.findUniqueOrThrow({
    where: { id: computerId },
    select: { spaceId: true },
  });
  const stale = await prisma.computer.findMany({
    where: {
      spaceId: scope.spaceId,
      maintenanceId: { startsWith: "home-move:" },
      homeMoveExpiresAt: { lte: new Date() },
    },
    select: { id: true },
  });
  const lifecycle = createWorkerLifecycle({ prisma, provider: null });
  for (const computer of stale) await lifecycle.clearStaleHomeMove(computer.id);
  const marker = `home-move:${computerId}:${randomUUID()}`;
  const original = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM computers WHERE id = ${computerId} FOR UPDATE`;
    const computer = await tx.computer.findUniqueOrThrow({ where: { id: computerId } });
    // A Docker computer on volumes is only stopped here: carryDockerVolumesToE2B copies them.
    if (computer.homeStorage === "volumes" && computer.kind !== "docker") return null;
    if (computer.kind !== "docker" && computer.kind !== "e2b")
      throw new Error("Unsupported source computer provider");
    const now = new Date();
    const active = await tx.run.count({
      where: { spaceId: computer.spaceId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    });
    const controlled = await tx.computer.count({
      where: {
        spaceId: computer.spaceId,
        OR: [
          {
            controlHolder: "user",
            controlLeaseId: { not: null },
            controlLeaseExpiresAt: { gt: now },
          },
          { maintenanceId: { not: null } },
          { executionLeases: { some: { expiresAt: { gt: now } } } },
        ],
      },
    });
    if (active || controlled)
      throw new Error("Computer upgrade refused: active run, control, lease or maintenance");
    await tx.computer.update({
      where: { id: computerId },
      data: {
        maintenanceId: marker,
        homeMoveExpiresAt: new Date(Date.now() + 60000),
      },
    });
    return computer;
  });
  if (!original) return;
  const abort = new AbortController();
  const ctx = { ...context, signal: AbortSignal.any([context.signal, abort.signal]) };
  let renewing = Promise.resolve();
  const heartbeat = setInterval(() => {
    renewing = renewing
      .then(async () => {
        const renewed = await prisma.computer.updateMany({
          where: {
            id: computerId,
            maintenanceId: marker,
            homeMoveExpiresAt: { gt: new Date() },
          },
          data: { homeMoveExpiresAt: new Date(Date.now() + 60000) },
        });
        if (renewed.count !== 1) throw new Error("Home preparation ownership expired");
      })
      .catch((error) => abort.abort(error));
  }, 10000);
  heartbeat.unref();
  let stopped = false;
  try {
    let revision = original.homeRevision;
    if (original.providerRef) {
      const ref = toComputerRef(original);
      if (original.kind === "docker") {
        await source.stop(ref, ctx);
        stopped = true;
        if (original.homeStorage === "snapshot") {
          revision = await checkpointComputerWorkspace(home, source, original, ref, ctx);
        }
      } else {
        if (!["stopped", "suspended"].includes(original.state)) {
          revision = await checkpointComputerWorkspace(home, source, original, ref, ctx);
        }
        await source.stop(ref, ctx);
        stopped = true;
      }
    }
    ctx.signal.throwIfAborted();
    if (original.homeStorage === "volumes") {
      // Stays on Docker until carryDockerVolumesToE2B has carried its volumes.
      await prisma.computer.updateMany({
        where: { id: computerId, maintenanceId: marker },
        data: { ...RELEASED, state: "suspended" },
      });
      return;
    }
    const changed = await prisma.computer.updateMany({
      where: {
        id: computerId,
        maintenanceId: marker,
        homeMoveExpiresAt: { gt: new Date() },
        homeStorage: "snapshot",
        kind: original.kind,
        providerRef: original.providerRef,
      },
      data: { ...STOPPED_ON_E2B, homeRevision: revision },
    });
    if (changed.count !== 1)
      throw new Error("Home preparation lost ownership; source snapshot was retained");
  } finally {
    clearInterval(heartbeat);
    await renewing;
    await prisma.computer.updateMany({
      where: { id: computerId, maintenanceId: marker },
      data: {
        maintenanceId: null,
        homeMoveExpiresAt: null,
        ...(stopped ? { state: "suspended" } : {}),
      },
    });
  }
}

/** What a Docker volume carries to E2B: its regular files, and the entries it leaves behind. */
export type CarriedVolume = {
  volumeId: string;
  kind: string;
  botId: string | null;
  /** The provider before this run: a volume already on E2B, as a shared one, is skipped. */
  providerKind: string;
  files: number;
  bytes: number;
  /** Paths relative to `DATA_DIR`, in the local directory that keeps them. */
  notCopied: NotCopied[];
};

export type DockerVolumeRefusal =
  | { code: HomeMoveBlocker }
  | { code: "volume_not_empty" | "copy_mismatch"; volumes: VolumeConflict[] }
  | { code: "volume_changed"; volumeId: string; paths: string[] };

export type DockerVolumeCarry =
  | { outcome: "already_on_e2b" }
  | { outcome: "carried"; volumes: CarriedVolume[] }
  | { outcome: "refused"; refusal: DockerVolumeRefusal; volumes: CarriedVolume[] };

type VolumePlan = {
  report: CarriedVolume;
  /** The ref the row had when planned: the switch only applies to that row. */
  dockerRef: string | null;
  destination: HomeDestination;
  directory: string | null;
  planned: HomeFile[];
};

type CarryDeps = {
  prisma: PrismaClient;
  source: Pick<DockerWorkerProvider, "describe" | "volumePath">;
  target: Pick<WorkerProvider, "describe" | "ensureVolume">;
  files: VolumeFiles;
};

const RENEW_AFTER_MS = HOME_MOVE_TTL_MS / 3;

/**
 * Carries a stopped Docker computer whose home is on Docker volumes to E2B. Each of its volumes
 * still on Docker (its bots' private volumes, and the space's shared one for a team computer) gets
 * its E2B volume under the same name; the regular files of its local directory are copied and
 * verified by hash and mode, then the row switches to E2B. Links are never followed and stay, like
 * special files and empty directories, only in the local directory, which is never changed. A
 * volume already on E2B is skipped, so a shared volume is copied once and a rerun resumes. The
 * computer switches to E2B once all its volumes did.
 */
export async function carryDockerVolumesToE2B(
  deps: CarryDeps,
  computerId: string,
  context: AdapterContext,
): Promise<DockerVolumeCarry> {
  const { prisma, target, files } = deps;
  const computer = await prisma.computer.findUniqueOrThrow({
    where: { id: computerId },
    select: { kind: true, homeStorage: true },
  });
  if (computer.kind === "e2b" && computer.homeStorage === "volumes") {
    return { outcome: "already_on_e2b" };
  }
  if (computer.kind !== "docker" || computer.homeStorage !== "volumes") {
    throw new Error(`${computerId} is not a Docker computer on volumes`);
  }
  const workers = createWorkerLifecycle({ prisma, provider: null });
  const reservation = await workers.reserveHomeMove(computerId);
  if ("blocker" in reservation) {
    return { outcome: "refused", refusal: { code: reservation.blocker }, volumes: [] };
  }
  let renewedAt = Date.now();
  const keepReserved = async () => {
    if (Date.now() - renewedAt < RENEW_AFTER_MS) return;
    const started = Date.now();
    if (!(await workers.renewHomeMove(reservation.marker))) {
      throw new Error(`The home move reservation of ${computerId} expired`);
    }
    renewedAt = started;
  };
  const owned = () => ({
    id: computerId,
    maintenanceId: reservation.marker,
    homeMoveExpiresAt: { gt: new Date() },
  });
  try {
    const plans = await planDockerVolumes(deps, computerId);
    const docker = deps.source.describe().id;
    const stray = plans.find(
      ({ report }) => ![docker, target.describe().id].includes(report.providerKind),
    );
    if (stray) throw new Error(`Volume ${stray.report.volumeId} is neither on Docker nor on E2B`);
    const volumes = plans.map((plan) => plan.report);
    const refuse = (refusal: DockerVolumeRefusal): DockerVolumeCarry => ({
      outcome: "refused",
      refusal,
      volumes,
    });
    for (const { report, dockerRef, destination, directory, planned } of plans) {
      if (report.providerKind !== docker) continue;
      await keepReserved();
      const { providerRef } = await target.ensureVolume(
        { name: `rakazo-${report.volumeId}`, ensureDeadline: workerEnsureDeadline(new Date()) },
        context,
      );
      const volume: TargetVolume = {
        destination,
        volumeId: report.volumeId,
        providerRef,
        files: planned,
      };
      // Files a stopped run already copied, with the same content and mode, are not foreign.
      const [before] = await inspectTargets(files, [volume], context);
      if (!before) throw new Error("The E2B volume was not inspected");
      if (before.foreign.length > 0) {
        return refuse({ code: "volume_not_empty", volumes: [conflictOf(before)] });
      }
      const changed: string[] = [];
      for (const file of before.missing) {
        await keepReserved();
        const local = directory && (await readRegularFile(path.join(directory, file.volumePath)));
        if (!local || sha256(local.content) !== file.sha256 || local.mode !== file.mode) {
          changed.push(file.volumePath);
          continue;
        }
        await files.write(
          providerRef,
          { path: file.volumePath, content: local.content, mode: file.mode },
          context,
        );
      }
      if (changed.length > 0) {
        return refuse({ code: "volume_changed", volumeId: report.volumeId, paths: changed });
      }
      const [after] = await inspectTargets(files, [volume], context);
      if (!after) throw new Error("The E2B volume was not inspected");
      if (after.foreign.length > 0 || after.missing.length > 0) {
        return refuse({ code: "copy_mismatch", volumes: [conflictOf(after)] });
      }
      await keepReserved();
      const switched = await prisma.$transaction(async (tx) => {
        if ((await tx.computer.count({ where: owned() })) !== 1) return false;
        const row = await tx.volume.updateMany({
          where: {
            id: report.volumeId,
            providerKind: docker,
            providerRef: dockerRef,
            writerAttemptId: null,
          },
          data: { providerKind: target.describe().id, providerRef, ensureUntil: null },
        });
        return row.count === 1;
      });
      if (!switched) return refuse({ code: "computer_active" });
    }
    const moved = await prisma.computer.updateMany({
      where: { ...owned(), kind: "docker", homeStorage: "volumes" },
      data: STOPPED_ON_E2B,
    });
    if (moved.count !== 1) return refuse({ code: "computer_active" });
    return { outcome: "carried", volumes };
  } finally {
    await workers.releaseHomeMove(reservation.marker);
  }
}

/** Read-only: what carrying a Docker computer's volumes to E2B would copy and leave behind. */
export async function previewDockerVolumeCarry(
  deps: Pick<CarryDeps, "prisma" | "source">,
  computerId: string,
) {
  const volumes = (await planDockerVolumes(deps, computerId)).map((plan) => plan.report);
  return {
    files: volumes.reduce((total, volume) => total + volume.files, 0),
    bytes: volumes.reduce((total, volume) => total + volume.bytes, 0),
    notCopied: volumes.flatMap((volume) => volume.notCopied),
  };
}

/** Every volume of the computer and what its local directory holds, read without following links. */
async function planDockerVolumes(
  deps: Pick<CarryDeps, "prisma" | "source">,
  computerId: string,
): Promise<VolumePlan[]> {
  const computer = await deps.prisma.computer.findUniqueOrThrow({
    where: { id: computerId },
    select: { scope: true, spaceId: true, bots: { select: { id: true } } },
  });
  const rows = await deps.prisma.volume.findMany({
    where: {
      OR: [
        { kind: "bot_private", botId: { in: computer.bots.map((bot) => bot.id) } },
        ...(computer.scope === "team" ? [{ kind: "space_shared", spaceId: computer.spaceId }] : []),
      ],
    },
    select: { id: true, kind: true, botId: true, providerKind: true, providerRef: true },
    orderBy: { id: "asc" },
  });
  const plans: VolumePlan[] = [];
  for (const row of rows) {
    const onDocker = row.providerKind === deps.source.describe().id;
    const directory = onDocker && row.providerRef ? deps.source.volumePath(row.providerRef) : null;
    const destination: HomeDestination = row.botId
      ? { scope: "private", botId: row.botId }
      : { scope: "shared" };
    const tree = directory
      ? await localTree(directory, destination)
      : { planned: [], notCopied: [] };
    plans.push({
      report: {
        volumeId: row.id,
        kind: row.kind,
        botId: row.botId,
        providerKind: row.providerKind,
        files: tree.planned.length,
        bytes: tree.planned.reduce((total, file) => total + file.size, 0),
        notCopied: tree.notCopied.map((entry) => ({
          ...entry,
          homePath: `volumes/${row.providerRef}/${entry.homePath}`,
        })),
      },
      dockerRef: row.providerRef,
      destination,
      directory,
      planned: tree.planned,
    });
  }
  return plans;
}

/** The regular files under a volume directory, never through a link, and what else it holds. */
async function localTree(
  root: string,
  destination: HomeDestination,
): Promise<{ planned: HomeFile[]; notCopied: NotCopied[] }> {
  const stats = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stats) return { planned: [], notCopied: [] };
  if (!stats.isDirectory()) throw new Error(`${root} is not a directory`);
  const planned: HomeFile[] = [];
  const notCopied: NotCopied[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) notCopied.push({ homePath: relative, kind: "symlink" });
      else if (entry.isDirectory()) {
        const found = planned.length + notCopied.length;
        await walk(absolute, relative);
        if (planned.length + notCopied.length === found) {
          notCopied.push({ homePath: relative, kind: "empty_dir" });
        }
      } else if (!entry.isFile()) notCopied.push({ homePath: relative, kind: "special" });
      else if (!isPortablePath(relative)) {
        notCopied.push({ homePath: relative, kind: "invalid_path" });
      } else {
        const file = await readRegularFile(absolute);
        if (!file) notCopied.push({ homePath: relative, kind: "special" });
        else {
          planned.push({
            homePath: relative,
            volumePath: relative,
            destination,
            size: file.content.byteLength,
            sha256: sha256(file.content),
            mode: file.mode,
          });
        }
      }
    }
  };
  await walk(root, "");
  return { planned, notCopied };
}

/** A regular file's content and permission bits; null for anything else, never a link's target. */
async function readRegularFile(
  file: string,
): Promise<{ content: Uint8Array; mode: number } | null> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ELOOP" || error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return null;
    return { content: await handle.readFile(), mode: stats.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
