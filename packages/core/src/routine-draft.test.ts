import type { Routine } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { type CronPreset, cronFromPreset, presetFromCron } from "./cron.js";
import {
  applyTriggerEdit,
  draftFromRoutine,
  emptyRoutineDraft,
  newScheduleEdit,
  type RoutineDraft,
  removeTriggerEffect,
  routineCadence,
  routineCardSchedule,
  routineNeedsOneShotArm,
  routineTriggers,
  triggerEditArmsOneShot,
  triggerEditFor,
  triggerEditRef,
  triggerPatch,
  triggerSave,
  validateRoutineDraft,
  withoutTrigger,
} from "./routine-draft.js";

const NOW = new Date(2026, 9, 6, 10, 30, 0);
const now = () => NOW;
const defaults = { name: "Routine", prompt: "Check in." };

function preset(partial: Partial<CronPreset> & Pick<CronPreset, "freq">): CronPreset {
  return { n: 3, unit: "minutes", time: "9:00 AM", cron: "", ...partial };
}

function routine(partial: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    botId: "bot-1",
    name: "Morning digest",
    prompt: "Summarise the inbox",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    notify: false,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    lastRunStatus: null,
    lastRunFailureKind: null,
    requireToolApproval: true,
    lastRunAt: null,
    nextRunAt: "2026-10-07T09:00:00.000Z",
    createdAt: "2026-10-01T09:00:00.000Z",
    ...partial,
  };
}

function draft(partial: Partial<RoutineDraft> = {}): RoutineDraft {
  return { ...emptyRoutineDraft(), ...partial };
}

const daily = preset({ freq: "Every day", time: "9:00 AM" });
const unarmedOneShot = routine({
  crons: ["@once"],
  nextRunAt: null,
  lastRunAt: null,
  active: false,
});

describe("routineNeedsOneShotArm", () => {
  const never = { nextRunAt: null, lastRunAt: null };
  it.each([
    ["a never-run one-shot", never, ["@once"], true],
    [
      "a one-shot that is scheduled",
      { nextRunAt: "2026-10-07T09:00:00.000Z", lastRunAt: null },
      ["@once"],
      false,
    ],
    [
      "a one-shot that already ran",
      { nextRunAt: null, lastRunAt: "2026-10-05T09:00:00.000Z" },
      ["@once"],
      false,
    ],
    ["a recurring schedule", never, ["0 9 * * *"], false],
    ["a one-shot mixed with a schedule", never, ["@once", "0 9 * * *"], false],
    ["no schedule", never, [], false],
  ])("is %s", (_label, run, crons, expected) => {
    expect(routineNeedsOneShotArm(run, crons)).toBe(expected);
  });
});

describe("draftFromRoutine", () => {
  it("copies the routine and turns each cron into a preset", () => {
    expect(
      draftFromRoutine(
        routine({
          crons: ["0 9 * * *", "0 * * * *"],
          webhookEnabled: true,
          messageProvider: "slack",
          notify: true,
          requireToolApproval: false,
        }),
        now,
      ),
    ).toEqual({
      name: "Morning digest",
      prompt: "Summarise the inbox",
      schedules: [preset({ freq: "Every day", time: "9:00 AM" }), preset({ freq: "Every hour" })],
      webhookEnabled: true,
      githubEnabled: false,
      messageProvider: "slack",
      requireToolApproval: false,
      active: true,
      notify: true,
      runAtLocal: "",
    });
  });

  it("proposes a run time one hour from now for a never-run one-shot", () => {
    expect(draftFromRoutine(unarmedOneShot, now).runAtLocal).toBe("2026-10-06T11:30");
  });

  it("leaves the run time empty for a one-shot that already ran", () => {
    const ran = routine({
      crons: ["@once"],
      nextRunAt: null,
      lastRunAt: "2026-10-05T09:00:00.000Z",
    });
    expect(draftFromRoutine(ran, now).runAtLocal).toBe("");
  });
});

