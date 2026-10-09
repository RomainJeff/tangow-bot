import { Cron } from "croner";

const WEEKDAYS = "1-5";

export const ONCE_ROUTINE_CRON = "@once";

export function isOneShotRoutineCron(cron: string): boolean {
  return cron.trim() === ONCE_ROUTINE_CRON;
}

// A routine is one-shot only when it has exactly one schedule and that
// schedule is @once — a mix of @once plus recurring schedules doesn't make
// sense (the one-shot slot would never get a "next run" to compute).
export function isOneShotRoutineCrons(crons: string[]): boolean {
  return crons.length === 1 && isOneShotRoutineCron(crons[0] ?? "");
}

// True when @once is combined with any other schedule — never valid, since
// the one-shot slot has no "next run" to compute and would sit inert
// forever. Callers that persist crons must reject this rather than let
// isOneShotRoutineCrons quietly classify the array as recurring.
export function hasMixedOneShotSchedule(crons: string[]): boolean {
  return crons.length > 1 && crons.some(isOneShotRoutineCron);
}

export const CRON_FREQS = [
  "Every hour",
  "Every day",
  "Weekdays",
  "Every week",
  "Every month",
  "Interval",
  "Advanced",
] as const;

export type CronFreq = (typeof CRON_FREQS)[number];
export type CronUnit = "minutes" | "hours" | "days";

export type CronPreset = {
  freq: CronFreq;
  n: number;
  unit: CronUnit;
  time: string;
  cron: string;
};

export type CronPresetInput = {
  freq: CronFreq;
  n?: number;
  unit?: CronUnit;
  time?: string;
  cron?: string;
};

export function defaultCronPreset(): CronPreset {
  return { freq: "Every day", n: 3, unit: "minutes", time: "9:00 AM", cron: "" };
}

export function cronFromPreset(input: CronPresetInput): string {
  const advancedCron = input.cron?.trim();
  if (input.freq === "Advanced") {
    if (advancedCron && isOneShotRoutineCron(advancedCron)) return ONCE_ROUTINE_CRON;
    return advancedCron || "*/3 * * * *";
  }
  if (input.freq === "Every hour") return "0 * * * *";
  if (input.freq === "Interval") {
    const n = Number.isFinite(input.n) && (input.n ?? 0) > 0 ? (input.n as number) : 5;
    if (input.unit === "days") return `0 0 */${n} * *`;
    if (input.unit === "hours") return `0 */${n} * * *`;
    return `*/${n} * * * *`;
  }
  const { hour, minute } = parseClock(input.time ?? "9:00 AM");
  if (input.freq === "Weekdays") return `${minute} ${hour} * * ${WEEKDAYS}`;
  if (input.freq === "Every week") return `${minute} ${hour} * * 1`;
  if (input.freq === "Every month") return `${minute} ${hour} 1 * *`;
  return `${minute} ${hour} * * *`;
}

export function presetFromCron(cron: string): CronPreset {
  const base = defaultCronPreset();
  const trimmed = cron.trim();
  if (isOneShotRoutineCron(trimmed)) {
    return { ...base, freq: "Advanced", cron: ONCE_ROUTINE_CRON };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length < 5) {
    return { ...base, freq: "Advanced", cron: trimmed };
  }
  const minute = parts[0] ?? "*";
  const hour = parts[1] ?? "*";
  const day = parts[2] ?? "*";
  const month = parts[3] ?? "*";
  const dow = parts[4] ?? "*";
  if (month !== "*") {
    return { ...base, freq: "Advanced", cron: trimmed };
  }

  const minuteStep = stepValue(minute);
  const hourStep = stepValue(hour);
  const dayStep = stepValue(day);

  if (minute === "0" && hour === "*" && day === "*" && dow === "*") {
    return { ...base, freq: "Every hour" };
  }
  if (minuteStep && hour === "*" && day === "*" && dow === "*") {
    return { ...base, freq: "Interval", n: minuteStep, unit: "minutes" };
  }
  if (minute === "0" && hourStep && day === "*" && dow === "*") {
    return { ...base, freq: "Interval", n: hourStep, unit: "hours" };
  }
  if (minute === "0" && hour === "0" && dayStep && dow === "*") {
    return { ...base, freq: "Interval", n: dayStep, unit: "days" };
  }
  if (!isInt(minute) || !isInt(hour)) {
    return { ...base, freq: "Advanced", cron: trimmed };
  }

  const time = formatClock(Number(hour), Number(minute));
  if (day === "*" && dow === WEEKDAYS) {
    return { ...base, freq: "Weekdays", time };
  }
  if (day === "*" && dow === "1") {
    return { ...base, freq: "Every week", time };
  }
  if (day === "1" && dow === "*") {
    return { ...base, freq: "Every month", time };
  }
  if (day === "*" && dow === "*") {
    return { ...base, freq: "Every day", time };
  }
  return { ...base, freq: "Advanced", cron: trimmed };
}

