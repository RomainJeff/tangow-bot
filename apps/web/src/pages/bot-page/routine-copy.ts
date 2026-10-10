import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Routine, RunFailureKind } from "@rakazo/contracts";
import {
  type RoutineDraft,
  type RoutineDraftError,
  routineCadence,
  type TriggerRef,
} from "@rakazo/core";
import { describeSchedule } from "../RoutineSchedule";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "in 14 hr.", "yesterday": a moment from now, in the reader's language. */
function relativeTime(iso: string, locale: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  if (Math.abs(diff) < HOUR) return format.format(Math.round(diff / MINUTE), "minute");
  if (Math.abs(diff) < DAY) return format.format(Math.round(diff / HOUR), "hour");
  return format.format(Math.round(diff / DAY), "day");
}

/** The words for routines: their cadence, last run, triggers and validation errors. */
export function useRoutineCopy() {
  const { t, i18n } = useLingui();
  const locale = i18n.locale || "en";

  function messageLabel(provider: string): string {
    if (provider === "slack") return t`Slack message`;
    if (provider === "teams") return t`Teams message`;
    return t`Message event`;
  }

  function inboundLabel(source: "webhook" | "github" | "message", provider: string | null) {
    if (source === "webhook") return t`When a webhook fires`;
    if (source === "github") return t`Git event`;
    return messageLabel(provider ?? "");
  }

  function failureReason(kind: RunFailureKind | null): string | null {
    if (kind === "missing_model") return t`No model connected`;
    if (kind === "computer") return t`Computer unavailable`;
    if (kind === "provider") return t`Model error`;
    return null;
  }

  /** One line under a routine: when it runs and when next, how its last run failed, or that it is paused. */
  function cadenceLine(routine: Routine, now = Date.now()): string {
    const cadence = routineCadence(routine);
    const schedules = routine.crons.map((cron) => describeSchedule(cron, locale)).join(", ");
    if (cadence.kind === "none") return t`No trigger`;
    if (cadence.kind === "paused") {
      const what =
        cadence.trigger === "schedule"
          ? schedules
          : inboundLabel(cadence.trigger, routine.messageProvider);
      return t`${what} · paused`;
    }
    if (routine.lastRunStatus === "failed") {
      const when = routine.lastRunAt ? relativeTime(routine.lastRunAt, locale, now) : "";
      const failed = when ? t`Failed ${when}` : t`Failed`;
      const reason = failureReason(routine.lastRunFailureKind);
      return reason ? `${failed} · ${reason}` : failed;
    }
    if (cadence.kind === "inbound") {
      return cadence.sources
        .map((source) => inboundLabel(source, routine.messageProvider))
        .join(" · ");
    }
    if (!cadence.nextRunAt) return schedules;
    const next = relativeTime(cadence.nextRunAt, locale, now);
    return t`${schedules} · next ${next}`;
  }

  /** "3 routines · next in 14 hr.": how many, and the soonest next run of the active ones. */
  function listSummary(routines: readonly Routine[], now = Date.now()): string {
    const count = plural(routines.length, { one: "# routine", other: "# routines" });
    const soonest = routines
      .filter((routine) => routine.active && routine.nextRunAt)
      .map((routine) => routine.nextRunAt as string)
      .filter((iso) => new Date(iso).getTime() > now)
      .sort()[0];
    if (!soonest) return count;
    const next = relativeTime(soonest, locale, now);
    return t`${count} · next ${next}`;
  }

  function triggerLabel(draft: RoutineDraft, trigger: TriggerRef): string {
    if (trigger.kind === "schedule") {
      const preset = draft.schedules[trigger.index];
      return preset ? t`On a schedule` : "";
    }
    return inboundLabel(trigger.kind, draft.messageProvider);
  }

  function draftError(error: RoutineDraftError): string {
    switch (error.code) {
      case "no_trigger":
        return t`Add a schedule, webhook, GitHub, or message trigger`;
      case "run_at_missing":
        return t`Add a run time for this one-shot.`;
      case "run_at_past":
        return t`Run time must be in the future.`;
    }
  }

  return {
    messageLabel,
    cadenceLine,
    listSummary,
    triggerLabel,
    draftError,
    scheduleLabel: (cron: string) => describeSchedule(cron, locale),
  };
}
