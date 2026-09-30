import type { Prisma } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";

/** The caller selects authorized runs and owns the surrounding transaction and cleanup. */
export async function cancelRunsInTransaction(
  tx: Pick<Prisma.TransactionClient, "run" | "attempt" | "task">,
  runs: ReadonlyArray<{ id: string; taskId: string }>,
  cancelledAt: Date,
): Promise<void> {
  if (runs.length === 0) return;
  const runIds = runs.map((run) => run.id);
  await tx.run.updateMany({
    where: { id: { in: runIds } },
    data: {
      status: "cancelled",
      completedAt: cancelledAt,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  await tx.attempt.updateMany({
    where: { runId: { in: runIds }, status: "running" },
    data: { status: "cancelled", finishedAt: cancelledAt },
  });
  await tx.task.updateMany({
    where: { id: { in: runs.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
}

/**
 * Shared by a user-initiated stop (clear/rewind, `events.ts`) and delegated-work
 * cancellation (`delegated-tasks.ts`): cancels the given runs, then expires their
 * Computer execution lease as a fencing tombstone and clears the Computer's execution
 * pointer. This is the exact path the executor's heartbeat observes
 * (`renewComputerExecutionLease`, `executor.ts`) — a live native run's next heartbeat
 * tick fails to renew and aborts the runtime, instead of running on unsupervised after
 * its Run/Task rows are already terminal.
 */
export async function stopRunsInTransaction(
  tx: Pick<
    Prisma.TransactionClient,
    "run" | "attempt" | "task" | "computerExecutionLease" | "computer"
  >,
  runs: ReadonlyArray<{ id: string; taskId: string }>,
  stoppedAt: Date,
): Promise<void> {
  if (runs.length === 0) return;
  const runIds = runs.map((run) => run.id);
  await cancelRunsInTransaction(tx, runs, stoppedAt);
  await expireComputerExecutionLeases(tx, { runId: { in: runIds } });
  await tx.computer.updateMany({
    where: { executionRunId: { in: runIds } },
    data: {
      executionRunId: null,
      executionBotId: null,
      executionLeaseExpiresAt: null,
    },
  });
}