export type CronTime = { hour: number; minute: number };

/**
 * A schedule as data, for each app and the server to word in its own language. It is the one
 * reading of a cron for words; anything it cannot say for sure stays a raw expression.
 */
export type CronSchedule =
  | { kind: "once" }
  /**
   * `exact` is false when the step does not divide its cycle: a 45-minute step runs at :00 and
   * :45, and a step over days restarts each month. The editor offers such steps, so the apps
   * still word them as it does; the server does not.
   */
  | { kind: "every"; n: number; unit: CronUnit; exact: boolean }
  | { kind: "daily"; times: CronTime[] }
  /** `weekdays` 0 is Sunday, listed Monday first. */
  | { kind: "weekly"; weekdays: number[]; times: CronTime[] }
  | { kind: "monthly"; day: number; times: CronTime[] }
  /** `month` 1 is January. */
  | { kind: "yearly"; month: number; day: number; times: CronTime[] }
  | { kind: "cron"; expression: string };

// February keeps its 29th: a leap-day schedule still runs.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function cronSchedule(cron: string): CronSchedule {
  const expression = cron.trim();
  if (isOneShotRoutineCron(expression)) return { kind: "once" };
  const raw = { kind: "cron", expression } as const;
  const parts = expression.split(/\s+/);
  if (parts.length !== 5) return raw;
  const [minute, hour, day, month, dow] = parts as [string, string, string, string, string];
  if (month === "*" && dow === "*") {
    const every = everyStep(minute, hour, day);
    if (every) return { kind: "every", ...every };
  }
  const times = clockTimes(minute, hour);
  if (!times) return raw;
  if (day === "*" && month === "*") {
    if (dow === "*") return { kind: "daily", times };
    const days = weekdays(dow);
    if (!days) return raw;
    return days.length === 7 ? { kind: "daily", times } : { kind: "weekly", weekdays: days, times };
  }
  if (dow !== "*" || !inRange(day, 1, 31)) return raw;
  if (month === "*") return { kind: "monthly", day: Number(day), times };
  if (inRange(month, 1, 12) && Number(day) <= DAYS_IN_MONTH[Number(month) - 1]!) {
    return { kind: "yearly", month: Number(month), day: Number(day), times };
  }
  return raw;
}

/** An "every N" step over minutes, hours or days, with the rest of the fields left free. */
function everyStep(
  minute: string,
  hour: string,
  day: string,
): { n: number; unit: CronUnit; exact: boolean } | null {
  const minuteStep = stepValue(minute);
  if (minuteStep && minuteStep < 60 && hour === "*" && day === "*") {
    return { n: minuteStep, unit: "minutes", exact: 60 % minuteStep === 0 };
  }
  if (minute !== "0") return null;
  if (hour === "*" && day === "*") return { n: 1, unit: "hours", exact: true };
  const hourStep = stepValue(hour);
  if (hourStep && hourStep < 24 && day === "*") {
    return { n: hourStep, unit: "hours", exact: 24 % hourStep === 0 };
  }
  const dayStep = stepValue(day);
  if (hour === "0" && dayStep && dayStep <= 31) {
    return { n: dayStep, unit: "days", exact: dayStep === 1 };
  }
  return null;
}

export function describeCronPreset(preset: CronPreset): { lead: string; detail: string } {
  if (preset.freq === "Interval") {
    return { lead: "Every", detail: `${preset.n} ${preset.unit}` };
  }
  if (preset.freq === "Every hour") {
    return { lead: "Every hour", detail: "" };
  }
  if (preset.freq === "Advanced") {
    return { lead: "Cron", detail: preset.cron || "*/3 * * * *" };
  }
  if (preset.freq === "Weekdays") {
    return { lead: "Weekdays", detail: `at ${preset.time}` };
  }
  if (preset.freq === "Every week") {
    return { lead: "Every Monday", detail: `at ${preset.time}` };
  }
  if (preset.freq === "Every month") {
    return { lead: "Monthly", detail: `on the 1st at ${preset.time}` };
  }
  return { lead: "Every day", detail: `at ${preset.time}` };
}

