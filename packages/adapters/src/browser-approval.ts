import type { JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { computerSleepJob } from "@rakazo/adapter-kit";
import type { BrowserApprovalCheckpoint, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  BROWSER_APPROVAL_CHECKPOINT_PREFIX,
  browserApprovalCheckpointOf,
  cancelRunsInTransaction,
  Prisma,
} from "@rakazo/db";
import { hasActiveComputerControl } from "./computer-control.js";
import { releaseBotScreen } from "./computer-lifecycle.js";

type CleanupDeps = {
  prisma: PrismaClient;
  sandbox: Pick<SandboxProvider, "releaseScreen">;
  events: Pick<ThreadEvents, "append">;
};

export function scheduleBrowserApprovalCleanup(
  jobs: JobPublisher,
  runId: string,
  hold: BrowserApprovalCheckpoint,
  at = new Date(hold.deadline),
) {
  return jobs.enqueue({
    ...computerSleepJob(hold.computerId, at),
    replaceKey: `browser-approval:${runId}`,
  });
}

/** The exact checkpoint remains the cleanup receipt until fenced provider release succeeds. */
export async function releaseBrowserApprovalScreen(
  deps: CleanupDeps,
  runId: string,
  checkpoint: string,
  owner?: { workerId: string; fence: number },
): Promise<boolean> {
  const hold = browserApprovalCheckpointOf(checkpoint);
  if (!hold) return false;
  const candidate = await deps.prisma.run.findUnique({ where: { id: runId } });
  if (!candidate || candidate.checkpoint !== checkpoint) return false;
  const released = await deps.prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${candidate.threadId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`;
      const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
      if (run.checkpoint !== checkpoint) return false;
      const terminal = ["completed", "failed", "cancelled"].includes(run.status);
      if (
        !terminal &&
        (!owner || run.leaseOwner !== owner.workerId || run.leaseFence !== owner.fence)
      )
        return false;
      await tx.$queryRaw`SELECT id FROM computers WHERE id = ${hold.computerId} FOR UPDATE`;
      const computer = await tx.computer.findUnique({ where: { id: hold.computerId } });
      if (computer?.controlBotId === run.botId && hasActiveComputerControl(computer)) return false;
      // Hold the run lock through teardown when retiring a checkpoint before another pause.
      // A continuation must not claim the old page while that release is in flight.
      if (
        !(await releaseBotScreen({ prisma: tx, sandbox: deps.sandbox }, hold.computer, {
          operationId: "browser-approval.release",
          traceId: runId,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: run.botId,
          runId,
          screenLeaseId: hold.screenLeaseId,
          signal: new AbortController().signal,
        }))
      )
        return false;
      if (hold.lease) {
        await tx.computerExecutionLease.updateMany({
          where: hold.lease,
          data: { expiresAt: new Date(0) },
        });
      }
      const cleared = await tx.run.updateMany({
        where: { id: runId, checkpoint },
        data: { checkpoint: null },
      });
      return cleared.count === 1;
    },
    { timeout: 150_000 },
  );
  if (released) {
    const bot = await deps.prisma.bot.findUnique({
      where: { id: candidate.botId },
      select: { computer: { select: { state: true } } },
    });
    if (bot?.computer)
      await deps.events
        .append({
          spaceId: candidate.spaceId,
          threadId: candidate.threadId,
          botId: candidate.botId,
          type: "computer.status",
          payload: { status: bot.computer.state },
        })
        .catch(() => undefined);
  }
  return released;
}

export async function recoverBrowserApprovalScreens(
  deps: CleanupDeps & { jobs?: JobPublisher },
  filter: { computerId?: string; runIds?: string[] } = {},
) {
  if (filter.runIds?.length === 0) return;
  let cursor = "";
  for (;;) {
    // Parse only valid JSON, and match the captured top-level coordinate, even after bot moves.
    const ids = await deps.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM runs
      WHERE starts_with(checkpoint, ${BROWSER_APPROVAL_CHECKPOINT_PREFIX})
        AND id > ${cursor}
        ${filter.runIds ? Prisma.sql`AND id IN (${Prisma.join(filter.runIds)})` : Prisma.empty}
        ${
          filter.computerId
            ? Prisma.sql`AND CASE WHEN checkpoint IS JSON OBJECT
          THEN checkpoint::jsonb ->> 'computerId' END = ${filter.computerId}`
            : Prisma.empty
        }
      ORDER BY id LIMIT 50`);
    if (ids.length === 0) return;
    cursor = ids[ids.length - 1]!.id;
    const runs = await deps.prisma.run.findMany({
      where: { id: { in: ids.map(({ id }) => id) } },
    });
    for (const candidate of runs) {
      const hold = browserApprovalCheckpointOf(candidate.checkpoint);
      if (!hold || (filter.computerId && hold.computerId !== filter.computerId)) continue;
      const checkpoint = candidate.checkpoint;
      if (!checkpoint) continue;
      const terminal = await deps.prisma.$transaction(async (tx) => {
        // Same thread -> run lock order as pause, claim, Stop, Clear and Rewind.
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${candidate.threadId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM runs WHERE id = ${candidate.id} FOR UPDATE`;
        const run = await tx.run.findUniqueOrThrow({ where: { id: candidate.id } });
        if (run.checkpoint !== checkpoint) return false;
        if (["completed", "failed", "cancelled"].includes(run.status)) return true;
        if (run.leaseExpiresAt && run.leaseExpiresAt.getTime() > Date.now()) return false;
        if (hold.deadline > Date.now()) return false;
        await cancelRunsInTransaction(tx, [run], new Date());
        return true;
      });
      if (terminal && (await releaseBrowserApprovalScreen(deps, candidate.id, checkpoint)))
        continue;
      if (deps.jobs)
        await scheduleBrowserApprovalCleanup(
          deps.jobs,
          candidate.id,
          hold,
          new Date(Math.max(hold.deadline, Date.now() + 30_000)),
        );
    }
  }
}