describe("validateRoutineDraft", () => {
  it.each([
    ["nothing", draft()],
    ["only an empty message provider", draft({ messageProvider: "" })],
  ])("refuses a draft with no trigger: %s", (_label, input) => {
    expect(validateRoutineDraft(input, null, now, defaults)).toEqual({
      ok: false,
      error: { code: "no_trigger" },
    });
  });

  it("builds a create payload from a schedule, with the fallback name and prompt", () => {
    expect(validateRoutineDraft(draft({ schedules: [daily] }), null, now, defaults)).toEqual({
      ok: true,
      payload: {
        name: "Routine",
        prompt: "Check in.",
        crons: ["0 9 * * *"],
        active: true,
        notify: false,
        webhookEnabled: false,
        githubEnabled: false,
        messageProvider: null,
        requireToolApproval: true,
      },
    });
  });

  it("keeps the typed name and prompt and every flag", () => {
    const result = validateRoutineDraft(
      draft({
        name: "Standup",
        prompt: "Post the standup",
        schedules: [
          preset({ freq: "Weekdays", time: "8:30 AM" }),
          preset({ freq: "Interval", n: 2, unit: "hours" }),
        ],
        webhookEnabled: true,
        githubEnabled: true,
        messageProvider: "teams",
        requireToolApproval: false,
        active: false,
        notify: true,
      }),
      routine(),
      now,
      defaults,
    );
    expect(result).toEqual({
      ok: true,
      payload: {
        name: "Standup",
        prompt: "Post the standup",
        crons: ["30 8 * * 1-5", "0 */2 * * *"],
        active: false,
        notify: true,
        webhookEnabled: true,
        githubEnabled: true,
        messageProvider: "teams",
        requireToolApproval: false,
      },
    });
  });

  it("accepts an inbound-only routine with no schedule", () => {
    const result = validateRoutineDraft(draft({ githubEnabled: true }), null, now, defaults);
    expect(result).toMatchObject({ ok: true, payload: { crons: [], githubEnabled: true } });
  });

  describe("arming a never-run one-shot", () => {
    const oneShot = preset({ freq: "Advanced", cron: "@once" });

    it("needs a run time", () => {
      expect(
        validateRoutineDraft(draft({ schedules: [oneShot] }), unarmedOneShot, now, defaults),
      ).toEqual({ ok: false, error: { code: "run_at_missing" } });
    });

    it.each([
      ["unparseable", "not a date"],
      ["now", "2026-10-06T10:30"],
      ["in the past", "2026-10-06T09:00"],
    ])("refuses a run time that is %s", (_label, runAtLocal) => {
      expect(
        validateRoutineDraft(
          draft({ schedules: [oneShot], runAtLocal }),
          unarmedOneShot,
          now,
          defaults,
        ),
      ).toEqual({ ok: false, error: { code: "run_at_past" } });
    });

    it("sends the run time as an ISO instant and forces the routine active", () => {
      const result = validateRoutineDraft(
        draft({ schedules: [oneShot], runAtLocal: "2026-10-06T11:30", active: false }),
        unarmedOneShot,
        now,
        defaults,
      );
      expect(result).toEqual({
        ok: true,
        payload: {
          name: "Routine",
          prompt: "Check in.",
          crons: ["@once"],
          active: true,
          notify: false,
          webhookEnabled: false,
          githubEnabled: false,
          messageProvider: null,
          requireToolApproval: true,
          runAt: new Date(2026, 9, 6, 11, 30).toISOString(),
        },
      });
    });

    it("ignores the run time when creating", () => {
      const result = validateRoutineDraft(
        draft({ schedules: [oneShot], runAtLocal: "not a date", active: false }),
        null,
        now,
        defaults,
      );
      expect(result).toMatchObject({ ok: true, payload: { active: false, crons: ["@once"] } });
      expect(result.ok && "runAt" in result.payload).toBe(false);
    });

    it("ignores the run time once the one-shot has run", () => {
      const ran = routine({
        crons: ["@once"],
        nextRunAt: null,
        lastRunAt: "2026-10-05T09:00:00.000Z",
      });
      const result = validateRoutineDraft(
        draft({ schedules: [oneShot], active: false }),
        ran,
        now,
        defaults,
      );
      expect(result).toMatchObject({ ok: true, payload: { active: false } });
      expect(result.ok && "runAt" in result.payload).toBe(false);
    });
  });
});