export function formatSchedule(preset: CronPreset): string {
  const { lead, detail } = describeCronPreset(preset);
  return [lead, detail].filter(Boolean).join(" ");
}

export function formatCron(cron: string): string {
  if (isOneShotRoutineCron(cron)) return "One-time";
  return formatSchedule(presetFromCron(cron));
}

export function resolveRoutineNextRunAt(
  cron: string,
  from: Date,
  timezone: string,
  existing: Date | null | undefined,
): Date | null {
  if (isOneShotRoutineCron(cron)) return existing ?? null;
  return nextCronDate(cron, from, timezone);
}

export function nextCronDate(cron: string, from: Date, timezone = "UTC"): Date {
  if (isOneShotRoutineCron(cron)) {
    throw new Error("nextCronDate does not apply to one-shot routines");
  }
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new RangeError("Cron expressions must contain five fields");
  }
  const schedule = new Cron(cron, {
    paused: true,
    timezone: validTimezoneOrUtc(timezone),
  });
  const next = schedule.nextRun(from);
  if (!next) throw new RangeError(`Cron expression has no future run: ${cron}`);
  return next;
}

// Nearest next run across every recurring schedule on a routine. Ignores
// @once slots (they don't recur) and any schedule that fails to parse. Only
// the wakeup path (packages/adapters/src/executor.ts) should use this —
// legacy or hand-edited records may carry a stale cron, and skipping it
// there is safer than crashing the wakeup job. Anything that persists a
// routine's crons must reject malformed input instead — see
// nextCronDateAcrossStrict.
export function nextCronDateAcross(crons: string[], from: Date, timezone = "UTC"): Date | null {
  let earliest: Date | null = null;
  for (const cron of crons) {
    if (isOneShotRoutineCron(cron)) continue;
    let next: Date;
    try {
      next = nextCronDate(cron, from, timezone);
    } catch {
      continue;
    }
    if (!earliest || next < earliest) earliest = next;
  }
  return earliest;
}

// Same as nextCronDateAcross, but throws on the first malformed recurring
// cron instead of silently skipping it. Use this before persisting a
// routine's crons — a partially-invalid array should be rejected outright,
// not saved with the bad entry quietly never firing.
export function nextCronDateAcrossStrict(
  crons: string[],
  from: Date,
  timezone = "UTC",
): Date | null {
  let earliest: Date | null = null;
  for (const cron of crons) {
    if (isOneShotRoutineCron(cron)) continue;
    const next = nextCronDate(cron, from, timezone);
    if (!earliest || next < earliest) earliest = next;
  }
  return earliest;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))?$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How far `timezone`'s wall clock is ahead of UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: number, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, Number(part.value)]),
  );
  const wall = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time names in `timezone`. A time the clocks skip in spring moves
 * forward by the gap; a time they repeat in autumn is the first of the two.
 */
function zonedInstant(wall: number, timezone: string): number {
  const before = zoneOffsetMs(wall - DAY_MS, timezone);
  const after = zoneOffsetMs(wall + DAY_MS, timezone);
  const first = wall - before;
  if (zoneOffsetMs(first, timezone) === before) return first;
  const second = wall - after;
  return zoneOffsetMs(second, timezone) === after ? second : first;
}

/**
 * A one-shot run time: an ISO datetime with an offset or Z is taken as given, one without is a
 * wall-clock time in `timezone`, which the caller has checked. Null when it names no real time.
 */
export function parseRunAt(value: string, timezone: string): Date | null {
  const match = ISO_DATETIME.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00", fraction = "", z, sign, offH, offM] =
    match;
  const wall = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, "0").slice(0, 3)),
  );
  if (
    Number.isNaN(wall) ||
    new Date(wall).toISOString().slice(0, 19) !==
      `${year}-${month}-${day}T${hour}:${minute}:${second}`
  ) {
    return null;
  }
  if (z) return new Date(wall);
  if (sign) {
    const offsetMs = (Number(offH) * 60 + Number(offM)) * 60_000 * (sign === "+" ? 1 : -1);
    return new Date(wall - offsetMs);
  }
  return new Date(zonedInstant(wall, timezone));
}

