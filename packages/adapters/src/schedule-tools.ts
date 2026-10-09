import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineJobKey, routineWakeupJob } from "@rakazo/adapter-kit";
import type { RoutinePreview } from "@rakazo/core";
import {
  botMessageHopExhausted,
  cronFromPreset,
  hasMixedOneShotSchedule,
  isOneShotRoutineCron,
  isOneShotRoutineCrons,
  isValidTimezone,
  nextBotMessageHop,
  nextCronDate,
  nextCronDateAcrossStrict,
  ONCE_ROUTINE_CRON,
  routineCardSchedule,
  routineCardTextError,
  routineScheduleLabel,
  sameWallClockIn,
  shortestCronGapMs,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";

export { isOneShotRoutineCron, ONCE_ROUTINE_CRON };

export const SCHEDULE_TOOL_NAMES = new Set(["schedule_create", "schedule_list", "schedule_cancel"]);

export function filterBuiltinToolsForRun<T extends { name: string }>(
  tools: T[],
  runTrigger: string,
): T[] {
  return runTrigger === "routine" ? tools.filter((tool) => tool.name !== "schedule_create") : tools;
}

/** Keep cross-bot messaging thread-specific while exposing schedules in DMs and groups. */
export function filterBuiltinToolsForThread<T extends { name: string }>(
  tools: T[],
  groupId: string | null | undefined,
): T[] {
  return tools.filter(
    (tool) =>
      (groupId || tool.name !== "handoff_to_bot") &&
      // In a group the room is the shared surface: hand the stage to a member
      // rather than starting a private thread off to one side.
      (!groupId || tool.name !== "message_bot"),
  );
}

type ScheduleUnit = "minutes" | "hours" | "days" | "seconds";

export type ResolvedSchedule =
  | { ok: true; cron: string; nextRunAt: Date; oneShot: boolean }
  | { ok: false; error: string };

/**
 * A schedule_create call as the tool reads it: a model sends null for a field it means to leave
 * out, so a null field is dropped, and a routineId that is not a non-blank string is too.
 */
export function scheduleCreateArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) =>
        value !== null &&
        (key !== "routineId" || (typeof value === "string" && value.trim() !== "")),
    ),
  );
}

const ONE_SHOT_MAX_AHEAD_MS = 5 * 365 * 24 * 60 * 60 * 1000;

