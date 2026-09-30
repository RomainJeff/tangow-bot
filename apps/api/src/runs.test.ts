import { RunActivityRowSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { RunActivitySourceRow } from "./runs.js";
import { activityNotificationsEnabled, activityPromptSnippet, runActivityFromRow } from "./runs.js";

function runRow(overrides: Partial<RunActivitySourceRow> = {}): RunActivitySourceRow {
  return {
    id: "run-1",
    botId: "bot-1",
    bot: { name: "Researcher", notifyOnFinish: true },
    threadId: "thread-1",
    thread: { groupId: null, group: null },
    status: "running",
    trigger: "user",
    task: { prompt: "Review the report" },
    sourceMessage: null,
    completedAt: null,
    updatedAt: new Date("2026-09-21T08:00:00.000Z"),
    harness: null,
    executionTarget: null,
    choiceVersion: null,
    scopedTaskId: null,
    ...overrides,
  };
}

describe("run activity harness choice", () => {
  it("exposes the effective harness choice recorded on the run", () => {
    const projected = runActivityFromRow(
      runRow({ harness: "codex-native", executionTarget: "computer-1", choiceVersion: 1 }),
      "active",
    );
    expect(projected.harness).toBe("codex-native");
    expect(projected.executionTarget).toBe("computer-1");
    expect(projected.choiceVersion).toBe(1);
  });

  it("marks runs predating the harness choice with explicit nulls", () => {
    const projected = runActivityFromRow(runRow(), "active");
    expect(projected.harness).toBeNull();
    expect(projected.executionTarget).toBeNull();
    expect(projected.choiceVersion).toBeNull();
  });
});

describe("run activity copy", () => {
  it("presents structured agent messages instead of their internal wake prompt", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] A message just arrived from another bot with internal routing data",
        sourceBlocks: [
          {
            kind: "bot_message_received",
            fromBotId: "maya",
            fromBotName: "Maya",
            text: "Please check the release workflow.",
            intent: "request",
          },
        ],
      }),
    ).toBe("Maya asked: Please check the release workflow.");
  });

  it("fails closed when an agent message has no valid structured source", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] private internal routing envelope",
        sourceBlocks: [{ kind: "text", text: "not a peer message" }],
      }),
    ).toBe("Message from another agent");
  });
});

describe("run activity notification preference", () => {
  it("silences only direct messages", () => {
    expect(activityNotificationsEnabled(null, false)).toBe(false);
    expect(activityNotificationsEnabled("group-1", false)).toBe(true);
  });
});

describe("run activity delegation provenance", () => {
  it("projects a delegated run with its work id and without a schema rejection", () => {
    for (const trigger of ["delegate", "delegate_followup"] as const) {
      const projected = runActivityFromRow(runRow({ trigger, scopedTaskId: "work-1" }), "active");
      expect(RunActivityRowSchema.parse(projected)).toMatchObject({
        trigger,
        workId: "work-1",
      });
    }
  });

  it("leaves an ordinary run with an explicit null work id", () => {
    const projected = runActivityFromRow(runRow(), "active");
    expect(RunActivityRowSchema.parse(projected).workId).toBeNull();
  });
});
