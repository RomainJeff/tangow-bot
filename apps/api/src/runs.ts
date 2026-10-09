import {
  type Actor,
  MessageBlock,
  type Routine,
  type RunActivityRow,
  type RunStatus,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, botMessageContext, classifyRunFailure } from "@rakazo/core";
import { Prisma, type PrismaClient } from "@rakazo/db";

const RECENT_LIMIT = 20;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

function promptSnippet(prompt: string, max = 120): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function activityPromptSnippet(
  input: { trigger: string; prompt: string; sourceBlocks?: unknown },
  max = 120,
): string {
  if (input.trigger !== "bot_message") return promptSnippet(input.prompt, max);
  const parsed = MessageBlock.array().safeParse(input.sourceBlocks);
  const message = parsed.success ? botMessageContext(parsed.data) : undefined;
  if (!message) return "Message from another agent";
  const name = message.fromBotName.trim() || "Another agent";
  const label =
    message.intent === "result" || message.intent === "status" || message.intent === "fyi"
      ? `Update from ${name}`
      : `${name} asked`;
  return promptSnippet(message.text.trim() ? `${label}: ${message.text}` : label, max);
}

export function activityNotificationsEnabled(
  groupId: string | null,
  notifyOnFinish: boolean,
): boolean {
  return groupId !== null || notifyOnFinish;
}

export async function listSpaceRuns(
  prisma: PrismaClient,
  actor: Actor,
  filter: "active" | "recent",
): Promise<RunActivityRow[]> {
  const rows = await prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
      ...(filter === "active"
        ? { status: { in: [...ACTIVE_RUN_STATUSES] } }
        : { status: { in: [...TERMINAL_STATUSES] } }),
    },
    include: {
      bot: { select: { name: true, archivedAt: true, notifyOnFinish: true } },
      task: { select: { prompt: true } },
      sourceMessage: { select: { blocks: true } },
      thread: {
        select: {
          groupId: true,
          group: { select: { name: true } },
        },
      },
    },
    orderBy:
      filter === "active"
        ? [{ updatedAt: "desc" }, { id: "desc" }]
        : [{ completedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    take: filter === "recent" ? RECENT_LIMIT : undefined,
  });

  return rows.map((row) => ({
    runId: row.id,
    botId: row.botId,
    botName: row.bot.name,
    groupId: row.thread.groupId,
    groupName: row.thread.group?.name ?? null,
    threadId: row.threadId,
    status: row.status as RunActivityRow["status"],
    trigger: row.trigger as RunActivityRow["trigger"],
    notificationsEnabled: activityNotificationsEnabled(row.thread.groupId, row.bot.notifyOnFinish),
    promptSnippet: activityPromptSnippet({
      trigger: row.trigger,
      prompt: row.task.prompt,
      sourceBlocks: row.sourceMessage?.blocks,
    }),
    updatedAt: (filter === "recent" && row.completedAt
      ? row.completedAt
      : row.updatedAt
    ).toISOString(),
  }));
}

export type RoutineLastRun = Pick<Routine, "lastRunStatus" | "lastRunFailureKind">;

export const NO_LAST_RUN: RoutineLastRun = { lastRunStatus: null, lastRunFailureKind: null };

const ROUTINE_RUN_STATUS = {
  completed: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/** How each routine's most recent finished run ended, in one query. Routines never run are absent. */
export async function lastRunsByRoutine(
  prisma: PrismaClient,
  spaceId: string,
  routineIds: readonly string[],
): Promise<Map<string, RoutineLastRun>> {
  const lastRuns = new Map<string, RoutineLastRun>();
  if (routineIds.length === 0) return lastRuns;
  // DISTINCT ON keeps one row per routine in Postgres; Prisma's `distinct` may dedupe in memory.
  const rows = await prisma.$queryRaw<
    Array<{ routineId: string; status: (typeof TERMINAL_STATUSES)[number]; error: string | null }>
  >(Prisma.sql`
    SELECT DISTINCT ON (r."routineId") r."routineId", r.status, r.error
    FROM runs r
    WHERE r."spaceId" = ${spaceId}
      AND r."routineId" IN (${Prisma.join(routineIds)})
      AND r.status IN (${Prisma.join(TERMINAL_STATUSES)})
    ORDER BY r."routineId", r."completedAt" DESC NULLS LAST, r.id DESC
  `);
  for (const row of rows) {
    lastRuns.set(row.routineId, {
      lastRunStatus: ROUTINE_RUN_STATUS[row.status],
      lastRunFailureKind: classifyRunFailure(row.status as RunStatus, row.error),
    });
  }
  return lastRuns;
}
