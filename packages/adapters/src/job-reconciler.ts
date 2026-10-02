import type { SandboxProvider } from "@rakazo/adapter-kit";
import {
  type JobPublisher,
  messagingDeliverJob,
  routineWakeupJob,
  runContinueJob,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { WORK_TERMINAL_STATUSES } from "@rakazo/contracts";
import { botMessageContext } from "@rakazo/core";
import type { Pool, PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { PoolClient } from "pg";
import { returnBotMessageOutcome } from "./bot-messages.js";
import { scheduleComputerControlExpiry } from "./computer-control.js";
import { toComputerRef } from "./computer-support.js";
import { cleanupTerminalWork, deliverSpecialistRunEnd } from "./delegated-tasks.js";
import { isUserProgressClientNonce } from "./user-progress.js";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 100;
const ROUTINE_LOOKAHEAD_MS = 60_000;
const CONTROL_LOOKAHEAD_MS = 60_000;
// Two keys give Rakazo's lock a namespace without relying on a hash that might collide
// with an application using the one-key advisory-lock API.
const RECONCILIATION_LOCK_NAMESPACE = 1_380_019_075;
const RECONCILIATION_LOCK_ID = 1;

type Cursor = { at: Date; id: string };
type ControlCursor = { at: Date | null; id: string };

export interface ReconciliationLeadership {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}

/**
 * Holds a session advisory lock for the lifetime of the elected reconciler. Followers
 * retry on every reconciliation interval, so a disconnected or stopped leader is
 * replaced without coordinating through application state.
 */
export function createPostgresReconciliationLeadership(
  pool: Pick<Pool, "connect">,
  options: { lockId?: number } = {},
): ReconciliationLeadership {
  const lockId = options.lockId ?? RECONCILIATION_LOCK_ID;
  let leaderClient: PoolClient | undefined;
  let leaderErrorListener: (() => void) | undefined;

  const loseClient = (client: PoolClient) => {
    if (leaderClient !== client) return;
    leaderClient = undefined;
    leaderErrorListener = undefined;
    client.release(true);
  };

  return {
    async tryAcquire() {
      if (leaderClient) return true;

      const candidate = await pool.connect();
      try {
        const result = await candidate.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
          [RECONCILIATION_LOCK_NAMESPACE, lockId],
        );
        if (!result.rows[0]?.acquired) {
          candidate.release();
          return false;
        }

        leaderClient = candidate;
        leaderErrorListener = () => loseClient(candidate);
        candidate.once("error", leaderErrorListener);
        return true;
      } catch (error) {
        candidate.release(true);
        throw error;
      }
    },

    async release() {
      const client = leaderClient;
      if (!client) return;
      leaderClient = undefined;
      if (leaderErrorListener) client.removeListener("error", leaderErrorListener);
      leaderErrorListener = undefined;

      let destroy = false;
      try {
        const result = await client.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock($1::integer, $2::integer) AS released",
          [RECONCILIATION_LOCK_NAMESPACE, lockId],
        );
        destroy = result.rows[0]?.released !== true;
      } catch {
        // Never return a connection with an uncertain session lock to the pool.
        destroy = true;
      } finally {
        client.release(destroy);
      }
    },
  };
}

