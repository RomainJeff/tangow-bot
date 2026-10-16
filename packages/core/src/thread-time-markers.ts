/** Same-day silence after which a transcript shows the date and time again. */
export const THREAD_TIME_MARKER_GAP_MS = 4 * 60 * 60 * 1000;

function localDayIndex(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

export function isSameLocalDay(a: string, b: string): boolean {
  return localDayIndex(new Date(a)) === localDayIndex(new Date(b));
}

export function failureSinceLabel(sinceIso: string, newestIso: string, locale: string): string {
  const since = new Date(sinceIso);
  const time = since.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (isSameLocalDay(sinceIso, newestIso)) return time;
  return `${since.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
}

/**
 * Whether a transcript row opens a new stretch of conversation: the first
 * loaded message, a new local calendar day, or a return after `gapMs` of
 * silence. Callers pass the previous *visible* message, so hidden activity
 * rows neither swallow a marker nor invent a gap.
 */
export function showsTimeMarker(
  previousCreatedAt: string | undefined,
  createdAt: string,
  gapMs: number = THREAD_TIME_MARKER_GAP_MS,
): boolean {
  const current = new Date(createdAt);
  if (Number.isNaN(current.getTime())) return false;
  if (previousCreatedAt == null) return true;
  const previous = new Date(previousCreatedAt);
  if (Number.isNaN(previous.getTime())) return true;
  if (localDayIndex(previous) !== localDayIndex(current)) return true;
  return current.getTime() - previous.getTime() >= gapMs;
}

/**
 * Absolute label for a time marker: "Today 7:19 PM", "Yesterday 7:19 PM", or
 * "Wed, Sep 2 7:19 PM" further back. `today` and `yesterday` arrive already
 * translated, so each surface keeps its own i18n runtime.
 *
 * ponytail: `now` is read at render, so a thread left open across midnight
 * keeps saying "Today" until the next message repaints it. Add a midnight
 * tick only if that ever bites.
 */
export function threadTimeMarkerLabel(
  createdAt: string,
  options: {
    locale: string;
    today: string;
    yesterday: string;
    now?: Date;
    /** False for the day alone ("Today", "Wed, Sep 2"). */
    withTime?: boolean;
  },
): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  const locale = options.locale || "en";
  const time = date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const dayDiff = Math.round(
    (localDayIndex(options.now ?? new Date()) - localDayIndex(date)) / 86_400_000,
  );
  const day =
    dayDiff === 0
      ? options.today
      : dayDiff === 1
        ? options.yesterday
        : date.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" });
  return options.withTime === false ? day : `${day} ${time}`;
}
