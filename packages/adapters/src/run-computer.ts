import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import type { BrowserApprovalCheckpoint } from "@rakazo/db";
import { scheduleComputerSleep } from "./computer-idle.js";
import type { ComputerExecutionLease } from "./computer-lifecycle.js";
import {
  acquireComputerExecutionLease,
  ComputerBusyError,
  holdComputerExecutionLeaseForTakeover,
  provisionComputer,
  releaseBotScreen,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
  screenLeaseIdForRun,
  waitOutComputerTransition,
} from "./computer-lifecycle.js";

type Acquiring = {
  phase: "acquiring";
  lease: ComputerExecutionLease | null;
  ready: Promise<ComputerRef>;
};

type RunComputerState =
  | { phase: "idle"; lease: ComputerExecutionLease | null }
  | Acquiring
  | {
      phase: "ready";
      lease: ComputerExecutionLease | null;
      computer: ComputerRef;
      context: AdapterContext;
    }
  | { phase: "released" };

/**
 * A run's hold on its bot's computer: the execution lease, then the machine. `start` and `use`
 * take both once, however many calls race for them, and a failure lets both go so a later call
 * can retry. `use` also waits out a start or a suspend someone else is running. `release` waits
 * out a take in flight, then lets go for good.
 */
export function createRunComputer(
  deps: Parameters<typeof provisionComputer>[0],
  run: {
    computerId: string;
    runId: string;
    botId: string;
    fence: number;
    resumeHeldLease: boolean;
    approvalHold?: BrowserApprovalCheckpoint | null;
    spaceId: string;
    userId: string;
  },
) {
  let state: RunComputerState = run.approvalHold
    ? {
        phase: "ready",
        lease: run.approvalHold.lease,
        computer: run.approvalHold.computer,
        context: {
          operationId: run.runId,
          traceId: run.runId,
          botId: run.botId,
          runId: run.runId,
          spaceId: run.spaceId,
          userId: run.userId,
          screenLeaseId: run.approvalHold.screenLeaseId,
          signal: new AbortController().signal,
        },
      }
    : { phase: "idle", lease: null };
  const lease = () => (state.phase === "released" ? null : state.lease);
  const acquireLease = () =>
    acquireComputerExecutionLease(deps.prisma, {
      computerId: run.computerId,
      runId: run.runId,
      botId: run.botId,
      resumeHeldLease: run.resumeHeldLease,
    });

  async function provision(acquiring: Acquiring, context: AdapterContext): Promise<ComputerRef> {
    acquiring.lease ??= await acquireLease();
    // Computer calls claim their screen slot under the context's lease id, known only now.
    context.screenLeaseId = screenLeaseIdForRun(acquiring.lease, run.runId, run.fence);
    const computer = await provisionComputer(deps, run.computerId, context, "bot");
    scheduleComputerSleep(deps.jobs, run.computerId);
    state = { phase: "ready", lease: acquiring.lease, computer, context };
    return computer;
  }

  async function take(
    acquiring: Acquiring,
    context: AdapterContext,
    waitOutTransition: boolean,
  ): Promise<ComputerRef> {
    try {
      try {
        return await provision(acquiring, context);
      } catch (error) {
        const transient = error instanceof ComputerBusyError && error.reason === "transition";
        if (!waitOutTransition || !transient) throw error;
        await waitOutComputerTransition(deps.prisma, run.computerId, context.signal);
        return await provision(acquiring, context);
      }
    } catch (error) {
      const held = acquiring.lease;
      state = { phase: "idle", lease: null };
      await releaseComputerExecutionLease(deps.prisma, held).catch(() => undefined);
      throw error;
    }
  }

  function acquire(context: AdapterContext, waitOutTransition: boolean): Promise<ComputerRef> {
    if (state.phase === "ready") {
      context.screenLeaseId = state.context.screenLeaseId;
      state.context = context;
      return Promise.resolve(state.computer);
    }
    if (state.phase === "acquiring") return state.ready;
    if (state.phase === "released") {
      return Promise.reject(new Error("The run has let go of its computer"));
    }
    const acquiring: Acquiring = {
      phase: "acquiring",
      lease: state.lease,
      ready: Promise.resolve().then(() => take(acquiring, context, waitOutTransition)),
    };
    state = acquiring;
    return acquiring.ready;
  }

  return {
    /** Takes the lease a takeover held now, so that however the run ends, its end lets it go. */
    async holdLease(): Promise<void> {
      if (state.phase !== "idle" || state.lease) return;
      state = { phase: "idle", lease: await acquireLease() };
    },
    start: (context: AdapterContext) => acquire(context, false),
    use: (context: AdapterContext) => acquire(context, true),
    current(): ComputerRef | null {
      return state.phase === "ready" ? state.computer : null;
    },
    releasedApprovalHold() {
      state = { phase: "idle", lease: null };
    },
    approvalCheckpoint(effectId: string, deadline: number): BrowserApprovalCheckpoint | null {
      if (state.phase !== "ready" || !state.context.screenLeaseId) return null;
      return {
        kind: "browser_approval_v1",
        effectId,
        computerId: run.computerId,
        computer: state.computer,
        screenLeaseId: state.context.screenLeaseId,
        lease: state.lease,
        runFence: run.fence,
        deadline,
      };
    },
    async renew(): Promise<boolean> {
      const held = lease();
      return (await renewComputerExecutionLease(deps.prisma, held)) || held !== lease();
    },
    holdForTakeover: () => holdComputerExecutionLeaseForTakeover(deps.prisma, lease()),
    async release(): Promise<void> {
      while (state.phase === "acquiring") await state.ready.catch(() => undefined);
      const held = state;
      state = { phase: "released" };
      if (held.phase === "released") return;
      if (held.phase === "ready") await releaseBotScreen(deps, held.computer, held.context);
      await releaseComputerExecutionLease(deps.prisma, held.lease).catch(() => undefined);
    },
  };
}