export function resolveScheduleTiming(
  input: {
    cron?: unknown;
    every?: unknown;
    unit?: unknown;
    runAt?: unknown;
    delayMinutes?: unknown;
    delaySeconds?: unknown;
  },
  timezone = "UTC",
): ResolvedSchedule {
  const hasRepeat =
    input.cron !== undefined || input.every !== undefined || input.unit !== undefined;
  const hasOneShot =
    input.runAt !== undefined ||
    input.delayMinutes !== undefined ||
    input.delaySeconds !== undefined;
  if (hasRepeat && hasOneShot) {
    return {
      ok: false,
      error: "Provide either a repeating schedule or a one-shot time, not both.",
    };
  }
  if (!hasRepeat && !hasOneShot) {
    return {
      ok: false,
      error:
        "Provide cron, every/unit for repeating schedules, or runAt/delayMinutes/delaySeconds for one-shot.",
    };
  }

  if (hasOneShot) {
    const oneShotFields = [input.runAt, input.delayMinutes, input.delaySeconds].filter(
      (value) => value !== undefined,
    );
    if (oneShotFields.length !== 1) {
      return {
        ok: false,
        error:
          "Provide exactly one of runAt, delayMinutes, or delaySeconds for a one-shot schedule.",
      };
    }
    let nextRunAt: Date;
    if (input.delaySeconds !== undefined) {
      const delaySeconds = Number(input.delaySeconds);
      if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
        return { ok: false, error: "delaySeconds must be a non-negative number." };
      }
      nextRunAt = new Date(Date.now() + delaySeconds * 1_000);
    } else if (input.delayMinutes !== undefined) {
      const delayMinutes = Number(input.delayMinutes);
      if (!Number.isFinite(delayMinutes) || delayMinutes < 0) {
        return { ok: false, error: "delayMinutes must be a non-negative number." };
      }
      nextRunAt = new Date(Date.now() + delayMinutes * 60_000);
    } else {
      const parsed = new Date(String(input.runAt ?? ""));
      if (!Number.isFinite(parsed.getTime())) {
        return { ok: false, error: "runAt must be a valid ISO datetime." };
      }
      nextRunAt = parsed;
    }
    if (nextRunAt.getTime() <= Date.now()) {
      return { ok: false, error: "One-shot schedules must run in the future." };
    }
    if (!(nextRunAt.getTime() <= Date.now() + ONE_SHOT_MAX_AHEAD_MS)) {
      return { ok: false, error: "One-shot schedules must run within 5 years." };
    }
    return { ok: true, cron: ONCE_ROUTINE_CRON, nextRunAt, oneShot: true };
  }

  if (input.cron !== undefined) {
    const cron = String(input.cron).trim();
    if (!cron) return { ok: false, error: "cron must be a non-empty 5-field cron expression." };
    if (isOneShotRoutineCron(cron)) {
      return {
        ok: false,
        error: "Use runAt, delayMinutes, or delaySeconds for one-shot schedules.",
      };
    }
    const intervalError = validateRepeatingCron(cron);
    if (intervalError) return { ok: false, error: intervalError };
    try {
      const nextRunAt = nextCronDate(cron, new Date(), timezone);
      return { ok: true, cron, nextRunAt, oneShot: false };
    } catch {
      return { ok: false, error: "cron must be a valid 5-field cron expression." };
    }
  }

  const every = Number(input.every);
  const unit = String(input.unit ?? "") as ScheduleUnit;
  if (!Number.isFinite(every) || every <= 0 || !Number.isInteger(every)) {
    return { ok: false, error: "every must be a positive whole number." };
  }
  if (unit === "seconds") {
    return { ok: false, error: "minimum interval is 1 minute" };
  }
  if (!["minutes", "hours", "days"].includes(unit)) {
    return { ok: false, error: 'unit must be "minutes", "hours", or "days".' };
  }
  if (unit === "minutes" && every < 1) {
    return { ok: false, error: "minimum interval is 1 minute" };
  }
  const cron = cronFromPreset({ freq: "Interval", n: every, unit });
  const intervalError = validateRepeatingCron(cron);
  if (intervalError) return { ok: false, error: intervalError };
  try {
    const nextRunAt = nextCronDate(cron, new Date(), timezone);
    return { ok: true, cron, nextRunAt, oneShot: false };
  } catch {
    return { ok: false, error: "every/unit produced an invalid cron expression." };
  }
}

function scheduleOf(args: Record<string, unknown>) {
  const { cron, every, unit, runAt, delayMinutes, delaySeconds } = args;
  return { cron, every, unit, runAt, delayMinutes, delaySeconds };
}

const PROPOSED_ROUTINE_MIN_GAP_MS = 60 * 60 * 1000;

const TIMEZONE_ERROR = "timezone must be an IANA time zone, such as Europe/Paris.";

/**
 * A routine the bot proposes, checked and fixed before its card: the zone must be a real one, a
 * delay becomes the time it points to now so a late tap cannot move it, the routine runs at most
 * once an hour, and the schedule line is written from what will be stored.
 */
export function prepareRoutineCard(
  args: Record<string, unknown>,
  now: Date,
): { args: Record<string, unknown>; routine: RoutinePreview } | { error: string } {
  const timezone = args.timezone ?? "UTC";
  if (typeof timezone !== "string" || !isValidTimezone(timezone)) return { error: TIMEZONE_ERROR };
  const name = String(args.name ?? "").trim();
  const prompt = String(args.prompt ?? "").trim();
  if (!name) return { error: "name is required." };
  if (!prompt) return { error: "prompt is required." };
  const textError = routineCardTextError(name, prompt);
  if (textError) return { error: textError };
  const asked = resolveScheduleTiming(scheduleOf(args), timezone);
  if (!asked.ok) return { error: asked.error };

  const delayMs =
    args.delayMinutes !== undefined
      ? Number(args.delayMinutes) * 60_000
      : args.delaySeconds !== undefined
        ? Number(args.delaySeconds) * 1_000
        : undefined;
  const { delayMinutes: _minutes, delaySeconds: _seconds, ...absolute } = args;
  const fixed =
    delayMs === undefined
      ? args
      : { ...absolute, runAt: new Date(now.getTime() + delayMs).toISOString() };
  const resolved = resolveScheduleTiming(scheduleOf(fixed), timezone);
  if (!resolved.ok) return { error: resolved.error };
  if (
    !resolved.oneShot &&
    shortestCronGapMs(resolved.cron, now, timezone) < PROPOSED_ROUTINE_MIN_GAP_MS
  ) {
    return { error: "A routine you propose must run at most once an hour." };
  }
  return {
    args: fixed,
    routine: {
      name,
      schedule: routineScheduleLabel({ crons: [resolved.cron], ...resolved }, timezone),
      prompt,
      notify: args.notify === true,
    },
  };
}

function validateRepeatingCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "cron must be a 5-field cron expression.";
  const minuteExpr = parts[0] ?? "*";
  const step = /^\*\/(\d+)$/.exec(minuteExpr);
  if (step) {
    const n = Number(step[1]);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
      return "minimum interval is 1 minute";
    }
  }
  return null;
}

export interface ScheduleToolDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
}

/** Persist and enqueue a bot routine that wakes in the originating thread. */
export async function createScheduleFromTool(
  deps: ScheduleToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    threadId: string;
    name: string;
    prompt: string;
    timezone?: string;
    /** "…and notify me every time" captured in natural language. Defaults to silent (the run
        stays a browsable card in this thread); the routine setup UI remains the point of truth. */
    notify?: boolean;
    /** The bot-to-bot chain hop of the creating run; a routine created mid-chain carries it on. */
    currentHop?: number;
    schedule: Record<string, unknown>;
  },
) {
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  if (!name) return { error: "name is required." };
  if (!prompt) return { error: "prompt is required." };
  const inheritedHop = input.currentHop ? nextBotMessageHop(input.currentHop) : null;
  if (inheritedHop !== null && botMessageHopExhausted(inheritedHop)) {
    return { error: "bot-to-bot chain limit reached; ask the user to set up this routine" };
  }

  const timezone = input.timezone ?? "UTC";
  if (!isValidTimezone(timezone)) return { error: TIMEZONE_ERROR };
  const resolved = resolveScheduleTiming(input.schedule, timezone);
  if (!resolved.ok) return { error: resolved.error };

  const row = await deps.prisma.routine.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      threadId: input.threadId,
      name,
      prompt,
      crons: [resolved.cron],
      timezone,
      notify: input.notify === true,
      active: true,
      nextRunAt: resolved.nextRunAt,
      inheritedHop,
    },
  });

  try {
    await deps.jobs.enqueue(routineWakeupJob(row.id, resolved.nextRunAt));
  } catch {
    try {
      await deps.prisma.routine.delete({ where: { id: row.id } });
    } catch {
      // Do not soft-return while the row may still be active.
      await deps.prisma.routine.update({
        where: { id: row.id },
        data: { active: false, nextRunAt: null },
      });
    }
    return { error: "Could not schedule the reminder. Try again." };
  }

  try {
    await deps.events.append({
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "routine.created",
      payload: { name: row.name },
    });
  } catch {
    // Match routines.create: the reminder is live even if the thread signal fails.
  }

  return routineResult(row);
}

type StoredRoutine = {
  id: string;
  name: string;
  prompt: string;
  notify: boolean;
  timezone: string;
  crons: string[];
  active: boolean;
  webhookEnabled: boolean;
  githubEnabled: boolean;
  messageProvider: string | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
};

type RoutineRow = Awaited<ReturnType<PrismaClient["routine"]["update"]>>;

/** What a routine update may change; a field left out stays as stored. */
export type RoutineChange = {
  name?: string;
  prompt?: string;
  crons?: string[];
  timezone?: string;
  active?: boolean;
  notify?: boolean;
  webhookEnabled?: boolean;
  githubEnabled?: boolean;
  messageProvider?: string | null;
  requireToolApproval?: boolean;
  inheritedHop?: number;
  /** When an active one-shot runs: arms it, moves it, or runs one that already ran again. */
  runAt?: string | Date;
};

/**
 * The one set of rules for changing a routine, whoever asks (the routine editor or a bot): it
 * validates the change, stores it with the next run it implies, keeps the wake-up job in step and
 * tells the thread. A paused routine stays paused unless the change resumes it. Only a bot may
 * `retime` a one-shot: convert a routine to one, move an armed one, or run one that already ran.
 */
