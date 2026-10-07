import type { Routine } from "@rakazo/contracts";
import { routineScheduleLabel } from "./cron.js";

export type RoutineCadence =
  | { kind: "none" }
  | { kind: "paused"; trigger: "schedule" | "webhook" | "github" | "message" }
  | { kind: "scheduled"; nextRunAt: string | null }
  | { kind: "inbound"; sources: Array<"webhook" | "github" | "message"> };

/**
 * The routine's cadence as data, so each app words it in its own language. A schedule wins over
 * inbound sources when both exist, since it is the one with a next run.
 */
export function routineCadence(
  routine: Pick<
    Routine,
    "active" | "crons" | "webhookEnabled" | "githubEnabled" | "messageProvider" | "nextRunAt"
  >,
): RoutineCadence {
  const sources: Array<"webhook" | "github" | "message"> = [];
  if (routine.webhookEnabled) sources.push("webhook");
  if (routine.githubEnabled) sources.push("github");
  if (routine.messageProvider) sources.push("message");
  const first = routine.crons.length > 0 ? "schedule" : sources[0];
  if (!first) return { kind: "none" };
  if (!routine.active) return { kind: "paused", trigger: first };
  if (routine.crons.length > 0) {
    return { kind: "scheduled", nextRunAt: routine.nextRunAt };
  }
  return { kind: "inbound", sources };
}

const INBOUND_CARD_LABELS: Record<string, string> = {
  webhook: "When a webhook fires",
  github: "Git event",
  slack: "Slack message",
  teams: "Teams message",
};

/**
 * When a stored routine runs, as its card says it, in English like the rest of the card: the
 * words the routine list uses, read from the same cadence. Never empty.
 */
export function routineCardSchedule(
  routine: Pick<
    Routine,
    "active" | "crons" | "timezone" | "webhookEnabled" | "githubEnabled" | "messageProvider"
  > & { nextRunAt: Date | null },
): string {
  const cadence = routineCadence({
    ...routine,
    nextRunAt: routine.nextRunAt?.toISOString() ?? null,
  });
  const inbound = (source: "webhook" | "github" | "message") =>
    INBOUND_CARD_LABELS[source === "message" ? (routine.messageProvider ?? "") : source] ??
    "Message event";
  switch (cadence.kind) {
    case "none":
      return "No trigger";
    case "scheduled":
      return routineScheduleLabel(routine, routine.timezone);
    case "inbound":
      return cadence.sources.map(inbound).join(" · ");
    case "paused": {
      const what =
        cadence.trigger === "schedule"
          ? routineScheduleLabel(routine, routine.timezone)
          : inbound(cadence.trigger);
      return `${what} · paused`;
    }
  }
}
