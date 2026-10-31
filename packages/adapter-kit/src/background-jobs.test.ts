import { describe, expect, it, vi } from "vitest";
import {
  computerScreenSleepJob,
  dispatchBackgroundJob,
  historyCompactJob,
  historyCompactJobKey,
  messagingDeliverJob,
  parseBackgroundJob,
} from "./background-jobs.js";
import type { BackgroundJobHandlers } from "./types.js";

function handlers(): BackgroundJobHandlers {
  return {
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.screen-sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "link.preview": vi.fn(async () => undefined),
  };
}

describe("background job contracts", () => {
  it("validates and dispatches messaging.deliver", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "messaging.deliver", { runId: "run-1" });
    expect(target["messaging.deliver"]).toHaveBeenCalledWith({ runId: "run-1" });
    expect(messagingDeliverJob("run-1")).toEqual({
      name: "messaging.deliver",
      payload: { runId: "run-1" },
      replaceKey: "messaging.deliver:run-1",
    });
    expect(messagingDeliverJob()).toEqual({
      name: "messaging.deliver",
      payload: {},
      replaceKey: "messaging.deliver:drain",
    });
  });

  it("validates and dispatches a typed job", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "routine.wakeup", {
      routineId: "routine-1",
      scheduledFor: "2026-08-15T12:00:00.000Z",
    });
    expect(target["routine.wakeup"]).toHaveBeenCalledWith({
      routineId: "routine-1",
      scheduledFor: "2026-08-15T12:00:00.000Z",
    });
  });

  it("validates link.preview: identifiers only, one or the other", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "link.preview", { messageId: "message-1" });
    await dispatchBackgroundJob(target, "link.preview", { runId: "run-1" });
    expect(target["link.preview"]).toHaveBeenNthCalledWith(1, { messageId: "message-1" });
    expect(target["link.preview"]).toHaveBeenNthCalledWith(2, { runId: "run-1" });
    // A URL, text or any extra field is refused: the link is recomputed from the database.
    for (const payload of [
      {},
      { messageId: "" },
      { messageId: "m", url: "https://example.test/" },
      { runId: "r", messageId: "m" },
      { url: "https://example.test/" },
    ]) {
      expect(() => parseBackgroundJob("link.preview", payload)).toThrow();
    }
  });

  it("rejects unknown names and malformed deliveries", () => {
    expect(() => parseBackgroundJob("unknown", {})).toThrow("Unknown background job");
    expect(() =>
      parseBackgroundJob("routine.wakeup", {
        routineId: "routine-1",
        scheduledFor: "not-a-date",
      }),
    ).toThrow();
    expect(() => parseBackgroundJob("run.continue", { runId: "" })).toThrow();
    expect(() =>
      parseBackgroundJob("computer.control-expire", {
        computerId: "computer-1",
        leaseId: "",
      }),
    ).toThrow();
  });

  it("validates and dispatches a control-expiry job", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "computer.control-expire", {
      computerId: "computer-1",
      leaseId: "lease-1",
    });
    expect(target["computer.control-expire"]).toHaveBeenCalledWith({
      computerId: "computer-1",
      leaseId: "lease-1",
    });
  });
});

describe("historyCompactJob", () => {
  it("builds a job with a replace key scoped to the thread", () => {
    expect(historyCompactJob("thread-1")).toEqual({
      name: "history.compact",
      payload: { threadId: "thread-1" },
      replaceKey: historyCompactJobKey("thread-1"),
    });
  });

  it("carries the run's history budget to the job, and still takes a job queued without one", async () => {
    const target = handlers();

    await dispatchBackgroundJob(
      target,
      "history.compact",
      historyCompactJob("thread-1", 20_000).payload,
    );
    await dispatchBackgroundJob(target, "history.compact", { threadId: "thread-2" });

    expect(vi.mocked(target["history.compact"]).mock.calls).toEqual([
      [{ threadId: "thread-1", historyBudget: 20_000 }],
      [{ threadId: "thread-2" }],
    ]);
  });

  it("keys different threads differently", () => {
    expect(historyCompactJobKey("thread-1")).not.toBe(historyCompactJobKey("thread-2"));
  });
});

describe("computerScreenSleepJob", () => {
  const availableAt = new Date("2026-10-31T12:10:00.000Z");
  const screen = { computerId: "computer-1", botId: "bot-1", screenLeaseId: "run-1:1" };

  it("keys the job by the lease the screen was kept under", () => {
    expect(computerScreenSleepJob(screen, availableAt)).toEqual({
      name: "computer.screen-sleep",
      payload: screen,
      availableAt,
      replaceKey: "computer.screen-sleep:computer-1:bot-1:run-1:1",
    });
  });

  it("never lets a job for one lease replace the job for another", () => {
    const next = computerScreenSleepJob({ ...screen, screenLeaseId: "run-2:1" }, availableAt);

    expect(next.replaceKey).toBe("computer.screen-sleep:computer-1:bot-1:run-2:1");
  });
});
