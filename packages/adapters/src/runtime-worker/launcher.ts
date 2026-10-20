import type { AdapterContext, WorkerIdentity, WorkerStartV1 } from "@rakazo/adapter-kit";
import { AgentRuntimeBusyError, AgentRuntimeUnavailableError } from "@rakazo/adapter-kit";
import type { WorkerLaunch } from "@rakazo/core";
import { attemptHoldsFence, LIVE_WORKER_STATES, workerEnsureDeadline } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { ReleaseOutcome, WorkerLifecycle } from "../worker-lifecycle.js";
import { VolumeBusyError } from "../worker-lifecycle.js";
import type { FrameChannel } from "./framing.js";

/** An attempt's guest, launched and reachable. */
export interface LaunchedGuest {
  start: Omit<WorkerStartV1, "run">;
  /** One per connection the guest opens, in order. Ends when the guest can no longer connect. */
  connections: AsyncIterable<FrameChannel>;
  /** Settles when the launcher sees the guest process gone, never on a guest's word. */
  exited: Promise<void>;
  /** Destroys the VM. Only `released` confirms it is gone. */
  release(): Promise<ReleaseOutcome>;
  /** Whether the attempt still holds its running run's fence. */
  holdsFence(): Promise<boolean>;
}

export interface WorkerLauncher {
  /**
   * Starts the attempt's guest with its capability. Throws AgentRuntimeUnavailableError while an
   * earlier guest of the run is not confirmed gone, so two never write at once.
   */
  launch(worker: WorkerIdentity, capability: string): Promise<LaunchedGuest>;
}

/** How the controller reaches a guest in a VM the provider created: P2's local runner, P3's E2B. */
export interface GuestConnector {
  connect(
    target: { attemptId: string; providerRef: string },
    capability: string,
  ): { connections: AsyncIterable<FrameChannel>; exited: Promise<void> };
}

/**
 * Launches the plan the executor made for this attempt through the P1 worker lifecycle, the only
 * writer of `attempts.worker*`.
 */
export function createLifecycleLauncher(deps: {
  prisma: PrismaClient;
  lifecycle: WorkerLifecycle;
  connector: GuestConnector;
  launch: WorkerLaunch;
}): WorkerLauncher {
  return {
    async launch(worker, capability) {
      if (worker.attemptId !== deps.launch.attemptId) {
        throw new Error("This launcher holds the plan of another attempt");
      }
      // Never bound to the run's signal: a release must run after the run was cancelled.
      const context: AdapterContext = {
        operationId: `worker:${worker.attemptId}`,
        traceId: worker.runId,
        spaceId: "",
        userId: "",
        runId: worker.runId,
        signal: new AbortController().signal,
      };
      const unconfirmed = await deps.prisma.attempt.findFirst({
        where: {
          runId: worker.runId,
          id: { not: worker.attemptId },
          workerState: { in: [...LIVE_WORKER_STATES, "releasing"] },
        },
        orderBy: { workerEnsureAt: "asc" },
        select: { workerEnsureAt: true },
      });
      if (unconfirmed) {
        if (
          unconfirmed.workerEnsureAt &&
          Date.now() < workerEnsureDeadline(unconfirmed.workerEnsureAt).getTime()
        ) {
          throw new AgentRuntimeBusyError("An earlier worker of this run is not confirmed gone");
        }
        throw new AgentRuntimeUnavailableError(
          "An earlier worker could not be released before its setup deadline",
        );
      }
      const started = await deps.lifecycle
        .start(deps.launch, context)
        .catch(async (error: unknown) => {
          if (error instanceof VolumeBusyError) {
            const volumes = await deps.prisma.volume.findMany({
              where: { id: { in: error.volumeIds } },
              select: {
                writerAttempt: {
                  select: {
                    fence: true,
                    workerState: true,
                    workerEnsureAt: true,
                    run: { select: { leaseFence: true, status: true, leaseExpiresAt: true } },
                  },
                },
              },
            });
            const now = Date.now();
            const expired = volumes.some(
              ({ writerAttempt: writer }) =>
                writer &&
                (!writer.workerEnsureAt ||
                  workerEnsureDeadline(writer.workerEnsureAt).getTime() <= now) &&
                (writer.workerState === "releasing" ||
                  !attemptHoldsFence(writer, writer.run) ||
                  (writer.run.leaseExpiresAt && writer.run.leaseExpiresAt.getTime() <= now)),
            );
            if (expired) {
              throw new AgentRuntimeUnavailableError(
                "A volume writer could not be released before its setup deadline",
                { cause: error },
              );
            }
            throw new AgentRuntimeBusyError(error.message, { cause: error });
          }
          throw error;
        });
      await deps.prisma.attempt.updateMany({
        where: { id: worker.attemptId, status: "setting_up" },
        data: { status: "running" },
      });
      const guest = deps.connector.connect(
        { attemptId: worker.attemptId, providerRef: started.providerRef },
        capability,
      );
      return {
        start: started.start,
        ...guest,
        release: () => deps.lifecycle.release(worker.attemptId, context),
        holdsFence: async () => (await deps.lifecycle.status(worker.attemptId))?.active === true,
      };
    },
  };
}