export function createJobReconciler(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    events?: ThreadEvents;
    sandbox?: SandboxProvider;
    leadership?: ReconciliationLeadership;
    reconcileComputerUpdates?: () => Promise<void>;
    reconcileCloudAgents?: () => Promise<void>;
  },
  options: { intervalMs?: number; batchSize?: number } = {},
) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reconciling: Promise<void> | undefined;
  let runCursor: Cursor | undefined;
  let routineCursor: Cursor | undefined;
  let controlCursor: ControlCursor | undefined;
  let controlScanDeadline: Date | undefined;

  const reconcileOnce = async () => {
    if (reconciling) return reconciling;
    reconciling = (async () => {
      if (deps.leadership && !(await deps.leadership.tryAcquire())) return;

      const auxiliary = await Promise.allSettled(
        [deps.reconcileCloudAgents, deps.reconcileComputerUpdates].map(async (reconcile) =>
          reconcile?.(),
        ),
      );
      for (const result of auxiliary) {
        if (result.status === "rejected")
          getLogger().error("auxiliary reconciliation", result.reason);
      }

      await reconcileTerminalWork(deps, batchSize);
      await reconcileSpecialistReturns(deps, batchSize);

      const now = new Date();
      controlScanDeadline ??= new Date(now.getTime() + CONTROL_LOOKAHEAD_MS);
      const runCursorFilter = runCursor
        ? {
            OR: [
              { updatedAt: { gt: runCursor.at } },
              { updatedAt: runCursor.at, id: { gt: runCursor.id } },
            ],
          }
        : undefined;
      const routineCursorFilter = routineCursor
        ? {
            OR: [
              { nextRunAt: { gt: routineCursor.at } },
              { nextRunAt: routineCursor.at, id: { gt: routineCursor.id } },
            ],
          }
        : undefined;
      const controlCursorFilter = controlCursor
        ? controlCursor.at
          ? {
              OR: [
                { controlLeaseExpiresAt: { gt: controlCursor.at } },
                {
                  controlLeaseExpiresAt: controlCursor.at,
                  id: { gt: controlCursor.id },
                },
                { controlLeaseExpiresAt: null },
              ],
            }
          : { controlLeaseExpiresAt: null, id: { gt: controlCursor.id } }
        : undefined;
      const [runs, routines, controls, dueOutbound, unmirroredMessagingRuns] = await Promise.all([
        deps.prisma.run.findMany({
          where: {
            AND: [
              {
                OR: [
                  { status: "queued" },
                  {
                    status: { in: ["leased", "running"] },
                    leaseExpiresAt: { lte: now },
                  },
                ],
              },
              // Do not revive old queued peer continuations after their work closes.
              {
                OR: [
                  { scopedTaskId: null },
                  { scopedTask: { is: { status: { notIn: [...WORK_TERMINAL_STATUSES] } } } },
                ],
              },
              ...(runCursorFilter ? [runCursorFilter] : []),
            ],
          },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: { id: true, updatedAt: true },
        }),
        deps.prisma.routine.findMany({
          where: {
            AND: [
              {
                active: true,
                nextRunAt: { lte: new Date(now.getTime() + ROUTINE_LOOKAHEAD_MS) },
              },
              ...(routineCursorFilter ? [routineCursorFilter] : []),
            ],
          },
          orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: { id: true, nextRunAt: true },
        }),
        deps.prisma.computer.findMany({
          where: {
            AND: [
              { controlLeaseId: { not: null } },
              {
                OR: [
                  { controlLeaseExpiresAt: null },
                  {
                    controlLeaseExpiresAt: {
                      lte: controlScanDeadline,
                    },
                  },
                ],
              },
              ...(controlCursorFilter ? [controlCursorFilter] : []),
            ],
          },
          orderBy: [{ controlLeaseExpiresAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: {
            id: true,
            controlBotId: true,
            controlLeaseId: true,
            controlLeaseExpiresAt: true,
          },
        }),
        deps.prisma.messagingOutbound.findFirst({
          where: {
            status: "pending",
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          },
          select: { id: true },
        }),
        deps.prisma.run.findMany({
          where: { trigger: "messaging", status: "completed", messagingMirroredAt: null },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: { id: true },
        }),
      ]);

      const events = deps.events;
      if (events) {
        const outcomes = await deps.prisma.run.findMany({
          where: {
            trigger: "bot_message",
            status: { in: ["completed", "failed", "cancelled"] },
            botOutcomeReturnedAt: null,
          },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: {
            id: true,
            spaceId: true,
            threadId: true,
            botId: true,
            userId: true,
            sourceMessageId: true,
            status: true,
            error: true,
            sourceMessage: { select: { blocks: true } },
            bot: { select: { name: true } },
          },
        });
        await Promise.all(
          outcomes.map(async (run) => {
            const cancellationSource = botMessageContext(
              Array.isArray(run.sourceMessage?.blocks)
                ? (run.sourceMessage.blocks as MessageBlock[])
                : [],
            );
            if (run.status === "cancelled" && !cancellationSource?.fromRunId) {
              // Cancellations created before the receipt lineage protocol must
              // remain silent; mark them handled so a future reconciliation does
              // not replay historical work.
              await deps.prisma.run.updateMany({
                where: { id: run.id, status: "cancelled", botOutcomeReturnedAt: null },
                data: { botOutcomeReturnedAt: new Date() },
              });
              return;
            }
            const transcript =
              run.status === "failed" || run.status === "cancelled"
                ? { text: "", progressOnly: false }
                : await botRunOutcomeText(deps.prisma, run.id);
            const text =
              run.status === "failed"
                ? `Could not complete the delegated request: ${run.error ?? "unknown error"}`
                : run.status === "cancelled"
                  ? "The delegated request was cancelled before it could return a result."
                  : transcript.text ||
                    "The delegated bot completed its turn without a written summary.";
            // Same stable delivery key as the executor path (auto-outcome:<runId>), so a
            // concurrent or earlier return is replayed instead of double-posted. Progress-only
            // transcripts (all mid-turn user-progress messages) return as status.
            const intent =
              run.status === "failed" ||
              run.status === "cancelled" ||
              !transcript.text.trim() ||
              transcript.progressOnly
                ? "status"
                : ("result" as const);
            const returned = await returnBotMessageOutcome(
              { prisma: deps.prisma, jobs: deps.jobs, events },
              run,
              { id: run.botId, name: run.bot.name },
              text,
              intent,
            ).catch((error) => {
              getLogger().error("bot message outcome reconciliation", error);
              return false;
            });
            if (!returned) {
              await deps.prisma.run.updateMany({
                where: { id: run.id, botOutcomeReturnedAt: null },
                data: { updatedAt: new Date() },
              });
            }
          }),
        );
      }

      await Promise.all([
        ...runs.map((run) => deps.jobs.enqueue(runContinueJob(run.id))),
        ...routines.flatMap((routine) =>
          routine.nextRunAt
            ? [deps.jobs.enqueue(routineWakeupJob(routine.id, routine.nextRunAt))]
            : [],
        ),
        ...controls.flatMap((computer) =>
          computer.controlLeaseId
            ? [
                scheduleComputerControlExpiry(
                  deps.jobs,
                  computer.id,
                  computer.controlLeaseId,
                  computer.controlLeaseExpiresAt ?? now,
                ),
              ]
            : [],
        ),
        ...(dueOutbound ? [deps.jobs.enqueue(messagingDeliverJob())] : []),
        ...unmirroredMessagingRuns.map((run) => deps.jobs.enqueue(messagingDeliverJob(run.id))),
      ]);

      const lastRun = runs.at(-1);
      runCursor =
        runs.length === batchSize && lastRun
          ? { at: lastRun.updatedAt, id: lastRun.id }
          : undefined;
      const lastRoutine = routines.at(-1);
      routineCursor =
        routines.length === batchSize && lastRoutine?.nextRunAt
          ? { at: lastRoutine.nextRunAt, id: lastRoutine.id }
          : undefined;
      const lastControl = controls.at(-1);
      controlCursor =
        controls.length === batchSize && lastControl
          ? { at: lastControl.controlLeaseExpiresAt, id: lastControl.id }
          : undefined;
      if (!controlCursor) controlScanDeadline = undefined;
    })().finally(() => {
      reconciling = undefined;
    });
    return reconciling;
  };
  const reconcileSafely = () => {
    void reconcileOnce().catch((error) =>
      getLogger().error("background job reconciliation", error),
    );
  };

  return {
    reconcileOnce,
    start() {
      if (timer) return;
      reconcileSafely();
      timer = setInterval(reconcileSafely, intervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await reconciling?.catch(() => undefined);
      await deps.leadership?.release();
    },
  };
}

/**
 * Retry the second transaction of terminal work cleanup. A native process in
 * `stop_unconfirmed` remains a hard stop until its provider can prove it ended.
 */
async function reconcileTerminalWork(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    sandbox?: SandboxProvider;
  },
  batchSize: number,
) {
  // Lightweight reconcilers used by callers that do not compose the delegation schema keep
  // their former behavior; every real PrismaClient exposes this delegate.
  if (!("scopedTask" in deps.prisma)) return;
  const terminal = await deps.prisma.scopedTask.findMany({
    where: {
      status: { in: [...WORK_TERMINAL_STATUSES] },
      executorBot: { is: { archivedAt: null } },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: {
      id: true,
      coordinatorBotId: true,
      executorBotId: true,
      specialistThreadId: true,
      missionComputerId: true,
      nativeSession: {
        select: { processState: true, processRef: true, executionTarget: true },
      },
    },
  });

  for (const work of terminal) {
    const session = work.nativeSession;
    if (session?.processState === "stop_unconfirmed") {
      if (
        !session.processRef ||
        !session.executionTarget ||
        !deps.sandbox?.reconfirmNativeProcess
      ) {
        continue;
      }
      const computer = await deps.prisma.computer.findUnique({
        where: { id: session.executionTarget },
        select: { homeKey: true, kind: true, providerRef: true, spaceId: true, userId: true },
      });
      if (!computer?.providerRef) continue;
      let confirmation: "stopped" | "stop_unconfirmed";
      try {
        confirmation = await deps.sandbox.reconfirmNativeProcess(
          toComputerRef(computer),
          session.processRef,
          {
            operationId: "job.reconcile-terminal-work",
            traceId: `job.reconcile-terminal-work:${work.id}`,
            spaceId: computer.spaceId,
            userId: computer.userId,
            botId: work.executorBotId,
            signal: new AbortController().signal,
          },
        );
      } catch (error) {
        getLogger().error("terminal work native stop reconfirmation", error);
        continue;
      }
      if (confirmation !== "stopped") continue;
      const confirmed = await deps.prisma.nativeSession.updateMany({
        where: {
          botId: work.executorBotId,
          threadId: work.specialistThreadId,
          processState: "stop_unconfirmed",
          processRef: session.processRef,
        },
        data: { processState: "stopped" },
      });
      if (confirmed.count !== 1) continue;
    }
    await cleanupTerminalWork({ prisma: deps.prisma, jobs: deps.jobs }, work);
  }
}

/**
 * Deliver the return of a specialist Run that ended while its worker died before
 * delivering it, and of one cancelled on its own while its work stays open. A work already
 * cancelled gets none: what its Runs produced afterwards is a late trace, never a return;
 * a closed work still takes the return as a passive receipt. Delivery is idempotent per
 * Run, so a return the worker did deliver, or one a second reconciliation sees again, is
 * never posted twice.
 */
async function reconcileSpecialistReturns(
  deps: { prisma: PrismaClient; jobs: JobPublisher; events?: ThreadEvents },
  batchSize: number,
) {
  const { events } = deps;
  if (!events) return;
  const undelivered = await deps.prisma.run.findMany({
    where: {
      scopedTaskId: { not: null },
      terminalReturnDelivery: null,
      OR: [
        {
          status: { in: ["completed", "failed"] },
          scopedTask: { is: { status: { not: "cancelled" } } },
        },
        {
          status: "cancelled",
          scopedTask: { is: { status: { notIn: [...WORK_TERMINAL_STATUSES] } } },
        },
      ],
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true, status: true, scopedTaskId: true },
  });
  for (const run of undelivered) {
    try {
      await deliverSpecialistRunEnd(
        { prisma: deps.prisma, jobs: deps.jobs, events },
        {
          workId: run.scopedTaskId!,
          runId: run.id,
          status: run.status as "completed" | "failed" | "cancelled",
          text: await finalRunText(deps.prisma, run.id),
        },
      );
    } catch (error) {
      getLogger().error("specialist return reconciliation", error);
      // Rotate a Run that cannot be delivered so it does not starve the batch.
      await deps.prisma.run.updateMany({
        where: { id: run.id, terminalReturnDelivery: null },
        data: { updatedAt: new Date() },
      });
    }
  }
}

/** The Run's final reply as the executor would have delivered it: progress messages are not part of it. */
async function finalRunText(prisma: PrismaClient, runId: string): Promise<string> {
  const outcome = await botRunOutcomeText(prisma, runId);
  return outcome.progressOnly ? "" : outcome.text;
}

/** Prefer the full bot transcript for a run so interim progress is not mistaken for the sole result. */
async function botRunOutcomeText(
  prisma: {
    message: {
      findMany: (args: {
        where: { runId: string; role: "bot" };
        orderBy: { seq: "asc" };
        select: { blocks: true; clientNonce: true };
      }) => Promise<Array<{ blocks: unknown; clientNonce: string | null }>>;
    };
  },
  runId: string,
): Promise<{ text: string; progressOnly: boolean }> {
  const messages = await prisma.message.findMany({
    where: { runId, role: "bot" },
    orderBy: { seq: "asc" },
    select: { blocks: true, clientNonce: true },
  });
  const progressParts: string[] = [];
  const finalParts: string[] = [];
  for (const message of messages) {
    const text = messageText(message.blocks);
    if (!text) continue;
    if (isUserProgressClientNonce(message.clientNonce)) progressParts.push(text);
    else finalParts.push(text);
  }
  // Prefer the latest non-progress reply when present so earlier untagged mid-run
  // publishes (for example pre-takeover narration) do not contaminate the result.
  // Progress-only turns still join progress beats as status.
  if (finalParts.length > 0) {
    return { text: finalParts[finalParts.length - 1]!, progressOnly: false };
  }
  return { text: progressParts.join("\n\n"), progressOnly: progressParts.length > 0 };
}

function messageText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return (blocks as MessageBlock[])
    .filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}
