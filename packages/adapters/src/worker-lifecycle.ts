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
  ensureMayBeInFlight,
  LIVE_WORKER_STATES,
  lostSetupMove,
  planLaunch,
  supportsWorkers,
  takesWriterLease,
  WORKER_ENSURE_TIMEOUT_SECONDS,
  WORKER_TTL_SECONDS,
  WORKSPACE_ROOT,
  workerStatesInto,
  writersBlocking,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";

/** The attempt no longer holds its run's fence, its worker was started already, or torn down. */
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
  | "computer_active"
  | "volume_missing"
  | "volume_busy";

/** `awaiting_ensure`: moved to releasing, but its VM may still appear, so leases stay held. */
export type ReleaseOutcome = "released" | "awaiting_ensure" | "not_live";

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
const INTO_RELEASED = Prisma.join(workerStatesInto("released"));

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

  /**
   * Records a setup step of `start`. A move that matches no row means teardown took the worker:
   * the VM this call holds is recorded where release and reconcile will destroy it.
   */
  async function advance(
    attemptId: string,
    to: "created" | "ready",
    providerRef: string,
    context: AdapterContext,
  ): Promise<void> {
    const moved = await prisma.attempt.updateMany({
      where: { id: attemptId, workerState: { in: workerStatesInto(to) } },
      data: { workerState: to, workerStateAt: new Date(), workerProviderRef: providerRef },
    });
    if (moved.count === 1) return;
    const [observed] = await prisma.$queryRaw<
      { workerState: WorkerState | null; workerProviderRef: string | null }[]
    >`SELECT "workerState", "workerProviderRef" FROM attempts WHERE id = ${attemptId}`;
    const outcome = lostSetupMove(observed ?? null);
    const recordRef = () => prisma.$executeRaw`
      UPDATE attempts SET "workerProviderRef" = ${providerRef}
      WHERE id = ${attemptId} AND "workerState" = 'releasing' AND "workerProviderRef" IS NULL`;
    // The lease may already be free, so the row records the VM before a destroy can fail.
    const reopenOrphan = () => prisma.$executeRaw`
      UPDATE attempts SET "workerState" = 'releasing', "workerProviderRef" = ${providerRef},
        "workerStateAt" = ${new Date()}
      WHERE id = ${attemptId} AND "workerState" = 'released' AND "workerProviderRef" IS NULL`;
    // A record_ref that lost its row found the worker released meanwhile: an orphan too.
    const recorded =
      (outcome === "record_ref" && (await recordRef()) === 1) ||
      (outcome !== "stale" && (await reopenOrphan()) === 1);
    if (recorded) await release(attemptId, context).catch(() => undefined);
    throw new StaleAttemptError(attemptId);
  }

  async function release(attemptId: string, context: AdapterContext): Promise<ReleaseOutcome> {
    const provider = requireProvider();
    const now = new Date();
    const [target] = await prisma.$queryRaw<
      { workerProviderRef: string | null; workerEnsureAt: Date }[]
    >`
      UPDATE attempts SET "workerState" = 'releasing', "workerStateAt" = ${now}
      WHERE id = ${attemptId} AND "workerState" IN (${RELEASABLE})
      RETURNING "workerProviderRef", "workerEnsureAt"`;
    if (!target) return "not_live";
    if (ensureMayBeInFlight(target, now)) return "awaiting_ensure";
    await provider.destroy({ attemptId, providerRef: target.workerProviderRef }, context);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE attempts SET "workerState" = 'released', "workerStateAt" = ${new Date()}
        WHERE id = ${attemptId} AND "workerState" IN (${INTO_RELEASED})`;
      const held = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM volumes WHERE "writerAttemptId" = ${attemptId} ORDER BY id FOR UPDATE`;
      if (held.length > 0) {
        await tx.volume.updateMany({
          where: { id: { in: held.map((volume) => volume.id) } },
          data: { writerAttemptId: null },
        });
      }
    });
    return "released";
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
     * called, then records the VM's ref before any fallible setup. Runs once per attempt: a
     * controller that crashed mid-start loses its run lease, and the next claim is a new attempt.
     * A failure of its ensure or prepare releases the worker.
     */
    async start(launch: WorkerLaunch, context: AdapterContext): Promise<StartedWorker> {
      const provider = requireProvider();
      const { id: providerKind, capabilities } = provider.describe();
      const mounts = await prisma.$transaction(async (tx) => {
        const [run] = await tx.$queryRaw<{ leaseFence: number; status: string }[]>`
          SELECT "leaseFence", status FROM runs WHERE id = ${launch.runId} FOR UPDATE`;
        const [attempt] = await tx.$queryRaw<
          { runId: string; fence: number; workerState: WorkerState | null }[]
        >`SELECT "runId", fence, "workerState" FROM attempts WHERE id = ${launch.attemptId}
          FOR UPDATE`;
        if (
          !run ||
          attempt?.runId !== launch.runId ||
          !attemptHoldsFence(attempt, run) ||
          attempt.workerState !== null
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
        const leased = authorized.mounts.filter(takesWriterLease);
        if (leased.length > 0) {
          await tx.volume.updateMany({
            where: { id: { in: leased.map((mount) => mount.volumeId) } },
            data: { writerAttemptId: launch.attemptId },
          });
        }
        const now = new Date();
        await tx.attempt.update({
          where: { id: launch.attemptId },
          data: {
            workerState: "requested",
            workerProviderKind: providerKind,
            workerStateAt: now,
            workerEnsureAt: now,
          },
        });
        return authorized.mounts;
      });

      const spec: WorkerSpec = {
        attemptId: launch.attemptId,
        runId: launch.runId,
        botId: launch.botId,
        mounts: mounts.map(({ volumeRef, path, access }) => ({ volumeRef, path, access })),
        ttlSeconds: WORKER_TTL_SECONDS,
        ensureTimeoutSeconds: WORKER_ENSURE_TIMEOUT_SECONDS,
      };
      const ownStep = async <T>(step: () => Promise<T>): Promise<T> => {
        try {
          return await step();
        } catch (error) {
          // A destroy the provider could not confirm stays releasing for the reconciler.
          await release(launch.attemptId, context).catch(() => undefined);
          throw error;
        }
      };
      const { providerRef } = await ownStep(() => provider.ensure(spec, context));
      await advance(launch.attemptId, "created", providerRef, context);
      await ownStep(() => provider.prepare(providerRef, spec, context));
      await advance(launch.attemptId, "ready", providerRef, context);
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
    },

    /**
     * Idempotent, and a no-op for an attempt without a worker. Writer leases free only in the
     * transaction that records the provider's confirmed destruction, never while an ensure may
     * still create the VM. Volumes are never touched.
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
    ): Promise<{ released: number; awaitingEnsure: number; failed: number }> {
      const orphans = await prisma.$queryRaw<{ id: string }[]>`
        SELECT a.id FROM attempts a JOIN runs r ON r.id = a."runId"
        WHERE a."workerState" IN (${RELEASABLE})
          AND (a."workerState" = 'releasing' OR a.fence <> r."leaseFence"
            OR r.status NOT IN ('leased', 'running') OR r."leaseExpiresAt" < ${new Date()})
        ORDER BY a."workerStateAt", a.id
        LIMIT ${options.limit}`;
      const counts = { released: 0, awaitingEnsure: 0, failed: 0 };
      for (const { id } of orphans) {
        try {
          const outcome = await release(id, context);
          if (outcome === "released") counts.released += 1;
          if (outcome === "awaiting_ensure") counts.awaitingEnsure += 1;
        } catch {
          // A provider that cannot confirm destruction keeps the lease until the next pass.
          counts.failed += 1;
        }
      }
      return counts;
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
     * writes, and nothing runs on the computer. Called after the files were copied; stops
     * automatic import and export for good.
     */
    async adoptVolumeHome(computerId: string): Promise<HomeAdoption> {
      return prisma.$transaction(async (tx) => {
        const [computer] = await tx.$queryRaw<
          {
            kind: string;
            scope: string;
            spaceId: string;
            homeStorage: HomeStorage;
            state: string;
            controlHolder: string;
          }[]
        >`SELECT kind, scope, "spaceId", "homeStorage", state, "controlHolder" FROM computers
          WHERE id = ${computerId} FOR UPDATE`;
        if (!computer) throw new Error("Computer not found");
        if (computer.homeStorage === "volumes") return "adopted";
        if (!supportsWorkers(computer.kind)) return "computer_kind_unsupported";
        const executing = await tx.computerExecutionLease.count({
          where: { computerId, expiresAt: { gt: new Date() } },
        });
        if (
          !["stopped", "suspended"].includes(computer.state) ||
          computer.controlHolder !== "none" ||
          executing > 0
        ) {
          // A run writing to the computer's disk after the copy would lose those writes.
          return "computer_active";
        }
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
