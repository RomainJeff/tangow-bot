import { Sandbox } from "e2b";
import { toolResult } from "../file-task.js";
import { call, finish, liveRun } from "./run.js";
import type { Lane, Live, ProviderWrap } from "./session.js";
import { context, forward } from "./session.js";

/** A provider whose ensure, or the step after it, fails the way `fault` says, once. */
function faulty(
  live: Live,
  fault: "kill_after_ensure" | "throw_after_create" | "prepare_fails",
): { wrap: ProviderWrap; fired: () => boolean } {
  let fired = false;
  const wrap: ProviderWrap = (provider) =>
    forward(provider, {
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
    "A recorded ref is destroyed at once and its attempt released; a create whose answer was lost stays releasing until reconcile destroys it by tag after the ensure deadline; every faulted run completes, a failed setup through a requeue under the run's setup budget; no sandbox is left",
  async run(live) {
    const cases: Record<string, unknown> = {};
    let pass = true;
    for (const fault of ["kill_after_ensure", "throw_after_create", "prepare_fails"] as const) {
      const injected = faulty(live, fault);
      const worker = await liveRun(live, {
        wrap: injected.wrap,
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
        const aliveAfterFault = (await live.census()).sandboxes;
        // A create whose answer was lost may still land, so release leaves it to reconcile after
        // the ensure deadline, and the same-run guard holds the next attempt off until then. Move
        // that deadline into the past instead of waiting it out.
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
            sandboxesAlive: (await live.census()).sandboxes,
          };
        }
        // A failed setup requeues the run under its budget of three; the retry runs it.
        let retries = 0;
        while ((await worker.status(runId)) === "queued" && retries < 3) {
          retries += 1;
          await worker.run.continueRun(runId);
        }
        await worker.completed(runId);
        const attempts = await worker.attempts(runId);
        const record = {
          faultFired: injected.fired(),
          firstContinue: first,
          statusAfterFault,
          faultedAttempt: {
            workerState: afterFault[0]?.workerState,
            providerRefRecorded: Boolean(afterFault[0]?.workerProviderRef),
          },
          sandboxesAliveAfterFault: aliveAfterFault,
          ...(afterEnsureDeadline && { afterEnsureDeadline }),
          retries,
          finalStatus: await worker.status(runId),
          attempts: attempts.map(({ workerState, stopPhase }) => ({ workerState, stopPhase })),
          sandboxesLeft: (await live.census()).sandboxes,
        };
        cases[fault] = record;
        // Every fault ends in a completed run: a lost guest retries within its attempt, and an
        // error from ensure or prepare requeues the run under its setup budget.
        const expected = {
          kill_after_ensure: { state: "released", ref: true, alive: 0 },
          throw_after_create: { state: "releasing", ref: false, alive: 1 },
          prepare_fails: { state: "released", ref: true, alive: 0 },
        }[fault];
        pass &&=
          record.faultFired &&
          record.faultedAttempt.workerState === expected.state &&
          record.faultedAttempt.providerRefRecorded === expected.ref &&
          aliveAfterFault === expected.alive &&
          record.finalStatus === "completed" &&
          record.sandboxesLeft === 0 &&
          (fault !== "throw_after_create" ||
            JSON.stringify(afterEnsureDeadline) ===
              JSON.stringify({
                reconciled: { released: 1, awaitingEnsure: 0, failed: 0 },
                workerState: "released",
                sandboxesAlive: 0,
              }));
      } finally {
        await worker.close();
      }
    }

    // A controller that dies once its worker started: the run's lease lapses, reconcile destroys.
    const worker = await liveRun(live, { steps: [] });
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
      const before = await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } });
      await prisma.run.update({
        where: { id: runId },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      const reconciled = await worker.lifecycle.reconcile({ limit: 10 }, context("g-reconcile"));
      const row = await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } });
      const record = {
        beforeReconcile: {
          workerState: before.workerState,
          providerRefRecorded: Boolean(before.workerProviderRef),
          runLeaseExpired: true,
        },
        sandboxesAliveBeforeReconcile: aliveBefore,
        reconciled,
        workerState: row.workerState,
        sandboxesLeft: (await live.census()).sandboxes,
      };
      cases.controller_lost_after_start = record;
      pass &&=
        before.workerState === "ready" &&
        Boolean(before.workerProviderRef) &&
        aliveBefore === 1 &&
        reconciled.released === 1 &&
        row.workerState === "released" &&
        record.sandboxesLeft === 0;
    } finally {
      await worker.close();
    }
    return { pass, observed: cases };
  },
};

