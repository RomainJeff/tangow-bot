import type {
  AdapterContext,
  WorkerProvider,
  WorkerSpec,
  WorkerStartV1,
  WorkerStatusV1,
} from "@rakazo/adapter-kit";
import type { HomeStorage } from "@rakazo/contracts";
import { WorkerState } from "@rakazo/contracts";
import type { LaunchPlan, MountRefusal, RunNeeds, VolumeRow, WorkerLaunch } from "@rakazo/core";
import {
  attemptHoldsFence,
  authorizeMounts,
  LIVE_WORKER_STATES,
  planLaunch,
  supportsWorkers,
  WORKER_TTL_SECONDS,
  WORKSPACE_ROOT,
  workerStatesInto,
  writersBlocking,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";

/** The attempt no longer holds its run's fence, or its worker was already released. */
export class StaleAttemptError extends Error {
  constructor(readonly attemptId: string) {
    super("Attempt no longer holds its run fence");
    this.name = "StaleAttemptError";
  }
}

/** A volume grant failed authorization. Nothing was written and no provider was called. */
export class VolumeRefusedError extends Error {
  constructor(readonly refusal: MountRefusal) {
    super(`Volume refused: ${refusal.code}`);
    this.name = "VolumeRefusedError";
  }
}

/** Another worker still writes these volumes. Nothing was held: requeue and retry. */
export class VolumeBusyError extends Error {
  constructor(readonly volumeIds: string[]) {
    super("Volume busy");
    this.name = "VolumeBusyError";
  }
}

export type StartedWorker = { providerRef: string; start: WorkerStartV1 };

export type HomeAdoption =
  | "adopted"
  | "computer_kind_unsupported"
  | "volume_missing"
  | "volume_busy";

type PlanRow = {
  runId: string;
  botId: string;
  spaceId: string;
  fence: number;
  leaseFence: number;
  status: string;
  computerId: string | null;
  homeStorage: HomeStorage | null;
  privateVolumeId: string | null;
  sharedVolumeId: string | null;
};

const RELEASABLE = Prisma.join([...LIVE_WORKER_STATES, "releasing"]);

/**
 * The only writer of attempts.worker* and volumes.writerAttemptId. A null provider keeps every
 * run in process.
 */
export function createWorkerLifecycle(deps: {
  prisma: PrismaClient;
  provider: WorkerProvider | null;
}) {
  const { prisma } = deps;

  function requireProvider(): WorkerProvider {
    if (!deps.provider) throw new Error("No worker provider is configured");
    return deps.provider;
  }

  async function moveWorker(
    attemptId: string,
    from: readonly WorkerState[],
    to: WorkerState,
    providerRef?: string,
  ): Promise<void> {
    const moved = await prisma.attempt.updateMany({
      where: { id: attemptId, workerState: { in: [...from] } },
      data: { workerState: to, workerStateAt: new Date(), workerProviderRef: providerRef },
    });
    if (moved.count !== 1) throw new StaleAttemptError(attemptId);
  }

  async function release(attemptId: string, context: AdapterContext): Promise<void> {
    const provider = requireProvider();
    const [target] = await prisma.$queryRaw<{ workerProviderRef: string | null }[]>`
      UPDATE attempts SET "workerState" = 'releasing', "workerStateAt" = ${new Date()}
      WHERE id = ${attemptId} AND "workerState" IN (${RELEASABLE})
      RETURNING "workerProviderRef"`;
    if (!target) return;
    await provider.destroy({ attemptId, providerRef: target.workerProviderRef }, context);
    await prisma.$transaction([
      prisma.attempt.updateMany({
        where: { id: attemptId, workerState: { in: workerStatesInto("released") } },
        data: { workerState: "released", workerStateAt: new Date() },
      }),
      prisma.volume.updateMany({
        where: { writerAttemptId: attemptId },
        data: { writerAttemptId: null },
      }),
    ]);
  }

  return {
    /** Without a provider, answers in process with no query; with one, a single indexed read. */
    async plan(input: { attemptId: string; needs: RunNeeds }): Promise<LaunchPlan> {
      if (!deps.provider) return { mode: "in_process", reason: "no_worker_provider" };
      const [row] = await prisma.$queryRaw<PlanRow[]>`
        SELECT r.id AS "runId", r."botId", r."spaceId", a.fence, r."leaseFence", r.status,
          c.id AS "computerId", c."homeStorage",
          (SELECT v.id FROM volumes v WHERE v.kind = 'bot_private' AND v."botId" = r."botId")
            AS "privateVolumeId",
          (SELECT v.id FROM volumes v WHERE v.kind = 'space_shared' AND v."spaceId" = r."spaceId")
            AS "sharedVolumeId"
        FROM attempts a
        JOIN runs r ON r.id = a."runId"
        JOIN bots b ON b.id = r."botId"
        LEFT JOIN computers c ON c.id = b."computerId"
        WHERE a.id = ${input.attemptId}`;
      if (!row || !attemptHoldsFence(row, row)) throw new StaleAttemptError(input.attemptId);
      return planLaunch(
        {
          ...row,
          attemptId: input.attemptId,
          computer:
            row.computerId && row.homeStorage
              ? { id: row.computerId, homeStorage: row.homeStorage }
              : null,
        },
        input.needs,
      );
    },

    /**
     * Records intent and takes every writer lease in one transaction before the provider is
     * called, then records the VM's ref before any fallible setup. Re-callable while the worker
     * is requested or created; any failure after the intent releases the worker.
     */
    async start(launch: WorkerLaunch, context: AdapterContext): Promise<StartedWorker> {
      const provider = requireProvider();
      const { id: providerKind, capabilities } = provider.describe();
      const mounts = await prisma.$transaction(async (tx) => {
        const [run] = await tx.$queryRaw<{ leaseFence: number; status: string }[]>`
          SELECT "leaseFence", status FROM runs WHERE id = ${launch.runId} FOR UPDATE`;
        const attempt = await tx.attempt.findUnique({
          where: { id: launch.attemptId },
          select: { runId: true, fence: true, workerState: true },
        });
        if (
          !run ||
          attempt?.runId !== launch.runId ||
          !attemptHoldsFence(attempt, run) ||
          (attempt.workerState !== null && !["requested", "created"].includes(attempt.workerState))
        ) {
          throw new StaleAttemptError(launch.attemptId);
        }
        await tx.attempt.updateMany({
          where: {
            runId: launch.runId,
            id: { not: launch.attemptId },
            workerState: { in: [...LIVE_WORKER_STATES] },
          },
          data: { workerState: "releasing", workerStateAt: new Date() },
        });
        const volumeIds = launch.volumes.map((grant) => grant.volumeId);
        const rows = volumeIds.length
          ? await tx.$queryRaw<VolumeRow[]>`
              SELECT id, kind, "spaceId", "botId", "providerKind", "providerRef", "writerAttemptId"
              FROM volumes WHERE id = ANY(${volumeIds}) ORDER BY id FOR UPDATE`
          : [];
        const authorized = authorizeMounts(launch, launch.volumes, rows, {
          kind: providerKind,
          readOnlyMounts: capabilities.readOnlyMounts,
        });
        if (!authorized.ok) throw new VolumeRefusedError(authorized.refusal);
        const busy = writersBlocking(launch.attemptId, authorized.mounts, rows);
        if (busy.length > 0) throw new VolumeBusyError(busy);
        const writable = authorized.mounts.filter((mount) => mount.access === "rw");
        if (writable.length > 0) {
          await tx.volume.updateMany({
            where: { id: { in: writable.map((mount) => mount.volumeId) } },
            data: { writerAttemptId: launch.attemptId },
          });
        }
        if (attempt.workerState === null) {
          await tx.attempt.update({
            where: { id: launch.attemptId },
            data: {
              workerState: "requested",
              workerProviderKind: providerKind,
              workerStateAt: new Date(),
            },
          });
        }
        return authorized.mounts;
      });

      const spec: WorkerSpec = {
        attemptId: launch.attemptId,
        runId: launch.runId,
        botId: launch.botId,
        mounts: mounts.map(({ volumeRef, path, access }) => ({ volumeRef, path, access })),
        ttlSeconds: WORKER_TTL_SECONDS,
      };
      try {
        const { providerRef } = await provider.ensure(spec, context);
        await moveWorker(launch.attemptId, ["requested", "created"], "created", providerRef);
        await provider.prepare(providerRef, spec, context);
        await moveWorker(launch.attemptId, workerStatesInto("ready"), "ready");
        return {
          providerRef,
          start: {
            version: 1,
            kind: "worker.start",
            worker: { runId: launch.runId, attemptId: launch.attemptId, fence: launch.fence },
            workspace: {
              cwd: mounts.find((mount) => mount.scope === "private")?.path ?? WORKSPACE_ROOT,
              mounts: mounts.map(({ path, scope, access }) => ({ path, scope, access })),
            },
            computer: launch.computer.mode,
          },
        };
      } catch (error) {
        // A destroy the provider could not confirm stays releasing for the reconciler.
        await release(launch.attemptId, context).catch(() => undefined);
        throw error;
      }
    },

    /**
     * Idempotent, and a no-op for an attempt without a worker. Writer leases free only in the
     * transaction that records the provider's confirmed destruction. Volumes are never touched.
     */
    release,

    async status(attemptId: string): Promise<WorkerStatusV1 | null> {
      const attempt = await prisma.attempt.findUnique({
        where: { id: attemptId },
        select: {
          runId: true,
          fence: true,
          workerState: true,
          workerProviderRef: true,
          run: { select: { leaseFence: true, status: true } },
        },
      });
      if (!attempt?.workerState) return null;
      return {
        version: 1,
        kind: "worker.status",
        worker: { runId: attempt.runId, attemptId, fence: attempt.fence },
        state: WorkerState.parse(attempt.workerState),
        providerRef: attempt.workerProviderRef,
        active: attemptHoldsFence(attempt, attempt.run),
      };
    },

    /** Releases up to `limit` unreleased workers whose attempt no longer holds its run, oldest first. */
    async reconcile(
      options: { limit: number },
      context: AdapterContext,
    ): Promise<{ released: number; failed: number }> {
      const orphans = await prisma.$queryRaw<{ id: string }[]>`
        SELECT a.id FROM attempts a JOIN runs r ON r.id = a."runId"
        WHERE a."workerState" IN (${RELEASABLE})
          AND (a."workerState" = 'releasing' OR a.fence <> r."leaseFence"
            OR r.status NOT IN ('leased', 'running') OR r."leaseExpiresAt" < ${new Date()})
        ORDER BY a."workerStateAt", a.id
        LIMIT ${options.limit}`;
      let released = 0;
      for (const { id } of orphans) {
        try {
          await release(id, context);
          released += 1;
        } catch {
          // A provider that cannot confirm destruction keeps the lease until the next pass.
        }
      }
      return { released, failed: orphans.length - released };
    },

    /** Creates the volume at the provider under a name derived from its row, once. */
    async provisionVolume(volumeId: string, context: AdapterContext): Promise<string> {
      const provider = requireProvider();
      const volume = await prisma.volume.findUniqueOrThrow({
        where: { id: volumeId },
        select: { providerKind: true, providerRef: true },
      });
      if (volume.providerRef) return volume.providerRef;
      if (volume.providerKind !== provider.describe().id) {
        throw new VolumeRefusedError({ code: "provider_mismatch", volumeId });
      }
      const { providerRef } = await provider.ensureVolume({ name: `rakazo-${volumeId}` }, context);
      await prisma.volume.updateMany({
        where: { id: volumeId, providerRef: null },
        data: { providerRef },
      });
      return providerRef;
    },

    /**
     * The only writer of computers.homeStorage: moves a home from snapshots to volumes once every
     * bot on the computer, and the space for a team computer, has a provisioned volume nobody
     * writes. Called after the files were copied; stops automatic import and export for good.
     */
    async adoptVolumeHome(computerId: string): Promise<HomeAdoption> {
      return prisma.$transaction(async (tx) => {
        const [computer] = await tx.$queryRaw<
          { kind: string; scope: string; spaceId: string; homeStorage: HomeStorage }[]
        >`SELECT kind, scope, "spaceId", "homeStorage" FROM computers WHERE id = ${computerId}
          FOR UPDATE`;
        if (!computer) throw new Error("Computer not found");
        if (computer.homeStorage === "volumes") return "adopted";
        if (!supportsWorkers(computer.kind)) return "computer_kind_unsupported";
        const botIds = (await tx.bot.findMany({ where: { computerId }, select: { id: true } })).map(
          (bot) => bot.id,
        );
        const team = computer.scope === "team";
        const volumes = await tx.$queryRaw<VolumeRow[]>`
          SELECT id, kind, "spaceId", "botId", "providerKind", "providerRef", "writerAttemptId"
          FROM volumes
          WHERE (kind = 'bot_private' AND "botId" = ANY(${botIds}))
            OR (${team} AND kind = 'space_shared' AND "spaceId" = ${computer.spaceId})
          ORDER BY id FOR UPDATE`;
        const provisioned = volumes.filter((volume) => volume.providerRef);
        const missing =
          botIds.some((botId) => !provisioned.some((volume) => volume.botId === botId)) ||
          (team && !provisioned.some((volume) => volume.kind === "space_shared"));
        if (missing) return "volume_missing";
        if (volumes.some((volume) => volume.writerAttemptId)) return "volume_busy";
        await tx.computer.update({ where: { id: computerId }, data: { homeStorage: "volumes" } });
        return "adopted";
      });
    },
  };
}

export type WorkerLifecycle = ReturnType<typeof createWorkerLifecycle>;
