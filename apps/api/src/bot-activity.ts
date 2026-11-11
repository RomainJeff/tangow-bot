import type { SessionLog } from "@tangow/adapter-kit";
import type {
  Actor,
  BotActivityInput,
  BotActivityItem,
  BotActivityOutput,
  RunRecap,
  RunsCursor,
  SessionEntries,
} from "@tangow/contracts";
import { RUNS_PAGE_DEFAULT } from "@tangow/contracts";
import { ACTIVE_RUN_STATUSES, projectThreadItems, routineRoles, runRecap } from "@tangow/core";
import type { Prisma, PrismaClient } from "@tangow/db";
import { IsolationError } from "@tangow/db";
import { mapRun, RUN_INCLUDE, TERMINAL_STATUSES, visibleRuns } from "./runs.js";

type Entry = { createdAt: Date; id: string; item: BotActivityItem };

function afterCursor(cursor: RunsCursor) {
  const createdAt = new Date(cursor.createdAt);
  return {
    OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }],
  };
}

function newestFirst(left: Entry, right: Entry): number {
  const byTime = right.createdAt.getTime() - left.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

function before(entry: { createdAt: Date; id: string }, cursor: RunsCursor | undefined): boolean {
  if (!cursor) return true;
  const at = new Date(cursor.createdAt).getTime();
  const time = entry.createdAt.getTime();
  return time < at || (time === at && entry.id < cursor.id);
}

/**
 * One bot's activity: the runs of its routines (whatever woke them), the routines it was given,
 * and its own creation, newest first by creation time. Active runs lead the first page and are
 * never paged; everything else is paged by `(createdAt, id)` across every kind of entry. The bot
 * is the caller's own (`repos.getBot`), and every read is narrowed to the caller's space and user
 * as well, so no id can reach past them. With `routineId`, only that routine's runs; with
 * `allRuns`, every run of the bot but helper runs, which show inside their parent.
 */
export async function listBotActivity(
  prisma: PrismaClient,
  actor: Actor,
  bot: { id: string; name: string; createdAt: Date },
  input: BotActivityInput,
): Promise<BotActivityOutput> {
  const limit = input.limit ?? RUNS_PAGE_DEFAULT;
  const owner = { spaceId: actor.spaceId, userId: actor.userId, botId: bot.id };
  const runScope: Prisma.RunWhereInput = input.routineId
    ? { ...owner, routineId: input.routineId }
    : input.allRuns
      ? { ...owner, parentRunId: null }
      : {
          ...owner,
          // Only routine wakes use the "routine" trigger, so a deleted routine's scheduled runs stay.
          // A webhook wake whose routine is gone cannot be told from a plain webhook message: it goes.
          OR: [{ routineId: { not: null } }, { trigger: "routine" }],
        };
  const keyset = input.cursor ? afterCursor(input.cursor) : {};
  const [active, finished, routines] = await Promise.all([
    input.cursor
      ? []
      : prisma.run.findMany({
          where: { ...runScope, status: { in: [...ACTIVE_RUN_STATUSES] } },
          include: RUN_INCLUDE,
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        }),
    prisma.run.findMany({
      where: { AND: [runScope, { status: { in: [...TERMINAL_STATUSES] } }, keyset] },
      include: RUN_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    }),
    input.routineId
      ? []
      : prisma.routine.findMany({
          where: { ...owner, ...keyset },
          select: { id: true, name: true, createdAt: true, threadId: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
        }),
  ]);

  const entries: Entry[] = [
    ...finished.map((row) => ({
      createdAt: row.createdAt,
      id: row.id,
      item: { kind: "routine_run" as const, run: mapRun(row) },
    })),
    ...routines.map((routine) => ({
      createdAt: routine.createdAt,
      id: routine.id,
      item: {
        kind: "routine_created" as const,
        routineId: routine.id,
        routineName: routine.name,
        createdAt: routine.createdAt.toISOString(),
        // Only a routine set up from chat (the bot's own, or a proposal it made) wakes in a thread;
        // without one, who made it is unknown (the editor, or a thread since deleted).
        byBotName: routine.threadId ? bot.name : null,
      },
    })),
  ];
  if (!input.routineId && before(bot, input.cursor)) {
    entries.push({
      createdAt: bot.createdAt,
      id: bot.id,
      item: {
        kind: "bot_created",
        botId: bot.id,
        botName: bot.name,
        createdAt: bot.createdAt.toISOString(),
      },
    });
  }
  entries.sort(newestFirst);
  const page = entries.slice(0, limit);
  const last = page.at(-1);
  return {
    items: [
      ...active.map((row) => ({ kind: "routine_run" as const, run: mapRun(row) })),
      ...page.map((entry) => entry.item),
    ],
    nextCursor:
      entries.length > limit && last
        ? { createdAt: last.createdAt.toISOString(), id: last.id }
        : null,
  };
}

type RunLog = Pick<SessionLog<unknown>, "readRun">;
type RunLogDeps = { prisma: PrismaClient; sessionLog: RunLog };

const RUN_ENTRIES_LIMIT = 1000;

/** A run's newest entries up to the cap, and whether older ones were left out. */
export async function readCappedRun(sessionLog: RunLog, runId: string): Promise<SessionEntries> {
  const entries = await sessionLog.readRun(runId, { limit: RUN_ENTRIES_LIMIT + 1 });
  return entries.length > RUN_ENTRIES_LIMIT
    ? { entries: entries.slice(1), truncated: true }
    : { entries };
}

async function ownRunId(prisma: PrismaClient, actor: Actor, runId: string): Promise<string> {
  const run = await prisma.run.findFirst({
    where: { id: runId, ...visibleRuns(actor) },
    select: { id: true },
  });
  if (!run) throw new IsolationError();
  return run.id;
}

export async function readRunEntries(
  deps: RunLogDeps,
  actor: Actor,
  runId: string,
): Promise<SessionEntries> {
  return readCappedRun(deps.sessionLog, await ownRunId(deps.prisma, actor, runId));
}

export async function readRunRecap(
  deps: RunLogDeps,
  actor: Actor,
  runId: string,
): Promise<RunRecap> {
  const items = projectThreadItems(
    await deps.sessionLog.readRun(await ownRunId(deps.prisma, actor, runId)),
  );
  const recap = runRecap(
    items.flatMap((item) =>
      item.kind === "message" && item.role === "bot" ? [{ id: item.id, blocks: item.blocks }] : [],
    ),
  );
  const routine = items.find((item) => item.kind === "routine");
  if (!routine) return recap;
  return {
    text: recap.text ?? (routine.finished?.result.trim() || null),
    messageId: routineRoles([routine]).hidden.has(routine.id) ? null : routine.id,
  };
}
