import type { Routine } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { routineCardSchedule } from "./routine-draft.js";

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
    requireToolApproval: true,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunFailureKind: null,
    nextRunAt: "2026-10-07T09:00:00.000Z",
    createdAt: "2026-10-01T09:00:00.000Z",
    ...partial,
  };
}

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
    expect(
      routineCardSchedule(stored({ crons: [], githubEnabled: true, messageProvider: "teams" })),
    ).toBe("Git event · Teams message");
    expect(routineCardSchedule(stored({ crons: [], messageProvider: "sendblue" }))).toBe(
      "Message event",
    );
    expect(routineCardSchedule(stored({ crons: [] }))).toBe("No trigger");
    expect(routineCardSchedule(stored({ active: false, timezone: "Europe/Paris" }))).toBe(
      "Every day at 09:00 Europe/Paris · paused",
    );
    expect(routineCardSchedule(stored({ crons: ["@once"], active: false }))).toBe(
      "Once UTC · paused",
    );
  });
});
