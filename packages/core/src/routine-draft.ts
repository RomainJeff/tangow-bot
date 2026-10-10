import type { Routine } from "@rakazo/contracts";
import {
  type CronFreq,
  type CronPreset,
  cronFromPreset,
  defaultCronPreset,
  isOneShotRoutineCrons,
  presetFromCron,
  routineScheduleLabel,
} from "./cron.js";

const ONE_SHOT_ARM_DELAY_MS = 60 * 60 * 1000;

export type RoutineDraft = {
  name: string;
  prompt: string;
  schedules: CronPreset[];
  webhookEnabled: boolean;
  githubEnabled: boolean;
  messageProvider: string | null;
  requireToolApproval: boolean;
  active: boolean;
  notify: boolean;
  runAtLocal: string;
};

export type RoutineDraftError =
  | { code: "no_trigger" }
  | { code: "run_at_missing" }
  | { code: "run_at_past" };

/** The fields a create or an update posts. The caller adds `botId` and `timezone` or `routineId`. */
export type RoutinePayload = {
  name: string;
  prompt: string;
  crons: string[];
  active: boolean;
  notify: boolean;
  webhookEnabled: boolean;
  githubEnabled: boolean;
  messageProvider: string | null;
  requireToolApproval: boolean;
  runAt?: string;
};

export type TriggerRef =
  | { kind: "schedule"; index: number }
  | { kind: "webhook" }
  | { kind: "github" }
  | { kind: "message" };

export function emptyRoutineDraft(): RoutineDraft {
  return {
    name: "",
    prompt: "",
    schedules: [],
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    requireToolApproval: true,
    active: true,
    notify: false,
    runAtLocal: "",
  };
}

function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function routineNeedsOneShotArm(
  routine: Pick<Routine, "nextRunAt" | "lastRunAt">,
  crons: string[],
): boolean {
  return isOneShotRoutineCrons(crons) && !routine.nextRunAt && !routine.lastRunAt;
}

export function draftFromRoutine(routine: Routine, now: () => Date): RoutineDraft {
  return {
    name: routine.name,
    prompt: routine.prompt,
    schedules: routine.crons.map(presetFromCron),
    webhookEnabled: routine.webhookEnabled,
    githubEnabled: routine.githubEnabled,
    messageProvider: routine.messageProvider,
    requireToolApproval: routine.requireToolApproval,
    active: routine.active,
    notify: routine.notify,
    runAtLocal: routineNeedsOneShotArm(routine, routine.crons)
      ? toDatetimeLocalValue(new Date(now().getTime() + ONE_SHOT_ARM_DELAY_MS))
      : "",
  };
}

function triggerCount(draft: RoutineDraft): number {
  return (
    draft.schedules.length +
    (draft.webhookEnabled ? 1 : 0) +
    (draft.githubEnabled ? 1 : 0) +
    (draft.messageProvider ? 1 : 0)
  );
}

/**
 * Checks a draft the way the editor's Save does and builds what the server is sent.
 * `defaults` stand in for an empty name or prompt, so the apps keep their own translated words.
 */
export function validateRoutineDraft(
  draft: RoutineDraft,
  existing: Pick<Routine, "nextRunAt" | "lastRunAt"> | null,
  now: () => Date,
  defaults: { name: string; prompt: string },
): { ok: true; payload: RoutinePayload } | { ok: false; error: RoutineDraftError } {
  if (triggerCount(draft) === 0) return { ok: false, error: { code: "no_trigger" } };
  const crons = draft.schedules.map(cronFromPreset);
  const armOneShot = existing != null && routineNeedsOneShotArm(existing, crons);
  let runAt: string | undefined;
  if (armOneShot) {
    if (!draft.runAtLocal) return { ok: false, error: { code: "run_at_missing" } };
    const parsed = new Date(draft.runAtLocal);
    if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= now().getTime()) {
      return { ok: false, error: { code: "run_at_past" } };
    }
    runAt = parsed.toISOString();
  }
  return {
    ok: true,
    payload: {
      name: draft.name || defaults.name,
      prompt: draft.prompt || defaults.prompt,
      crons,
      active: armOneShot ? true : draft.active,
      notify: draft.notify,
      webhookEnabled: draft.webhookEnabled,
      githubEnabled: draft.githubEnabled,
      messageProvider: draft.messageProvider,
      requireToolApproval: draft.requireToolApproval,
      ...(runAt ? { runAt } : {}),
    },
  };
}