describe("removeTriggerEffect", () => {
  const two = draft({ schedules: [daily, preset({ freq: "Every hour" })] });

  it.each([
    ["one of two schedules", two, { kind: "schedule", index: 1 }, "ok"],
    [
      "a webhook next to a schedule",
      draft({ schedules: [daily], webhookEnabled: true }),
      { kind: "webhook" },
      "confirm",
    ],
    [
      "GitHub next to a schedule",
      draft({ schedules: [daily], githubEnabled: true }),
      { kind: "github" },
      "confirm",
    ],
    [
      "a message trigger next to a schedule",
      draft({ schedules: [daily], messageProvider: "slack" }),
      { kind: "message" },
      "confirm",
    ],
    [
      "a schedule next to a webhook",
      draft({ schedules: [daily], webhookEnabled: true }),
      { kind: "schedule", index: 0 },
      "ok",
    ],
    [
      "the only schedule",
      draft({ schedules: [daily] }),
      { kind: "schedule", index: 0 },
      "last_trigger",
    ],
    ["the only webhook", draft({ webhookEnabled: true }), { kind: "webhook" }, "last_trigger"],
    ["the only GitHub trigger", draft({ githubEnabled: true }), { kind: "github" }, "last_trigger"],
    [
      "the only message trigger",
      draft({ messageProvider: "teams" }),
      { kind: "message" },
      "last_trigger",
    ],
    ["a webhook that is off", draft({ schedules: [daily] }), { kind: "webhook" }, "ok"],
    [
      "a schedule index past the end",
      draft({ schedules: [daily] }),
      { kind: "schedule", index: 1 },
      "ok",
    ],
    [
      "a negative schedule index",
      draft({ schedules: [daily] }),
      { kind: "schedule", index: -1 },
      "ok",
    ],
  ] as const)("removing %s is %s", (_label, input, trigger, expected) => {
    expect(removeTriggerEffect(input, trigger)).toBe(expected);
  });
});

describe("routineTriggers and withoutTrigger", () => {
  const full = draft({
    schedules: [presetFromCron("0 9 * * *"), presetFromCron("0 17 * * 5")],
    webhookEnabled: true,
    githubEnabled: false,
    messageProvider: "slack",
  });

  it("lists schedules by index, then each inbound source", () => {
    expect(routineTriggers(full)).toEqual([
      { kind: "schedule", index: 0 },
      { kind: "schedule", index: 1 },
      { kind: "webhook" },
      { kind: "message" },
    ]);
  });

  it("takes out the one schedule asked for and keeps the rest", () => {
    const next = withoutTrigger(full, { kind: "schedule", index: 0 });
    expect(next.schedules.map(cronFromPreset)).toEqual(["0 17 * * 5"]);
    expect(next.webhookEnabled).toBe(true);
  });

  it("turns an inbound source off", () => {
    expect(withoutTrigger(full, { kind: "message" }).messageProvider).toBeNull();
    expect(withoutTrigger(full, { kind: "webhook" }).webhookEnabled).toBe(false);
  });
});

