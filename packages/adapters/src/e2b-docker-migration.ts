import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext, WorkerProvider } from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { z } from "zod";
import type { VolumeImportSource } from "./docker-volume-import.js";
import {
  importDockerVolume,
  inspectLocalVolume,
  sameVolume,
  volumeManifestSchema,
} from "./docker-volume-import.js";
import { createWorkerLifecycle, HOME_MOVE_TTL_MS } from "./worker-lifecycle.js";

const volumeSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    kind: z.string(),
    spaceId: z.string(),
    botId: z.string().nullable(),
    providerRef: z.string().nullable(),
    targetRef: z.string().regex(/^rakazo-[a-zA-Z0-9_-]+$/),
    manifest: volumeManifestSchema.nullable(),
  })
  .refine(
    (volume) => volume.targetRef === `rakazo-${volume.id}`,
    "Invalid target volume reference",
  );
const stateSchema = z.object({
  version: z.literal(1),
  operationId: z.uuid(),
  phase: z.enum(["copying", "adopted"]),
  volumes: z.array(volumeSchema),
  computers: z.array(
    z.object({ id: z.string(), spaceId: z.string(), providerRef: z.string().nullable() }),
  ),
});
type MigrationState = z.infer<typeof stateSchema>;
type MigrationDeps = {
  prisma: PrismaClient;
  dataDir: string;
  source: VolumeImportSource;
  workers: WorkerProvider;
  /** Must destroy the computer VM, confirm it gone, and retain its persistent volumes. */
  destroyComputer(providerRef: string): Promise<void>;
};

async function save(filename: string, state: MigrationState) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
  await rename(temporary, filename);
}

export async function inspectE2BDockerMigration(prisma: PrismaClient) {
  const now = new Date();
  const [computers, volumes, runs, controls, leases, maintenance, foreignWorkers] =
    await Promise.all([
      prisma.computer.findMany({ where: { kind: "e2b" }, orderBy: { id: "asc" } }),
      prisma.volume.findMany({ where: { providerKind: "e2b-worker" }, orderBy: { id: "asc" } }),
      prisma.run.count({ where: { status: { in: [...ACTIVE_RUN_STATUSES] } } }),
      prisma.computer.count({
        where: { controlHolder: "user", controlLeaseExpiresAt: { gt: now } },
      }),
      prisma.computerExecutionLease.count({ where: { expiresAt: { gt: now } } }),
      prisma.computer.count({ where: { maintenanceId: { not: null } } }),
      prisma.attempt.count({
        where: {
          workerState: { in: ["requested", "created", "ready", "releasing"] },
          workerProviderKind: { not: "e2b-worker" },
        },
      }),
    ]);
  const blockers = {
    runs,
    controls,
    leases,
    maintenance,
    foreignWorkers,
    snapshots: computers.filter((computer) => computer.homeStorage !== "volumes").length,
    pendingVolumes: volumes.filter((volume) => !volume.providerRef && volume.ensureUntil).length,
  };
  return { computers, volumes, blockers };
}

function requireIdle(blockers: Record<string, number>) {
  const blocked = Object.entries(blockers)
    .filter(([, count]) => count > 0)
    .map(([name]) => name);
  if (blocked.length) throw new Error(`E2B migration refused: ${blocked.join(", ")}`);
}

async function verifyAdopted(prisma: PrismaClient, state: MigrationState, dataDir: string) {
  for (const volume of state.volumes) {
    const row = await prisma.volume.findUniqueOrThrow({ where: { id: volume.id } });
    if (
      row.providerKind !== "docker-worker" ||
      row.providerRef !== (volume.manifest ? volume.targetRef : null) ||
      row.kind !== volume.kind ||
      row.spaceId !== volume.spaceId ||
      row.botId !== volume.botId
    ) {
      throw new Error("Migrated volume no longer matches its journal");
    }
    if (
      volume.manifest &&
      !sameVolume(
        volume.manifest,
        await inspectLocalVolume(path.join(dataDir, "volumes", volume.targetRef)),
      )
    ) {
      throw new Error("Published Docker volume no longer matches its verified copy");
    }
  }
  for (const computer of state.computers) {
    const row = await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } });
    if (row.kind !== "docker" || row.homeStorage !== "volumes" || row.providerRef !== null) {
      throw new Error("Migrated computer no longer matches its journal");
    }
  }
}