export type TriggerPatch = Partial<
  Pick<
    RoutinePayload,
    "crons" | "webhookEnabled" | "githubEnabled" | "messageProvider" | "active" | "runAt"
  >
>;

/**
 * What saving a routine's triggers sends: only the trigger fields that moved,
 * plus `active` and `runAt` when it arms a one-shot. Never the rest of the
 * payload, which was read when the editor opened and may be stale by now
 * (an Active switch saved in between).
 */
export function triggerPatch(
  routine: Pick<Routine, "crons" | "webhookEnabled" | "githubEnabled" | "messageProvider">,
  payload: RoutinePayload,
): TriggerPatch {
  const sameCrons =
    routine.crons.length === payload.crons.length &&
    routine.crons.every((cron, index) => cron === payload.crons[index]);
  return {
    ...(sameCrons ? {} : { crons: payload.crons }),
    ...(routine.webhookEnabled === payload.webhookEnabled
      ? {}
      : { webhookEnabled: payload.webhookEnabled }),
    ...(routine.githubEnabled === payload.githubEnabled
      ? {}
      : { githubEnabled: payload.githubEnabled }),
    ...(routine.messageProvider === payload.messageProvider
      ? {}
      : { messageProvider: payload.messageProvider }),
    ...(payload.runAt ? { active: true, runAt: payload.runAt } : {}),
  };
}

/**
 * Saving a draft whose triggers changed on a routine that exists: the draft checked like a
 * create, then only the trigger fields that moved. `armOneShot` is what `triggerEditArmsOneShot`
 * said for the edit: only a schedule editor that asked for the run time arms a one-shot.
 * `needsWebhookKey` is true when the routine would listen for a webhook or a GitHub event,
 * which sign with the bot's key.
 */
export function triggerSave(
  routine: Pick<
    Routine,
    | "name"
    | "prompt"
    | "crons"
    | "webhookEnabled"
    | "githubEnabled"
    | "messageProvider"
    | "nextRunAt"
    | "lastRunAt"
  >,
  next: RoutineDraft,
  now: () => Date,
  armOneShot: boolean,
):
  | { ok: true; patch: TriggerPatch; needsWebhookKey: boolean }
  | { ok: false; error: RoutineDraftError } {
  const checked = validateRoutineDraft(next, armOneShot ? routine : null, now, {
    name: routine.name,
    prompt: routine.prompt,
  });
  if (!checked.ok) return checked;
  return {
    ok: true,
    patch: triggerPatch(routine, checked.payload),
    needsWebhookKey: checked.payload.webhookEnabled || checked.payload.githubEnabled,
  };
}

/** One trigger being added or changed in its editor. A schedule `index` of null adds one. */
export type TriggerEdit =
  | { kind: "schedule"; index: number | null; preset: CronPreset; runAtLocal: string }
  | { kind: "webhook"; adding: boolean }
  | { kind: "github"; adding: boolean }
  | { kind: "message"; provider: string; adding: boolean };

/** The draft with the edit applied, which is what the editor's Done checks and saves. */
export function applyTriggerEdit(draft: RoutineDraft, edit: TriggerEdit): RoutineDraft {
  switch (edit.kind) {
    case "schedule":
      return {
        ...draft,
        runAtLocal: edit.runAtLocal,
        schedules:
          edit.index === null
            ? [...draft.schedules, edit.preset]
            : draft.schedules.map((item, index) => (index === edit.index ? edit.preset : item)),
      };
    case "webhook":
      return { ...draft, webhookEnabled: true };
    case "github":
      return { ...draft, githubEnabled: true };
    case "message":
      return { ...draft, messageProvider: edit.provider };
  }
}