describe("routineCardSchedule", () => {
  const stored = (partial: Partial<Routine> = {}) => ({
    ...routine(partial),
    nextRunAt: partial.nextRunAt ? new Date(partial.nextRunAt) : null,
  });

  it("says when a stored routine runs, whatever its triggers, and never nothing", () => {
    expect(routineCardSchedule(stored({ crons: ["0 9 * * 1-5", "0 10 * * 0,6"] }))).toBe(
      "Weekdays at 09:00, Saturdays and Sundays at 10:00 UTC",
    );
    expect(
      routineCardSchedule(stored({ crons: [], webhookEnabled: true, messageProvider: "slack" })),
    ).toBe("When a webhook fires · Slack message");
    expect(routineCardSchedule(stored({ active: false, timezone: "Europe/Paris" }))).toBe(
      "Every day at 09:00 Europe/Paris · paused",
    );
    expect(routineCardSchedule(stored({ crons: ["@once"], active: false }))).toBe(
      "Once UTC · paused",
    );
  });
});

describe("routineCadence", () => {
  it("keeps a missing next run as null", () => {
    expect(routineCadence(routine({ nextRunAt: null }))).toMatchObject({
      kind: "scheduled",
      nextRunAt: null,
    });
  });

  it("prefers the schedule when inbound sources exist too", () => {
    expect(routineCadence(routine({ webhookEnabled: true }))).toMatchObject({ kind: "scheduled" });
  });

  it("lists inbound sources in a fixed order", () => {
    expect(
      routineCadence(
        routine({
          crons: [],
          nextRunAt: null,
          messageProvider: "slack",
          webhookEnabled: true,
          githubEnabled: true,
        }),
      ),
    ).toEqual({ kind: "inbound", sources: ["webhook", "github", "message"] });
  });

  it.each([
    ["a schedule", routine({ active: false }), "schedule"],
    ["a schedule over a webhook", routine({ active: false, webhookEnabled: true }), "schedule"],
    [
      "a webhook",
      routine({
        active: false,
        crons: [],
        nextRunAt: null,
        webhookEnabled: true,
        githubEnabled: true,
      }),
      "webhook",
    ],
    [
      "GitHub",
      routine({
        active: false,
        crons: [],
        nextRunAt: null,
        githubEnabled: true,
        messageProvider: "slack",
      }),
      "github",
    ],
    [
      "a message trigger",
      routine({ active: false, crons: [], nextRunAt: null, messageProvider: "slack" }),
      "message",
    ],
  ] as const)("says a paused routine is paused on %s", (_label, run, trigger) => {
    expect(routineCadence(run)).toEqual({ kind: "paused", trigger });
  });

  it("reports a routine with no trigger at all", () => {
    expect(routineCadence(routine({ crons: [], nextRunAt: null }))).toEqual({ kind: "none" });
    expect(routineCadence(routine({ crons: [], nextRunAt: null, active: false }))).toEqual({
      kind: "none",
    });
  });
});

describe("triggerPatch", () => {
  const payload = (partial: Partial<Parameters<typeof triggerPatch>[1]> = {}) => ({
    name: "Morning digest",
    prompt: "Summarise the inbox",
    crons: ["0 9 * * *"],
    active: true,
    notify: false,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    requireToolApproval: true,
    ...partial,
  });

  it("sends only the trigger fields that changed, never a stale active", () => {
    const paused = routine({ active: false });
    expect(triggerPatch(paused, payload({ webhookEnabled: true }))).toEqual({
      webhookEnabled: true,
    });
    expect(triggerPatch(paused, payload({ crons: ["0 9 * * *", "0 18 * * *"] }))).toEqual({
      crons: ["0 9 * * *", "0 18 * * *"],
    });
    expect(triggerPatch(paused, payload())).toEqual({});
  });

  it("switches the routine on only when it arms a one-shot", () => {
    expect(
      triggerPatch(
        unarmedOneShot,
        payload({ crons: ["@once"], active: true, runAt: "2026-10-06T12:00:00.000Z" }),
      ),
    ).toEqual({ active: true, runAt: "2026-10-06T12:00:00.000Z" });
  });
});

