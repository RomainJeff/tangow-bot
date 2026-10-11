import type { Routine, RunFailureKind } from "@rakazo/contracts";
import {
  type CronPreset,
  type CronUnit,
  cronSchedule,
  cronSchedulePreset,
  cronScheduleTime,
  routineCadence,
} from "@rakazo/core";
import { dateLocaleForUi, getActiveUiLocale, t } from "./i18n";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "in 14 hr", "yesterday": a moment from now, in the reader's language. Spelled
 * through the catalog because Hermes has no `Intl.RelativeTimeFormat`.
 */
function relativeTime(iso: string, now: number): string {
  const diff = new Date(iso).getTime() - now;
  const future = diff >= 0;
  const size = Math.abs(diff);
  if (size < HOUR) {
    const count = Math.round(size / MINUTE);
    if (count === 0) return t("now");
    return future ? t("in {count} min", { count }) : t("{count} min ago", { count });
  }
  if (size < DAY) {
    const count = Math.round(size / HOUR);
    return future ? t("in {count} hr", { count }) : t("{count} hr ago", { count });
  }
  const count = Math.round(size / DAY);
  if (count === 1) return future ? t("tomorrow") : t("yesterday");
  return future ? t("in {count} days", { count }) : t("{count} days ago", { count });
}

/** Why a run failed, in one phrase; `null` when nothing more than "Failed" is known. */
function failureReason(kind: RunFailureKind | null): string | null {
  if (kind === "missing_model") return t("No model connected");
  if (kind === "computer") return t("Computer unavailable");
  if (kind === "provider") return t("Model error");
  return null;
}

function unitLabel(n: number, unit: CronUnit): string {
  if (getActiveUiLocale() === "ru") return russianUnit(n, unit);
  if (unit === "minutes") return n === 1 ? t("minute") : t("minutes");
  if (unit === "hours") return n === 1 ? t("hour") : t("hours");
  return n === 1 ? t("day") : t("days");
}

const RUSSIAN_UNITS: Record<CronUnit, readonly [string, string, string]> = {
  minutes: ["минуту", "минуты", "минут"],
  hours: ["час", "часа", "часов"],
  days: ["день", "дня", "дней"],
};

/** Russian needs the case an amount governs, which a single catalog string cannot carry. */
function russianUnit(n: number, unit: CronUnit): string {
  const [one, few, many] = RUSSIAN_UNITS[unit];
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function describePreset(preset: CronPreset): string {
  switch (preset.freq) {
    case "Interval":
      return preset.n === 1
        ? t("Every {unit}", { unit: unitLabel(1, preset.unit) })
        : t("Every {count} {unit}", { count: preset.n, unit: unitLabel(preset.n, preset.unit) });
    case "Every hour":
      return t("Every hour");
    case "Advanced":
      return t("Cron {expression}", { expression: preset.cron || "*/3 * * * *" });
    case "Weekdays":
      return t("Weekdays at {time}", { time: preset.time });
    case "Every week":
      return t("Every Monday at {time}", { time: preset.time });
    case "Every month":
      return t("Monthly on the 1st at {time}", { time: preset.time });
    default:
      return t("Every day at {time}", { time: preset.time });
  }
}

/** One schedule as a short phrase in the reader's language ("Weekdays at 9:00 AM"). */
export function describeSchedule(cron: string): string {
  const schedule = cronSchedule(cron);
  if (schedule.kind === "once") return t("One-time");
  const preset = cronSchedulePreset(schedule);
  if (preset) return describePreset(preset);
  const time =
    schedule.kind === "weekly" || schedule.kind === "monthly" || schedule.kind === "yearly"
      ? cronScheduleTime(schedule.times)
      : null;
  if (time && schedule.kind === "weekly" && schedule.weekdays.length === 1) {
    return t("Weekly on {weekday} at {time}", {
      // 2026-01-04 is a Sunday, weekday 0.
      weekday: new Intl.DateTimeFormat(dateLocaleForUi(), { weekday: "long" }).format(
        new Date(2026, 0, 4 + schedule.weekdays[0]!, 12),
      ),
      time,
    });
  }
  if (time && schedule.kind === "monthly") {
    return t("Monthly on day {day} at {time}", { day: schedule.day, time });
  }
  if (time && schedule.kind === "yearly") {
    return t("Yearly on {date} at {time}", {
      // A leap year, so a 29 February schedule keeps its date.
      date: new Intl.DateTimeFormat(dateLocaleForUi(), { month: "long", day: "numeric" }).format(
        new Date(2024, schedule.month - 1, schedule.day, 12),
      ),
      time,
    });
  }
  return t("Cron {expression}", { expression: cron.trim() });
}

function messageLabel(provider: string | null): string {
  if (provider === "slack") return t("Slack message");
  if (provider === "teams") return t("Teams message");
  return t("Message event");
}

function inboundLabel(source: "webhook" | "github" | "message", provider: string | null) {
  if (source === "webhook") return t("When a webhook fires");
  if (source === "github") return t("Git event");
  return messageLabel(provider);
}

/** One line under a routine: when it runs and when next, how its last run failed, or that it is paused. */
export function cadenceLine(routine: Routine, now = Date.now()): string {
  const cadence = routineCadence(routine);
  const schedules = routine.crons.map(describeSchedule).join(", ");
  if (cadence.kind === "none") return t("No trigger");
  if (cadence.kind === "paused") {
    const what =
      cadence.trigger === "schedule"
        ? schedules
        : inboundLabel(cadence.trigger, routine.messageProvider);
    return t("{what} · paused", { what });
  }
  if (routine.lastRunStatus === "failed") {
    const failed = routine.lastRunAt
      ? t("Failed {when}", { when: relativeTime(routine.lastRunAt, now) })
      : t("Failed");
    const reason = failureReason(routine.lastRunFailureKind);
    return reason ? `${failed} · ${reason}` : failed;
  }
  if (cadence.kind === "inbound") {
    return cadence.sources
      .map((source) => inboundLabel(source, routine.messageProvider))
      .join(" · ");
  }
  if (!cadence.nextRunAt) return schedules;
  return t("{schedule} · next {when}", {
    schedule: schedules,
    when: relativeTime(cadence.nextRunAt, now),
  });
}

/** "3 routines · next in 14 hr": how many, and the soonest next run of the active ones. */
export function routinesSummary(routines: readonly Routine[], now = Date.now()): string {
  const count =
    routines.length === 1
      ? t("{count} routine", { count: 1 })
      : t("{count} routines", { count: routines.length });
  const soonest = routines
    .filter((routine) => routine.active && routine.nextRunAt)
    .map((routine) => routine.nextRunAt as string)
    .filter((iso) => new Date(iso).getTime() > now)
    .sort()[0];
  return soonest ? t("{count} · next {when}", { count, when: relativeTime(soonest, now) }) : count;
}
