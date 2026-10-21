import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { scheduleComputerSleep } from "./computer-idle.js";
import type { ComputerExecutionLease } from "./computer-lifecycle.js";
import {
  acquireComputerExecutionLease,
  holdComputerExecutionLeaseForTakeover,
  provisionComputer,
  releaseBotScreen,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
  screenLeaseIdForRun,
} from "./computer-lifecycle.js";

type Acquiring = {
  phase: "acquiring";
  lease: ComputerExecutionLease | null;
  ready: Promise<ComputerRef>;
};

type RunComputerState =
  | { phase: "idle" }
  | Acquiring
  | { phase: "ready"; lease: ComputerExecutionLease | null; computer: ComputerRef }
  | { phase: "released" };

export type RunComputer = ReturnType<typeof createRunComputer>;

/**
 * A run's hold on its bot's computer: the execution lease, then the machine. `use` takes both
 * once, however many calls race for them, and a failure lets both go so a later call can retry.
 * `release` waits out a take in flight, then lets go for good.
 */
export function createRunComputer(
  deps: Parameters<typeof provisionComputer>[0],
  run: {
    computerId: string;
    runId: string;
    botId: string;
    fence: number;
    resumeHeldLease: boolean;
    context: AdapterContext;
  },
) {
  let state: RunComputerState = { phase: "idle" };
  const lease = () => (state.phase === "acquiring" || state.phase === "ready" ? state.lease : null);

  async function take(acquiring: Acquiring): Promise<ComputerRef> {
    try {
      acquiring.lease = await acquireComputerExecutionLease(deps.prisma, {
        computerId: run.computerId,
        runId: run.runId,
        botId: run.botId,
        resumeHeldLease: run.resumeHeldLease,
      });
      // Computer calls claim their screen slot under the context's lease id, known only now.
      run.context.screenLeaseId = screenLeaseIdForRun(acquiring.lease, run.runId, run.fence);
      const computer = await provisionComputer(deps, run.computerId, run.context, "bot");
      scheduleComputerSleep(deps.jobs, run.computerId);
      state = { phase: "ready", lease: acquiring.lease, computer };
      return computer;
    } catch (error) {
      await releaseComputerExecutionLease(deps.prisma, acquiring.lease).catch(() => undefined);
      state = { phase: "idle" };
      throw error;
    }
  }

  return {
    use(): Promise<ComputerRef> {
      if (state.phase === "ready") return Promise.resolve(state.computer);
      if (state.phase === "acquiring") return state.ready;
      if (state.phase === "released") {
        return Promise.reject(new Error("The run has let go of its computer"));
      }
      const acquiring: Acquiring = {
        phase: "acquiring",
        lease: null,
        ready: Promise.resolve().then(() => take(acquiring)),
      };
      state = acquiring;
      return acquiring.ready;
    },
    current(): ComputerRef | null {
      return state.phase === "ready" ? state.computer : null;
    },
    renew: () => renewComputerExecutionLease(deps.prisma, lease()),
    holdForTakeover: () => holdComputerExecutionLeaseForTakeover(deps.prisma, lease()),
    async release(): Promise<void> {
      while (state.phase === "acquiring") await state.ready.catch(() => undefined);
      const held = state;
      state = { phase: "released" };
      if (held.phase !== "ready") return;
      await releaseBotScreen(deps, held.computer, run.context);
      await releaseComputerExecutionLease(deps.prisma, held.lease).catch(() => undefined);
    },
  };
}