describe("a trigger editor's Done on a saved routine", () => {
  const saved = routine({ crons: ["0 9 * * *"] });
  const savedDraft = () => draftFromRoutine(saved, now);

  it("sends the changed schedule's cron and nothing else", () => {
    const edit = triggerEditFor(savedDraft(), { kind: "schedule", index: 0 });
    if (edit.kind !== "schedule") throw new Error("schedule editor expected");
    const next = applyTriggerEdit(savedDraft(), {
      ...edit,
      preset: { ...edit.preset, freq: "Weekdays", time: "7:30 AM" },
    });
    expect(triggerSave(saved, next, now)).toEqual({
      ok: true,
      patch: { crons: ["30 7 * * 1-5"] },
      needsWebhookKey: false,
    });
  });

  it("appends a new schedule of the chosen frequency", () => {
    const next = applyTriggerEdit(savedDraft(), newScheduleEdit(savedDraft(), "Every hour"));
    expect(triggerSave(saved, next, now)).toEqual({
      ok: true,
      patch: { crons: ["0 9 * * *", "0 * * * *"] },
      needsWebhookKey: false,
    });
  });

  it("turns a webhook on and says it needs the bot's key", () => {
    const next = applyTriggerEdit(savedDraft(), { kind: "webhook", adding: true });
    expect(triggerSave(saved, next, now)).toEqual({
      ok: true,
      patch: { webhookEnabled: true },
      needsWebhookKey: true,
    });
  });

  it("sets the message provider a Slack editor chose", () => {
    const next = applyTriggerEdit(savedDraft(), {
      kind: "message",
      provider: "slack",
      adding: true,
    });
    expect(triggerSave(saved, next, now)).toEqual({
      ok: true,
      patch: { messageProvider: "slack" },
      needsWebhookKey: false,
    });
  });

  it("asks for a run time before arming a one-shot, and refuses one in the past", () => {
    const oneShotDraft = draftFromRoutine(unarmedOneShot, now);
    const edit = triggerEditFor(oneShotDraft, { kind: "schedule", index: 0 });
    expect(triggerEditArmsOneShot(oneShotDraft, edit, unarmedOneShot)).toBe(true);
    if (edit.kind !== "schedule") throw new Error("schedule editor expected");
    const missing = applyTriggerEdit(oneShotDraft, { ...edit, runAtLocal: "" });
    expect(triggerSave(unarmedOneShot, missing, now)).toEqual({
      ok: false,
      error: { code: "run_at_missing" },
    });
    const past = applyTriggerEdit(oneShotDraft, { ...edit, runAtLocal: "2026-10-06T09:00" });
    expect(triggerSave(unarmedOneShot, past, now)).toEqual({
      ok: false,
      error: { code: "run_at_past" },
    });
    const later = applyTriggerEdit(oneShotDraft, { ...edit, runAtLocal: "2026-10-06T12:00" });
    expect(triggerSave(unarmedOneShot, later, now)).toEqual({
      ok: true,
      patch: { active: true, runAt: new Date(2026, 9, 6, 12, 0).toISOString() },
      needsWebhookKey: false,
    });
  });

  it("never asks for a run time on a recurring schedule or a routine not saved yet", () => {
    const edit = newScheduleEdit(savedDraft(), "Every day");
    expect(triggerEditArmsOneShot(savedDraft(), edit, saved)).toBe(false);
    const once = newScheduleEdit(draft(), "Advanced");
    if (once.kind !== "schedule") throw new Error("schedule editor expected");
    expect(
      triggerEditArmsOneShot(draft(), { ...once, preset: { ...once.preset, cron: "@once" } }, null),
    ).toBe(false);
  });

  it("offers Remove only on a trigger that exists", () => {
    expect(triggerEditRef(newScheduleEdit(draft(), "Weekdays"))).toBeNull();
    expect(triggerEditRef({ kind: "github", adding: true })).toBeNull();
    expect(triggerEditRef(triggerEditFor(savedDraft(), { kind: "schedule", index: 0 }))).toEqual({
      kind: "schedule",
      index: 0,
    });
    expect(triggerEditRef({ kind: "webhook", adding: false })).toEqual({ kind: "webhook" });
  });
});
