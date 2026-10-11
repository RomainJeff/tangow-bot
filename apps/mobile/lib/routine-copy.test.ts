import type { Routine } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetI18nForTests } from "./i18n";
import { cadenceLine, describeSchedule, routinesSummary } from "./routine-copy";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

const NOW = Date.parse("2026-10-06T19:00:00.000Z");

function routine(partial: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    botId: "bot-1",
    name: "Morning sweep",
    prompt: "Sweep the inbox",
    crons: ["0 8 * * 1-5"],
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
    nextRunAt: "2026-10-07T08:00:00.000Z",
    createdAt: "2026-10-01T09:00:00.000Z",
    ...partial,
  };
}

describe("routine copy", () => {
  afterEach(() => resetI18nForTests("en"));

  it("says when a scheduled routine runs next", () => {
    expect(cadenceLine(routine(), NOW)).toBe("Weekdays at 8:00 AM · next in 13 hr");
  });

  it("says how the last run failed instead of the raw error", () => {
    const failed = routine({
      lastRunStatus: "failed",
      lastRunFailureKind: "missing_model",
      lastRunAt: "2026-10-05T18:00:00.000Z",
    });
    expect(cadenceLine(failed, NOW)).toBe("Failed yesterday · No model connected");
    expect(cadenceLine({ ...failed, lastRunFailureKind: "other" }, NOW)).toBe("Failed yesterday");
  });

  it("names an inbound trigger and a paused routine", () => {
    const webhook = routine({ crons: [], webhookEnabled: true, nextRunAt: null });
    expect(cadenceLine(webhook, NOW)).toBe("When a webhook fires");
    expect(cadenceLine({ ...webhook, active: false }, NOW)).toBe("When a webhook fires · paused");
  });

  it("counts routines and names the soonest next run of the active ones", () => {
    const later = routine({ id: "r2", nextRunAt: "2026-10-08T08:00:00.000Z" });
    const paused = routine({ id: "r3", active: false, nextRunAt: "2026-10-06T19:30:00.000Z" });
    expect(routinesSummary([routine(), later, paused], NOW)).toBe("3 routines · next in 13 hr");
    expect(routinesSummary([paused], NOW)).toBe("1 routine");
  });

  it("words a weekday, a date of the month and a date of the year instead of the cron", () => {
    expect(
      cadenceLine(routine({ crons: ["0 10 * * 6"], nextRunAt: "2026-10-10T10:00:00.000Z" }), NOW),
    ).toBe("Weekly on Saturday at 10:00 AM · next in 4 days");
    expect(describeSchedule("0 10 15 * *")).toBe("Monthly on day 15 at 10:00 AM");
    expect(describeSchedule("0 9 6 10 *")).toBe("Yearly on October 6 at 9:00 AM");
    expect(describeSchedule("0 10 * * 1,3")).toBe("Cron 0 10 * * 1,3");
    resetI18nForTests("ru");
    expect(describeSchedule("0 10 * * 6")).toBe("Еженедельно, суббота, в 10:00 AM");
  });

  it("speaks the reader's language, with Russian unit cases", () => {
    resetI18nForTests("ru");
    expect(describeSchedule("*/5 * * * *")).toBe("Каждые 5 минут");
    expect(describeSchedule("0 */2 * * *")).toBe("Каждые 2 часа");
    expect(cadenceLine(routine(), NOW)).toBe("По будням в 8:00 AM · следующий запуск через 13 ч");
    resetI18nForTests("zh-CN");
    expect(describeSchedule("0 8 * * 1-5")).toBe("工作日 8:00 AM");
  });
});
