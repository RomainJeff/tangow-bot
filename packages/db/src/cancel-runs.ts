import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { Prisma } from "./client.js";
import { appendRunFinishedInTransaction } from "./sessions.js";

/**
 * Close the logs of runs about to be cancelled. It goes before the status flips: the log takes no
 * entry for a cancelled run. The runs' threads lock first, in id order, so two cancels that share
 * threads cannot deadlock.
 */
export async function logCancelledRunsInTransaction(
  tx: Prisma.TransactionClient,
  runIds: readonly string[],
  by?: string,
): Promise<void> {
  if (runIds.length === 0) return;
  await tx.$queryRaw`
    SELECT id FROM threads WHERE id IN (SELECT "threadId" FROM runs WHERE id IN (${Prisma.join(runIds)}))
    ORDER BY id FOR UPDATE`;
  for (const runId of runIds) {
    await appendRunFinishedInTransaction(tx, runId, { status: "cancelled", by });
  }
}

/** The caller selects authorized runs and owns the surrounding transaction and cleanup. */
export async function cancelRunsInTransaction(
  tx: Prisma.TransactionClient,
  runs: ReadonlyArray<{ id: string; taskId: string }>,
  cancelledAt: Date,
  by?: string,
): Promise<void> {
  if (runs.length === 0) return;
  const runIds = runs.map((run) => run.id);
  await logCancelledRunsInTransaction(tx, runIds, by);
  await tx.run.updateMany({
    where: { id: { in: runIds }, status: { in: [...ACTIVE_RUN_STATUSES] } },
    data: {
      status: "cancelled",
      completedAt: cancelledAt,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  await tx.attempt.updateMany({
    where: { runId: { in: runIds }, status: { in: ["setting_up", "running"] } },
    data: { status: "cancelled", finishedAt: cancelledAt },
  });
  await tx.task.updateMany({
    where: { id: { in: runs.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
}