/** The shortest wait between two of the next runs, to tell how often a schedule fires. */
export function shortestCronGapMs(cron: string, from: Date, timezone = "UTC", runs = 48): number {
  const times = new Cron(cron, { paused: true, timezone: validTimezoneOrUtc(timezone) })
    .nextRuns(runs, from)
    .map((date) => date.getTime());
  let shortest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < times.length; index += 1) {
    shortest = Math.min(shortest, times[index]! - times[index - 1]!);
  }
  return shortest;
}

const DAY_NAMES = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

/** The instant in `to` that shows the wall-clock time `at` shows in `from`. */
export function sameWallClockIn(at: Date, from: string, to: string): Date {
  const wall = at.getTime() + zoneOffsetMs(at.getTime(), validTimezoneOrUtc(from));
  return new Date(zonedInstant(wall, validTimezoneOrUtc(to)));
}

function joinNames(names: readonly string[]): string {
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "1-5" → [1..5], "1,4" → [1, 4]; null when the field is not plain days. 7 is Sunday too. */
function weekdays(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d)(?:-(\d))?$/.exec(part);
    if (!range) return null;
    const start = Number(range[1]);
    const end = Number(range[2] ?? range[1]);
    if (start > end || end > 7) return null;
    for (let day = start; day <= end; day += 1) days.add(day % 7);
  }
  return [...days].sort((left, right) => ((left + 6) % 7) - ((right + 6) % 7));
}

/** "30", "9,17" → 09:30 and 17:30; null unless a valid minute and plain hours. */
function clockTimes(minute: string, hour: string): CronTime[] | null {
  const hours = hour.split(",");
  if (!inRange(minute, 0, 59) || !hours.every((value) => inRange(value, 0, 23))) return null;
  return [...new Set(hours.map(Number))]
    .sort((left, right) => left - right)
    .map((value) => ({ hour: value, minute: Number(minute) }));
}

function clock24({ hour, minute }: CronTime): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** The schedule in English for the server's routine card; exact steps and plain times only. */
function cadence(cron: string): string | null {
  const schedule = cronSchedule(cron);
  switch (schedule.kind) {
    case "every": {
      if (!schedule.exact || schedule.unit === "days") return null;
      const unit = schedule.unit === "minutes" ? "minute" : "hour";
      return schedule.n === 1 ? `Every ${unit}` : `Every ${schedule.n} ${unit}s`;
    }
    case "daily":
      return `Every day at ${joinNames(schedule.times.map(clock24))}`;
    case "weekly": {
      const at = joinNames(schedule.times.map(clock24));
      if (schedule.weekdays.join(",") === "1,2,3,4,5") return `Weekdays at ${at}`;
      return `${joinNames(schedule.weekdays.map((index) => DAY_NAMES[index]!))} at ${at}`;
    }
    case "monthly":
      return `Monthly on day ${schedule.day} at ${joinNames(schedule.times.map(clock24))}`;
    default:
      return null;
  }
}

function onceLabel(at: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `Once on ${parts.month} ${parts.day}, ${parts.year} at ${parts.hour}:${parts.minute}`;
}

/**
 * What a routine card says about when it runs, always with its zone: computed from the schedule
 * the server resolved and will store, never from the model's words.
 */
export function routineScheduleLabel(
  schedule: { crons: string[]; nextRunAt: Date | null },
  timezone: string,
): string {
  const when = isOneShotRoutineCrons(schedule.crons)
    ? schedule.nextRunAt
      ? onceLabel(schedule.nextRunAt, timezone)
      : "Once"
    : schedule.crons.map((cron) => cadence(cron) ?? `On the schedule ${cron}`).join(", ");
  return `${when} ${timezone}`;
}

function validTimezoneOrUtc(timezone: string): string {
  return isValidTimezone(timezone) ? timezone : "UTC";
}

function parseClock(time: string): { hour: number; minute: number } {
  const [rawH, rest] = time.split(":");
  const minute = Number((rest ?? "00").slice(0, 2));
  let hour = Number(rawH);
  if (/pm/i.test(time) && hour < 12) hour += 12;
  if (/am/i.test(time) && hour === 12) hour = 0;
  return { hour, minute };
}

function formatClock(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${period}`;
}

function stepValue(expr: string): number | null {
  const match = /^\*\/(\d+)$/.exec(expr);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isInt(expr: string): boolean {
  return /^\d+$/.test(expr);
}

function inRange(expr: string, min: number, max: number): boolean {
  return isInt(expr) && Number(expr) >= min && Number(expr) <= max;
}
