/** A date the device found in a stretch of text: where it sits (UTF-16 offsets, as
 * both JavaScript strings and the platform detector count them) and when it falls. */
export type DetectedDate = {
  start: number;
  length: number;
  startMs: number;
  /** Zero when the words give no end. */
  durationS: number;
};

export type DatedSegment = { text: string; date?: DetectedDate };

/**
 * Splits text around the dates found in it. A date already over is left as text:
 * there is nothing to add to a calendar, and a relative word such as "yesterday"
 * would otherwise be offered too. Ranges that overlap or fall outside the text are
 * dropped rather than trusted.
 */
export function splitDetectedDates(
  text: string,
  dates: readonly DetectedDate[],
  nowMs: number,
): DatedSegment[] {
  const segments: DatedSegment[] = [];
  let last = 0;
  for (const date of [...dates].sort((a, b) => a.start - b.start)) {
    const end = date.start + date.length;
    if (date.length <= 0 || date.start < last || end > text.length) continue;
    if (date.startMs + Math.max(date.durationS, 0) * 1000 < nowMs) continue;
    if (date.start > last) segments.push({ text: text.slice(last, date.start) });
    segments.push({ text: text.slice(date.start, end), date });
    last = end;
  }
  if (last < text.length || segments.length === 0) segments.push({ text: text.slice(last) });
  return segments;
}

const timeOfDay =
  /\d\s*(?:h\b|h\d|:\d|am\b|pm\b|ч|点|點|时|時)|\b(?:midi|minuit|noon|midnight)\b|полдень|полночь/i;

/** Whether the words give a time of day. A bare day ("samedi", "3 août") becomes an
 * all-day event instead of one at the hour the detector fills in for it. */
export function namesTimeOfDay(words: string): boolean {
  return timeOfDay.test(words);
}

const TITLE_MAX = 80;

/** The sentence holding the date, offered as the event's title: the calendar sheet
 * shows it before anything is saved, so the person can rename it there. */
export function sentenceAround(text: string, start: number, length: number): string {
  const before = text.slice(0, start);
  const from = Math.max(...[".", "!", "?", "\n"].map((mark) => before.lastIndexOf(mark))) + 1;
  const rest = text.slice(start + length);
  const stop = rest.search(/[.!?\n]/);
  const to = stop === -1 ? text.length : start + length + stop;
  const sentence = text.slice(from, to).replace(/\s+/g, " ").trim();
  return sentence.length > TITLE_MAX ? `${sentence.slice(0, TITLE_MAX - 1).trimEnd()}…` : sentence;
}

/** What a tapped date adds to the calendar. */
export type CalendarEvent = { title: string; startMs: number; endMs: number; allDay: boolean };

const ONE_HOUR_MS = 3_600_000;

/** The event a tapped date stands for. A bare day is an all-day event; a time
 * without an end lasts an hour, the calendar's own default. */
export function eventForDate(date: DetectedDate, text: string): CalendarEvent {
  const words = text.slice(date.start, date.start + date.length);
  const endMs =
    date.durationS > 0 ? date.startMs + date.durationS * 1000 : date.startMs + ONE_HOUR_MS;
  return {
    title: sentenceAround(text, date.start, date.length),
    startMs: date.startMs,
    endMs,
    allDay: !namesTimeOfDay(words),
  };
}