const SHORT_TIMEOUT_MS = 20_000;

export const laneGTimeout: Lane = {
  id: "g-timeout",
  issue: "panne après provisioning (VM tuée au timeout)",
  scenario: `A provider whose deployment allows a ${SHORT_TIMEOUT_MS / 1000} s sandbox timeout, below the worker TTL; the guest sleeps in bash past it, so E2B kills the VM mid-call`,
  passWhen:
    "E2B kills the VM, the attempt ends released with its bash effect never rerun, and the run completes on a new attempt",
  async run(live) {
    let retried = "";
    const worker = await liveRun(live, {
      provider: () => live.workerProvider(SHORT_TIMEOUT_MS),
      steps: [
        call("nap", "bash", {
          command: `printf 'started\\n' >> timeout-started; sleep ${(SHORT_TIMEOUT_MS / 1000) * 3}; printf 'completed\\n' >> timeout-completed`,
        }),
        // Native recovery explicitly inspects, never replays.
        call("nap", "bash", {
          command:
            "cat timeout-started; if test -e timeout-completed; then cat timeout-completed; fi; printf 'recovered\\n'",
        }),
        ...finish("Recovered after the VM was killed", (request) => {
          retried = toolResult(request);
        }),
      ],
    });
    try {
      const { prisma } = worker.run;
      const runId = await worker.run.send("Sleep past the sandbox timeout.");
      const started = performance.now();
      const first = await worker.run.continueRun(runId).then(
        () => "completed",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      const killedAfterMs = Math.round(performance.now() - started);
      const afterKill = {
        status: await worker.status(runId),
        attempts: (await worker.attempts(runId)).map(({ workerState, stopPhase }) => ({
          workerState,
          stopPhase,
        })),
        sandboxesAlive: (await live.census()).sandboxes,
        bashEffect: (await prisma.externalEffect.findFirst({ where: { runId, kind: "bash" } }))
          ?.status,
      };
      if (afterKill.status === "queued") await worker.run.continueRun(runId);
      const effects = await prisma.externalEffect.findMany({
        where: { runId },
        select: { kind: true, status: true },
        orderBy: { createdAt: "asc" },
      });
      let markers: { started: string; completed: boolean };
      const files = live.volumeFiles();
      try {
        markers = {
          started: new TextDecoder().decode(
            await files.read(worker.volumes.private!, "timeout-started", context("g-timeout")),
          ),
          completed: (await files.list(worker.volumes.private!, context("g-timeout"))).some(
            (entry) => entry.path === "timeout-completed",
          ),
        };
      } finally {
        await files.close();
      }
      const final = {
        status: await worker.status(runId),
        attempts: (await worker.attempts(runId)).map(({ workerState }) => workerState),
        effects,
        sandboxesLeft: (await live.census()).sandboxes,
      };
      if (final.status === "completed") worker.run.model.assertComplete();
      const pass =
        afterKill.status === "queued" &&
        afterKill.attempts.length === 1 &&
        afterKill.attempts[0]?.workerState === "released" &&
        afterKill.sandboxesAlive === 0 &&
        final.status === "completed" &&
        final.attempts.length === 2 &&
        markers.started === "started\n" &&
        !markers.completed &&
        retried.includes("recovered") &&
        final.attempts.every((state) => state === "released") &&
        // Only an uploaded guest connects to the VM before it starts, which must not extend its life.
        (live.config.guestBundle === undefined ||
          (live.guestUploadDeadlines.length === 2 &&
            live.guestUploadDeadlines.every(
              (deadline) =>
                deadline.timeoutMs <= SHORT_TIMEOUT_MS &&
                Date.parse(deadline.after) - Date.parse(deadline.before) <= 1_000,
            ))) &&
        final.sandboxesLeft === 0;
      return {
        pass,
        observed: {
          sandboxTimeoutMs: SHORT_TIMEOUT_MS,
          firstContinue: first,
          firstAttemptEndedAfterMs: killedAfterMs,
          afterKill,
          retriedCallResult: retried,
          nativeMarkers: markers,
          guestUploadDeadlines: live.guestUploadDeadlines,
          final,
        },
      };
    } finally {
      await worker.close();
    }
  },
};