/** The editor for a trigger the draft already has. */
export function triggerEditFor(draft: RoutineDraft, trigger: TriggerRef): TriggerEdit {
  switch (trigger.kind) {
    case "schedule":
      return {
        kind: "schedule",
        index: trigger.index,
        preset: draft.schedules[trigger.index] ?? defaultCronPreset(),
        runAtLocal: draft.runAtLocal,
      };
    case "message":
      return { kind: "message", provider: draft.messageProvider ?? "", adding: false };
    default:
      return { kind: trigger.kind, adding: false };
  }
}

/** The editor for a new schedule of this frequency. An advanced one starts from the default's cron. */
export function newScheduleEdit(draft: RoutineDraft, freq: CronFreq): TriggerEdit {
  const base = defaultCronPreset();
  return {
    kind: "schedule",
    index: null,
    preset: freq === "Advanced" ? { ...base, freq, cron: cronFromPreset(base) } : { ...base, freq },
    runAtLocal: draft.runAtLocal,
  };
}

/** The trigger an editor changes, or null while it adds one (there is nothing to remove yet). */
export function triggerEditRef(edit: TriggerEdit): TriggerRef | null {
  if (edit.kind === "schedule") {
    return edit.index === null ? null : { kind: "schedule", index: edit.index };
  }
  return edit.adding ? null : { kind: edit.kind };
}

/** Whether a schedule editor must ask when to run: the saved routine would become an unarmed one-shot. */
export function triggerEditArmsOneShot(
  draft: RoutineDraft,
  edit: TriggerEdit,
  existing: Pick<Routine, "nextRunAt" | "lastRunAt"> | null,
): boolean {
  if (edit.kind !== "schedule" || existing === null) return false;
  return routineNeedsOneShotArm(
    existing,
    applyTriggerEdit(draft, edit).schedules.map(cronFromPreset),
  );
}

function hasTrigger(draft: RoutineDraft, trigger: TriggerRef): boolean {
  switch (trigger.kind) {
    case "schedule":
      return trigger.index >= 0 && trigger.index < draft.schedules.length;
    case "webhook":
      return draft.webhookEnabled;
    case "github":
      return draft.githubEnabled;
    case "message":
      return Boolean(draft.messageProvider);
  }
}

/**
 * What removing one trigger would do. `confirm` is for a trigger with an inbound URL or
 * integration that stops working. `last_trigger` wins over `confirm`: it is refused outright.
 * A trigger the draft does not have changes nothing, so it is `ok`.
 */
export function removeTriggerEffect(
  draft: RoutineDraft,
  trigger: TriggerRef,
): "ok" | "confirm" | "last_trigger" {
  if (!hasTrigger(draft, trigger)) return "ok";
  if (triggerCount(draft) === 1) return "last_trigger";
  return trigger.kind === "schedule" ? "ok" : "confirm";
}

/** The draft's triggers in the order they are listed: schedules first, then inbound sources. */
export function routineTriggers(draft: RoutineDraft): TriggerRef[] {
  const triggers: TriggerRef[] = draft.schedules.map((_, index) => ({ kind: "schedule", index }));
  if (draft.webhookEnabled) triggers.push({ kind: "webhook" });
  if (draft.githubEnabled) triggers.push({ kind: "github" });
  if (draft.messageProvider) triggers.push({ kind: "message" });
  return triggers;
}

/** The draft with one trigger taken out. Check `removeTriggerEffect` first. */
export function withoutTrigger(draft: RoutineDraft, trigger: TriggerRef): RoutineDraft {
  switch (trigger.kind) {
    case "schedule":
      return { ...draft, schedules: draft.schedules.filter((_, index) => index !== trigger.index) };
    case "webhook":
      return { ...draft, webhookEnabled: false };
    case "github":
      return { ...draft, githubEnabled: false };
    case "message":
      return { ...draft, messageProvider: null };
  }
}

export type RoutineCadence =
  | { kind: "none" }
  | { kind: "paused"; trigger: "schedule" | "webhook" | "github" | "message" }
  | { kind: "scheduled"; nextRunAt: string | null }
  | { kind: "inbound"; sources: Array<"webhook" | "github" | "message"> };

// A schedule wins over inbound sources when both exist, since it is the one with a next run.
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

/** When a stored routine runs, as its card says it, in English like the rest of the card. */
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