export async function updateRoutine(
  deps: ScheduleToolDeps,
  existing: StoredRoutine,
  change: RoutineChange,
  signal: { spaceId: string; botId: string; threadId: string | null },
  retime = false,
): Promise<{ row: RoutineRow } | { error: string }> {
  const active = change.active ?? existing.active;
  const crons = change.crons ?? existing.crons;
  if (change.timezone !== undefined && !isValidTimezone(change.timezone)) {
    return { error: TIMEZONE_ERROR };
  }
  const timezone = change.timezone ?? existing.timezone;
  const webhookEnabled = change.webhookEnabled ?? existing.webhookEnabled;
  const githubEnabled = change.githubEnabled ?? existing.githubEnabled;
  const messageProvider =
    change.messageProvider === undefined ? existing.messageProvider : change.messageProvider;
  if (crons.length === 0 && !webhookEnabled && !githubEnabled && !messageProvider) {
    return { error: "Add a schedule, webhook, GitHub, or message trigger" };
  }
  if (hasMixedOneShotSchedule(crons)) {
    return { error: "A one-time schedule can't be combined with other schedules." };
  }
  const oneShot = isOneShotRoutineCrons(crons);
  const wasOneShot = isOneShotRoutineCrons(existing.crons);
  if (change.runAt !== undefined && !(active && oneShot)) {
    return { error: "A run time is only for one-shots that have not run yet." };
  }
  const scheduleChanged =
    (!existing.active && active) ||
    JSON.stringify(crons) !== JSON.stringify(existing.crons) ||
    timezone !== existing.timezone;
  // Left undefined, the stored next run stays: a wake-up may have moved it since `existing` was read.
  let nextRunAt: Date | null | undefined = null;
  if (active && oneShot) {
    if (change.runAt !== undefined) {
      if (!retime && !wasOneShot) return { error: "One-shot schedules must be created from chat." };
      if (!retime && !existing.nextRunAt && existing.lastRunAt) {
        return { error: "This one-shot already ran." };
      }
      if (!retime && existing.nextRunAt) {
        return { error: "A run time is only for one-shots that have not run yet." };
      }
      const at = new Date(change.runAt);
      if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) {
        return { error: "Run time must be in the future." };
      }
      nextRunAt = at;
    } else if (!wasOneShot) {
      return { error: "One-shot schedules must be created from chat." };
    } else if (existing.nextRunAt && timezone === existing.timezone) {
      nextRunAt = undefined;
    } else if (existing.nextRunAt) {
      nextRunAt = sameWallClockIn(existing.nextRunAt, existing.timezone, timezone);
      if (nextRunAt.getTime() <= Date.now()) return { error: "Run time must be in the future." };
    } else {
      return {
        error: existing.lastRunAt
          ? "This one-shot already ran."
          : "Add a run time for this one-shot.",
      };
    }
  } else if (active && crons.length > 0) {
    if (scheduleChanged || !existing.nextRunAt) {
      try {
        nextRunAt = nextCronDateAcrossStrict(crons, new Date(), timezone);
      } catch {
        nextRunAt = null;
      }
      if (!nextRunAt) return { error: "Enter a valid cron expression." };
    } else {
      nextRunAt = undefined;
    }
  }

  const row = await deps.prisma.routine.update({
    where: { id: existing.id },
    data: {
      name: change.name,
      prompt: change.prompt,
      crons: change.crons,
      timezone: change.timezone,
      active: change.active,
      notify: change.notify,
      webhookEnabled: change.webhookEnabled,
      githubEnabled: change.githubEnabled,
      messageProvider: change.messageProvider,
      requireToolApproval: change.requireToolApproval,
      inheritedHop: change.inheritedHop,
      nextRunAt,
    },
  });
  if (row.active && row.nextRunAt) {
    await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
  } else {
    await deps.jobs.cancel(routineJobKey(row.id));
  }
  if (signal.threadId) {
    try {
      await deps.events.append({
        spaceId: signal.spaceId,
        threadId: signal.threadId,
        botId: signal.botId,
        type: "routine.updated",
        payload: { routineId: row.id, active: row.active },
      });
    } catch {
      // The change is saved even if the thread signal fails.
    }
  }
  return { row };
}

/**
 * Change a routine of this bot the user asked about: in a group, only one of that group; outside
 * one, only one that belongs to no group. What the bot leaves out stays as stored.
 */