/** Operator-only: application services must remain stopped until Tangow completes cutover. */
export async function migrateE2BToDocker(
  deps: MigrationDeps,
  operationId: string,
  context: AdapterContext,
) {
  z.uuid().parse(operationId);
  const { prisma, dataDir } = deps;
  const directory = path.join(dataDir, "docker-provider-migration", operationId);
  const filename = path.join(directory, "state.json");
  const lifecycle = createWorkerLifecycle({ prisma, provider: deps.workers });
  let state: MigrationState | null;
  try {
    state = stateSchema.parse(JSON.parse(await readFile(filename, "utf8")));
    if (state.operationId !== operationId) throw new Error("Migration operation mismatch");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    state = null;
  }
  if (state?.phase === "adopted") {
    await verifyAdopted(prisma, state, dataDir);
    return {
      outcome: "migrated",
      volumes: state.volumes.length,
      computers: state.computers.length,
    };
  }
  if (state) {
    for (const computer of state.computers) await lifecycle.clearStaleHomeMove(computer.id);
  }
  const inventory = await inspectE2BDockerMigration(prisma);
  requireIdle(inventory.blockers);
  if (!state) {
    state = stateSchema.parse({
      version: 1,
      operationId,
      phase: "copying",
      volumes: inventory.volumes.map((volume) => ({
        id: volume.id,
        kind: volume.kind,
        spaceId: volume.spaceId,
        botId: volume.botId,
        providerRef: volume.providerRef,
        targetRef: `rakazo-${volume.id}`,
        manifest: null,
      })),
      computers: inventory.computers.map(({ id, spaceId, providerRef }) => ({
        id,
        spaceId,
        providerRef,
      })),
    });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await save(filename, state);
  }
  const currentIds = inventory.volumes.map((volume) => volume.id);
  if (
    JSON.stringify(currentIds) !== JSON.stringify(state.volumes.map((volume) => volume.id)) ||
    JSON.stringify(inventory.computers.map((computer) => computer.id)) !==
      JSON.stringify(state.computers.map((computer) => computer.id))
  ) {
    // The DB may have committed adoption immediately before a crash, before its journal write.
    await verifyAdopted(prisma, state, dataDir);
    state.phase = "adopted";
    await save(filename, state);
    return {
      outcome: "migrated",
      volumes: state.volumes.length,
      computers: state.computers.length,
    };
  }
  for (const space of await prisma.space.findMany({ select: { id: true } })) {
    await lifecycle.releaseOwnerWorkers({ spaceId: space.id }, context);
  }
  if (
    await prisma.attempt.count({
      where: { workerState: { in: ["requested", "created", "ready", "releasing"] } },
    })
  ) {
    throw new Error(
      "Workers still live or creation may be in flight; keep services stopped and retry",
    );
  }
  for (const computer of state.computers) {
    if (computer.providerRef) await deps.destroyComputer(computer.providerRef);
    await prisma.computer.update({
      where: { id: computer.id },
      data: { state: "stopped", controlHolder: "none" },
    });
  }
  const reservations: string[] = [];
  const abort = new AbortController();
  const ctx = { ...context, signal: AbortSignal.any([context.signal, abort.signal]) };
  let renewing = Promise.resolve();
  const heartbeat = setInterval(() => {
    renewing = renewing
      .then(async () => {
        for (const marker of reservations) {
          if (!(await lifecycle.renewHomeMove(marker)))
            throw new Error("Migration reservation expired");
        }
      })
      .catch((error: unknown) => abort.abort(error));
  }, HOME_MOVE_TTL_MS / 3);
  heartbeat.unref();
  try {
    const covered = new Set<string>();
    for (const computer of [...inventory.computers].sort((a, b) =>
      b.scope.localeCompare(a.scope),
    )) {
      if (covered.has(computer.spaceId)) continue;
      const reservation = await lifecycle.reserveHomeMove(computer.id);
      if ("blocker" in reservation) throw new Error(`Home move refused: ${reservation.blocker}`);
      reservations.push(reservation.marker);
      if (computer.scope === "team") covered.add(computer.spaceId);
    }
    for (const volume of state.volumes) {
      ctx.signal.throwIfAborted();
      if (!volume.providerRef) continue;
      volume.manifest = await importDockerVolume({
        source: deps.source,
        sourceRef: volume.providerRef,
        destination: path.join(dataDir, "volumes", volume.targetRef),
        staging: path.join(directory, "staging", volume.id),
        context: ctx,
      });
      await save(filename, state);
    }
    ctx.signal.throwIfAborted();
    // No row changes supplier until every source volume has a verified destination.
    await prisma.$transaction(async (tx) => {
      for (const volume of state.volumes) {
        const changed = await tx.volume.updateMany({
          where: {
            id: volume.id,
            kind: volume.kind,
            spaceId: volume.spaceId,
            botId: volume.botId,
            providerKind: "e2b-worker",
            providerRef: volume.providerRef,
            writerAttemptId: null,
          },
          data: {
            providerKind: "docker-worker",
            providerRef: volume.manifest ? volume.targetRef : null,
            ensureUntil: null,
          },
        });
        if (changed.count !== 1) throw new Error("Volume changed before adoption; source retained");
      }
      for (const computer of state.computers) {
        const changed = await tx.computer.updateMany({
          where: {
            id: computer.id,
            kind: "e2b",
            homeStorage: "volumes",
            providerRef: computer.providerRef,
          },
          data: {
            kind: "docker",
            state: "stopped",
            providerRef: null,
            screenUrl: null,
            controlFence: { increment: 1 },
            executionFence: { increment: 1 },
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
          },
        });
        if (changed.count !== 1) throw new Error("Computer changed before adoption");
      }
    });
    state.phase = "adopted";
    await save(filename, state);
    return {
      outcome: "migrated",
      volumes: state.volumes.length,
      computers: state.computers.length,
    };
  } finally {
    clearInterval(heartbeat);
    await renewing;
    for (const marker of reservations) await lifecycle.releaseHomeMove(marker);
  }
}
