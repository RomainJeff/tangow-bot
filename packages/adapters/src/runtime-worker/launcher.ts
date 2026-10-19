import {
  type AdapterContext,
  AgentRuntimeUnavailableError,
  type WorkerIdentity,
  type WorkerStartV1,
} from "@rakazo/adapter-kit";
import { LIVE_WORKER_STATES, type RunNeeds } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { type ReleaseOutcome, VolumeBusyError, type WorkerLifecycle } from "../worker-lifecycle.js";
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

/** A run that needs no files and no computer: what P2 launches. P3 derives needs from routing. */
const NO_NEEDS: RunNeeds = { files: { private: null, shared: null }, computer: "none" };

/** Launches through the P1 worker lifecycle, the only writer of `attempts.worker*`. */
export function createLifecycleLauncher(deps: {
  prisma: PrismaClient;
  lifecycle: WorkerLifecycle;
  connector: GuestConnector;
  needs?: RunNeeds;
}): WorkerLauncher {
  return {
    async launch(worker, capability) {
      // Never bound to the run's signal: a release must run after the run was cancelled.
      const context: AdapterContext = {
        operationId: `worker:${worker.attemptId}`,
        traceId: worker.runId,
        spaceId: "",
        userId: "",
        runId: worker.runId,
        signal: new AbortController().signal,
      };
      const unconfirmed = await deps.prisma.attempt.count({
        where: {
          runId: worker.runId,
          id: { not: worker.attemptId },
          workerState: { in: [...LIVE_WORKER_STATES, "releasing"] },
        },
      });
      if (unconfirmed > 0) {
        throw new AgentRuntimeUnavailableError(
          "An earlier worker of this run is not confirmed gone",
        );
      }
      const plan = await deps.lifecycle.plan({
        attemptId: worker.attemptId,
        needs: deps.needs ?? NO_NEEDS,
      });
      if (plan.mode !== "worker") {
        throw new Error(
          `This run cannot get a worker: ${plan.mode === "refused" ? plan.refusal.code : plan.reason}`,
        );
      }
      const started = await deps.lifecycle.start(plan, context).catch((error: unknown) => {
        if (error instanceof VolumeBusyError) throw new AgentRuntimeUnavailableError(error.message);
        throw error;
      });
      const guest = deps.connector.connect(
        { attemptId: worker.attemptId, providerRef: started.providerRef },
        capability,
      );
      return {
        start: started.start,
        ...guest,
        release: () => deps.lifecycle.release(worker.attemptId, context),
      };
    },
  };
}