export async function updateScheduleFromTool(
  deps: ScheduleToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    threadId: string;
    inGroup: boolean;
    /** The user started this run in the app, so a new instruction is theirs. */
    startedByUser: boolean;
    /** The bot-to-bot chain hop of the run; a routine changed mid-chain carries it on. */
    currentHop?: number;
    routineId: string;
    name?: string;
    prompt?: string;
    timezone?: string;
    notify?: boolean;
    schedule: Record<string, unknown>;
  },
) {
  const name = input.name?.trim();
  const prompt = input.prompt?.trim();
  if (name === "") return { error: "name cannot be empty." };
  if (prompt === "") return { error: "prompt cannot be empty." };
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
    return { error: TIMEZONE_ERROR };
  }
  const inheritedHop = input.currentHop ? nextBotMessageHop(input.currentHop) : undefined;
  if (inheritedHop !== undefined && botMessageHopExhausted(inheritedHop)) {
    return { error: "bot-to-bot chain limit reached; ask the user to change this routine" };
  }
  const existing = await deps.prisma.routine.findFirst({
    where: {
      id: input.routineId,
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      ...(input.inGroup ? { threadId: input.threadId } : {}),
    },
    include: { thread: { select: { groupId: true } } },
  });
  if (!existing) return { error: "Routine not found." };
  if (!input.inGroup && existing.thread?.groupId) {
    return { error: "This routine belongs to a group: change it from that group." };
  }

  const timezone = input.timezone ?? existing.timezone;
  const reschedule = Object.values(input.schedule).some((value) => value !== undefined);
  const ranOnce =
    isOneShotRoutineCrons(existing.crons) && !existing.nextRunAt && existing.lastRunAt != null;
  let timing: { crons: string[]; runAt?: Date } | undefined;
  if (reschedule) {
    if (existing.crons.length > 1) {
      return {
        error: "This routine runs on several schedules: ask the user to change them in the app.",
      };
    }
    const resolved = resolveScheduleTiming(input.schedule, timezone);
    if (!resolved.ok) return { error: resolved.error };
    if (resolved.oneShot && !existing.active && !ranOnce) {
      return { error: "This routine is paused: ask the user to resume it in the app first." };
    }
    timing = {
      crons: [resolved.cron],
      ...(resolved.oneShot ? { runAt: resolved.nextRunAt } : {}),
    };
  } else if (ranOnce) {
    return { error: "This reminder already ran: give it a new time to run it again." };
  }

  const promptChanged = prompt !== undefined && prompt !== existing.prompt;
  const updated = await updateRoutine(
    deps,
    existing,
    {
      name,
      prompt,
      timezone: input.timezone,
      notify: input.notify,
      ...timing,
      ...(ranOnce ? { active: true } : {}),
      // Opting out of approvals trusted the owner's own instruction, not one from this run.
      ...(promptChanged && !input.startedByUser ? { requireToolApproval: true } : {}),
      ...(inheritedHop !== undefined ? { inheritedHop } : {}),
    },
    { spaceId: input.spaceId, botId: input.botId, threadId: input.threadId },
    true,
  );
  if ("error" in updated) return updated;
  return routineResult(updated.row);
}

/** A routine as stored, for the model and for the card confirming what was set up. */
function routineResult(row: StoredRoutine) {
  return {
    ok: true as const,
    routineId: row.id,
    name: row.name,
    prompt: row.prompt,
    schedule: routineCardSchedule(row),
    notify: row.notify,
    cron: row.crons[0],
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    oneShot: isOneShotRoutineCrons(row.crons),
    ...(row.active
      ? {}
      : {
          paused: true as const,
          note: "This routine is paused: it will not run until the user resumes it in the app. Tell them.",
        }),
  };
}

/** List bot routines, optionally restricted to the current group thread. */
export async function listSchedulesFromTool(
  deps: Pick<ScheduleToolDeps, "prisma">,
  input: { spaceId: string; botId: string; userId: string; threadId?: string },
) {
  const rows = await deps.prisma.routine.findMany({
    where: {
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  return {
    routines: rows.map((row) => ({
      routineId: row.id,
      name: row.name,
      prompt: row.prompt,
      crons: row.crons,
      active: row.active,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      oneShot: isOneShotRoutineCrons(row.crons),
    })),
  };
}

/** Cancel a bot routine, optionally restricted to the current group thread. */
export async function cancelScheduleFromTool(
  deps: ScheduleToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    threadId?: string;
    routineId?: string;
    name?: string;
  },
) {
  const routineId = input.routineId?.trim();
  const name = input.name?.trim();
  if (!routineId && !name) {
    return { error: "Provide routineId or the exact schedule name to cancel." };
  }

  const existing = await deps.prisma.routine.findFirst({
    where: {
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(routineId ? { id: routineId } : { name: name! }),
    },
  });
  if (!existing) return { error: "Schedule not found." };

  await deps.prisma.routine.delete({ where: { id: existing.id } });
  await deps.jobs.cancel(routineJobKey(existing.id));
  return { ok: true as const, routineId: existing.id, name: existing.name };
}
