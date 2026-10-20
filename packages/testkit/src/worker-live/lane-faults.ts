import type { AdapterDescriptor, WorkerCapabilities } from "@rakazo/adapter-kit";
import { Sandbox } from "e2b";
import { call, finish, liveRun } from "./run.js";
import { context, type Lane, type Live, type ProviderWrap } from "./session.js";

function faulty(
  live: Live,
  fault: "kill_after_ensure" | "throw_after_create" | "prepare_fails",
): { wrap: ProviderWrap; fired: () => boolean } {
  let fired = false;
  const wrap: ProviderWrap = (provider) => ({
    describe: (): AdapterDescriptor<WorkerCapabilities> => provider.describe(),
    destroy: (target, ctx) => provider.destroy(target, ctx),
    ensureVolume: (input, ctx) => provider.ensureVolume(input, ctx),
    connect: (target, capability) => provider.connect(target, capability),
    async ensure(spec, ctx) {
      const made = await provider.ensure(spec, ctx);
      if (fired) return made;
      if (fault === "kill_after_ensure") {
        fired = true;
        await Sandbox.kill(made.providerRef, live.connection);
      }
      if (fault === "throw_after_create") {
        fired = true;
        throw new Error("The controller lost the create response");
      }
      return made;
    },
    async prepare(providerRef, spec, ctx) {
      if (fault === "prepare_fails" && !fired) {
        fired = true;
        throw new Error("Setup failed after the VM was created");
      }
      return provider.prepare(providerRef, spec, ctx);
    },
  });
  return { wrap, fired: () => fired };
}

