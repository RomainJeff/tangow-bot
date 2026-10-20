import type { AdapterContext, AgentRuntime } from "@rakazo/adapter-kit";
import type { LaunchPlan, RunNeeds, WorkerLaunch } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { WorkerLifecycle } from "../worker-lifecycle.js";
import { createCapabilityKey } from "./capability.js";
import { WORKER_NATIVE_TOOLS } from "./guest-input.js";
import { createLifecycleLauncher, type GuestConnector, type WorkerLauncher } from "./launcher.js";
import { createSession, type WorkerClock } from "./session.js";
import { createStopJournal, type StopJournal } from "./stop-journal.js";

const realClock: WorkerClock = {
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.();
    }),
};

/**
 * The run's agent harness lives in a guest VM, one per attempt. The executor keeps every
 * authority: this runtime turns guest frames into its events and callbacks, refuses what the
 * guest may not choose, measures usage on the model relay, and confirms the guest's stop.
 */
export function createWorkerAgentRuntime(options: {
  launcher: WorkerLauncher;
  stops: StopJournal;
  clock?: WorkerClock;
}): AgentRuntime {
  const key = createCapabilityKey();
  const sessions = new Map<string, ReturnType<typeof createSession>>();
  const deps = {
    key,
    launcher: options.launcher,
    stops: options.stops,
    clock: options.clock ?? realClock,
  };
  return {
    describe() {
      return {
        id: "worker",
        contractVersion: "1",
        adapterVersion: "0.1.0",
        capabilities: {
          streaming: true,
          compaction: true,
          tools: true,
          scripted: false,
          localTools: WORKER_NATIVE_TOOLS,
        },
      };
    },
    async abort(runId) {
      const session = sessions.get(runId);
      if (!session) return;
      session.cancel(new Error("The run was cancelled"));
      await session.stop(undefined);
    },
    async *run(request, context) {
      if (request.script) throw new Error("A worker run cannot follow a script");
      const session = createSession(request, deps);
      sessions.set(request.runId, session);
      const onAbort = () => session.cancel(new Error("The run was cancelled"));
      context?.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await session.open();
        while (true) {
          const event = await session.events.next();
          if (!event) return;
          yield event;
        }
      } finally {
        context?.signal?.removeEventListener("abort", onAbort);
        await session.stop(context?.signal);
        if (sessions.get(request.runId) === session) sessions.delete(request.runId);
      }
    },
  };
}

/** What the executor needs to run a product run in a worker: a plan, then a runtime bound to it. */
export interface RunWorkers {
  plan(input: { attemptId: string; needs: RunNeeds }): Promise<LaunchPlan>;
  runtime(launch: WorkerLaunch): AgentRuntime;
  /** Creates the volumes a computer whose home is on volumes lacks, before it mounts them. */
  provisionHomeVolumes(computerId: string, context: AdapterContext): Promise<void>;
}

export function createRunWorkers(deps: {
  prisma: PrismaClient;
  lifecycle: WorkerLifecycle;
  connector: GuestConnector;
  clock?: WorkerClock;
}): RunWorkers {
  const stops = createStopJournal(deps.prisma);
  return {
    plan: (input) => deps.lifecycle.plan(input),
    provisionHomeVolumes: (computerId, context) =>
      deps.lifecycle.provisionHomeVolumes(computerId, context),
    runtime: (launch) =>
      createWorkerAgentRuntime({
        launcher: createLifecycleLauncher({ ...deps, launch }),
        stops,
        clock: deps.clock,
      }),
  };
}