export const laneG: Lane = {
  id: "g",
  issue: "panne après provisioning",
  scenario:
    "Three faults right after the VM exists: the VM is killed after ensure, ensure fails after the create landed, setup fails after the ref was recorded; then a controller that dies after start, cleaned up by reconcile",
  passWhen:
    "A recorded ref is destroyed at once and its lease freed; a create whose answer was lost keeps its lease until reconcile destroys it by tag after the ensure deadline; a lost guest retries to completion; no sandbox is left",
  async run(live) {
    const cases: Record<string, unknown> = {};
    let pass = true;
    for (const fault of ["kill_after_ensure", "throw_after_create", "prepare_fails"] as const) {
      const injected = faulty(live, fault);
      const worker = await liveRun(live, {
        wrap: injected.wrap,
        files: { private: true, shared: false },
        steps: [call("ok", "bash", { command: "echo recovered" }), ...finish("Recovered")],
      });
      try {
        const runId = await worker.run.send("Run after a fault.");
        const first = await worker.run.continueRun(runId).then(
          () => "completed",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        const afterFault = await worker.attempts(runId);
        const statusAfterFault = await worker.status(runId);
        const leases = await worker.run.prisma.volume.count({
          where: { writerAttemptId: { not: null } },
        });
        const aliveAfterFault = (await live.census()).sandboxes;
        if (statusAfterFault === "queued") {
          await worker.run.continueRun(runId);
          await worker.completed(runId);
        }
        // A create whose answer was lost may still land, so release leaves it to reconcile after
        // the ensure deadline. Move that deadline into the past instead of waiting it out.
        let afterEnsureDeadline: Record<string, unknown> | undefined;
        if (fault === "throw_after_create") {
          await worker.run.prisma.attempt.updateMany({
            where: { runId },
            data: { workerEnsureAt: new Date(Date.now() - 16 * 60 * 1000) },
          });
          const reconciled = await worker.lifecycle.reconcile({ limit: 10 }, context("g"));
          afterEnsureDeadline = {
            reconciled,
            workerState: (await worker.attempts(runId))[0]?.workerState,
            writerLeasesHeld: await worker.run.prisma.volume.count({
              where: { writerAttemptId: { not: null } },
            }),
            sandboxesAlive: (await live.census()).sandboxes,
          };
        }
        const attempts = await worker.attempts(runId);
        const record = {
          faultFired: injected.fired(),
          firstContinue: first,
          statusAfterFault,
          faultedAttempt: {
            workerState: afterFault[0]?.workerState,
            providerRefRecorded: Boolean(afterFault[0]?.workerProviderRef),
          },
          writerLeasesHeldAfterFault: leases,
          sandboxesAliveAfterFault: aliveAfterFault,
          ...(afterEnsureDeadline && { afterEnsureDeadline }),
          finalStatus: await worker.status(runId),
          attempts: attempts.map(({ workerState, stopPhase }) => ({ workerState, stopPhase })),
          sandboxesLeft: (await live.census()).sandboxes,
        };
        cases[fault] = record;
        // Only a lost guest makes the runtime unavailable: the launcher passes an error from
        // ensure or prepare through, and the run fails.
        const expected = {
          kill_after_ensure: {
            state: "released",
            ref: true,
            leases: 0,
            alive: 0,
            status: "completed",
          },
          throw_after_create: {
            state: "releasing",
            ref: false,
            leases: 1,
            alive: 1,
            status: "failed",
          },
          prepare_fails: { state: "released", ref: true, leases: 0, alive: 0, status: "failed" },
        }[fault];
        pass &&=
          record.faultFired &&
          record.faultedAttempt.workerState === expected.state &&
          record.faultedAttempt.providerRefRecorded === expected.ref &&
          leases === expected.leases &&
          aliveAfterFault === expected.alive &&
          record.finalStatus === expected.status &&
          record.sandboxesLeft === 0 &&
          (fault !== "throw_after_create" ||
            JSON.stringify(afterEnsureDeadline) ===
              JSON.stringify({
                reconciled: { released: 1, awaitingEnsure: 0, failed: 0 },
                workerState: "released",
                writerLeasesHeld: 0,
                sandboxesAlive: 0,
              }));
      } finally {
        await worker.close();
      }
    }

    // A controller that dies once its worker started: the run's lease lapses, reconcile destroys.
    const worker = await liveRun(live, { steps: [], files: { private: true, shared: false } });
    try {
      const { prisma } = worker.run;
      const runId = await worker.run.send("Never run.");
      await prisma.run.update({
        where: { id: runId },
        data: {
          status: "running",
          leaseOwner: "lost-controller",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const attempt = await prisma.attempt.create({ data: { runId, fence: 1, status: "running" } });
      const plan = await worker.lifecycle.plan({
        attemptId: attempt.id,
        needs: { files: { private: "rw", shared: null }, computer: "none" },
      });
      if (plan.mode !== "worker") throw new Error(`No worker plan: ${plan.mode}`);
      await worker.lifecycle.start(plan, context("g-reconcile"));
      const aliveBefore = (await live.census()).sandboxes;
      const leaseBefore = await prisma.volume.count({ where: { writerAttemptId: attempt.id } });
      await prisma.run.update({
        where: { id: runId },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      const reconciled = await worker.lifecycle.reconcile({ limit: 10 }, context("g-reconcile"));
      const row = await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } });
      const record = {
        sandboxesAliveBeforeReconcile: aliveBefore,
        writerLeaseBeforeReconcile: leaseBefore,
        reconciled,
        workerState: row.workerState,
        writerLeasesAfter: await prisma.volume.count({ where: { writerAttemptId: { not: null } } }),
        sandboxesLeft: (await live.census()).sandboxes,
      };
      cases.controller_lost_after_start = record;
      pass &&=
        aliveBefore === 1 &&
        leaseBefore === 1 &&
        reconciled.released === 1 &&
        row.workerState === "released" &&
        record.writerLeasesAfter === 0 &&
        record.sandboxesLeft === 0;
    } finally {
      await worker.close();
    }
    return { pass, observed: cases };
  },
};

/** A team home of two bots: shared files, each bot's files, an executable and a private key file. */
