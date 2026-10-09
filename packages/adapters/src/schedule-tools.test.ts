import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import {
  cancelScheduleFromTool,
  createScheduleFromTool,
  filterBuiltinToolsForRun,
  filterBuiltinToolsForThread,
  isOneShotRoutineCron,
  listSchedulesFromTool,
  resolveScheduleTiming,
  SCHEDULE_TOOL_NAMES,
  updateRoutine,
} from "./schedule-tools.js";

describe("resolveScheduleTiming", () => {
  it("rejects repeating intervals under one minute", () => {
    expect(resolveScheduleTiming({ every: 2, unit: "seconds" })).toEqual({
      ok: false,
      error: "minimum interval is 1 minute",
    });
  });

  it("accepts every 1 minute", () => {
    const result = resolveScheduleTiming({ every: 1, unit: "minutes" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe("*/1 * * * *");
    expect(result.oneShot).toBe(false);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("accepts cron every minute", () => {
    const result = resolveScheduleTiming({ cron: "*/1 * * * *" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe("*/1 * * * *");
    expect(result.oneShot).toBe(false);
  });

  it("creates one-shot schedules with @once cron", () => {
    const result = resolveScheduleTiming({ delayMinutes: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe(ONCE_ROUTINE_CRON);
    expect(result.oneShot).toBe(true);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it("allows sub-minute one-shot delays via delaySeconds", () => {
    const result = resolveScheduleTiming({ delaySeconds: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe(ONCE_ROUTINE_CRON);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it("rejects one-shot schedules in the past", () => {
    expect(resolveScheduleTiming({ runAt: new Date(Date.now() - 60_000).toISOString() })).toEqual({
      ok: false,
      error: "One-shot schedules must run in the future.",
    });
  });

  it("rejects one-shot schedules more than 5 years ahead", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T10:00:00Z"));
    try {
      expect(resolveScheduleTiming({ runAt: "2031-10-08T10:00:00Z" })).toMatchObject({
        ok: true,
        nextRunAt: new Date("2031-10-08T10:00:00Z"),
      });
      expect(resolveScheduleTiming({ runAt: "2031-10-09T10:00:00Z" })).toEqual({
        ok: false,
        error: "One-shot schedules must run within 5 years.",
      });
      expect(resolveScheduleTiming({ delayMinutes: 1e9 })).toEqual({
        ok: false,
        error: "One-shot schedules must run within 5 years.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects fractional repeat intervals", () => {
    expect(resolveScheduleTiming({ every: 1.5, unit: "minutes" })).toEqual({
      ok: false,
      error: "every must be a positive whole number.",
    });
  });

  it("rejects malformed cron expressions", () => {
    expect(resolveScheduleTiming({ cron: "*/5 *" })).toEqual({
      ok: false,
      error: "cron must be a 5-field cron expression.",
    });
    expect(resolveScheduleTiming({ cron: "foo * * * *" })).toEqual({
      ok: false,
      error: "cron must be a valid 5-field cron expression.",
    });
  });

  it("rejects mixing repeat and one-shot fields", () => {
    expect(resolveScheduleTiming({ cron: "0 9 * * *", delayMinutes: 5 })).toEqual({
      ok: false,
      error: "Provide either a repeating schedule or a one-shot time, not both.",
    });
  });
});

describe("filterBuiltinToolsForThread", () => {
  const tools = [
    { name: "handoff_to_bot" },
    { name: "message_bot" },
    { name: "schedule_create" },
    { name: "schedule_list" },
    { name: "schedule_cancel" },
    { name: "remember" },
  ];

  it("keeps handoff and schedule tools in groups", () => {
    expect(filterBuiltinToolsForThread(tools, "group-1").map((tool) => tool.name)).toEqual([
      "handoff_to_bot",
      "schedule_create",
      "schedule_list",
      "schedule_cancel",
      "remember",
    ]);
    expect(filterBuiltinToolsForThread(tools, null).map((tool) => tool.name)).toEqual([
      "message_bot",
      "schedule_create",
      "schedule_list",
      "schedule_cancel",
      "remember",
    ]);
  });

  it("hides schedule creation from routine runs without removing schedule management", () => {
    expect(filterBuiltinToolsForRun(tools, "routine").map((tool) => tool.name)).toEqual([
      "handoff_to_bot",
      "message_bot",
      "schedule_list",
      "schedule_cancel",
      "remember",
    ]);
    expect(filterBuiltinToolsForRun(tools, "user").map((tool) => tool.name)).toContain(
      "schedule_create",
    );
  });

  it("composes thread then run filters without dropping group schedule tools", () => {
    const groupTools = filterBuiltinToolsForRun(
      filterBuiltinToolsForThread(tools, "group-1"),
      "routine",
    ).map((tool) => tool.name);
    expect(groupTools).toEqual(["handoff_to_bot", "schedule_list", "schedule_cancel", "remember"]);
    expect(
      filterBuiltinToolsForRun(filterBuiltinToolsForThread(tools, "group-1"), "user").map(
        (tool) => tool.name,
      ),
    ).toContain("schedule_create");
  });

  it("covers every schedule tool name", () => {
    for (const name of SCHEDULE_TOOL_NAMES) {
      expect(filterBuiltinToolsForThread([{ name }, { name: "remember" }], "group-1")).toEqual([
        { name },
        { name: "remember" },
      ]);
    }
  });
});

describe("isOneShotRoutineCron", () => {
  it("detects the one-shot sentinel", () => {
    expect(isOneShotRoutineCron(ONCE_ROUTINE_CRON)).toBe(true);
    expect(isOneShotRoutineCron("0 9 * * *")).toBe(false);
  });
});

describe("schedule tool persistence", () => {
  it("creates routines with routine.created and enqueues wakeup", async () => {
    const append = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "routine-1",
      ...args.data,
      nextRunAt: args.data.nextRunAt,
    }));
    const deps = {
      prisma: { routine: { create } },
      events: { append },
      jobs: { enqueue, cancel: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toMatchObject({ ok: true, routineId: "routine-1", cron: "*/1 * * * *" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spaceId: "ws-1",
          userId: "user-1",
          threadId: "thread-1",
          crons: ["*/1 * * * *"],
          active: true,
        }),
      }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.created", payload: { name: "Morning joke" } }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  describe("bot-to-bot chain hop", () => {
    function scheduleDeps() {
      const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: "routine-1",
        ...args.data,
        crons: ["*/1 * * * *"],
      }));
      const enqueue = vi.fn(async () => undefined);
      const deps = {
        prisma: { routine: { create } },
        events: { append: vi.fn(async () => undefined) },
        jobs: { enqueue, cancel: vi.fn(async () => undefined) },
      } as unknown as Parameters<typeof createScheduleFromTool>[0];
      return { deps, create, enqueue };
    }
    const input = {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    };

    it("stores one hop more than the run that creates the routine", async () => {
      const { deps, create } = scheduleDeps();
      const result = await createScheduleFromTool(deps, { ...input, currentHop: 4 });
      expect(result).toMatchObject({ ok: true });
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({ inheritedHop: 5 }),
      });
    });

    it("refuses when the routine would sit past the chain limit", async () => {
      const { deps, create, enqueue } = scheduleDeps();
      const result = await createScheduleFromTool(deps, { ...input, currentHop: 6 });
      expect(result).toEqual({
        error: "bot-to-bot chain limit reached; ask the user to set up this routine",
      });
      expect(create).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it("leaves inheritedHop null for a run a person started", async () => {
      const { deps, create } = scheduleDeps();
      await createScheduleFromTool(deps, { ...input, currentHop: 0 });
      await createScheduleFromTool(deps, input);
      expect(create).toHaveBeenCalledTimes(2);
      for (const [args] of create.mock.calls) {
        expect(args.data.inheritedHop).toBeNull();
      }
    });
  });

  it("keeps the routine when event append fails after enqueue", async () => {
    const cancel = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const deps = {
      prisma: {
        routine: {
          create: vi.fn(async () => ({
            id: "routine-1",
            name: "Morning joke",
            crons: ["*/1 * * * *"],
            nextRunAt: new Date(),
          })),
          delete: remove,
        },
      },
      events: {
        append: vi.fn(async () => {
          throw new Error("event failed");
        }),
      },
      jobs: { enqueue: vi.fn(async () => undefined), cancel },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toMatchObject({ ok: true, routineId: "routine-1" });
    expect(cancel).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("rolls back routine when enqueue fails", async () => {
    const remove = vi.fn(async () => undefined);
    const deps = {
      prisma: {
        routine: {
          create: vi.fn(async () => ({
            id: "routine-1",
            name: "Morning joke",
            crons: ["*/1 * * * *"],
            nextRunAt: new Date(),
          })),
          delete: remove,
        },
      },
      events: { append: vi.fn(async () => undefined) },
      jobs: {
        enqueue: vi.fn(async () => {
          throw new Error("enqueue failed");
        }),
        cancel: vi.fn(async () => undefined),
      },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toEqual({ error: "Could not schedule the reminder. Try again." });
    expect(remove).toHaveBeenCalledWith({ where: { id: "routine-1" } });
  });

  it("deactivates when enqueue fails and delete also fails", async () => {
    const update = vi.fn(async () => undefined);
    const deps = {
      prisma: {
        routine: {
          create: vi.fn(async () => ({
            id: "routine-1",
            name: "Morning joke",
            crons: ["*/1 * * * *"],
            nextRunAt: new Date(),
          })),
          delete: vi.fn(async () => {
            throw new Error("delete failed");
          }),
          update,
        },
      },
      events: { append: vi.fn(async () => undefined) },
      jobs: {
        enqueue: vi.fn(async () => {
          throw new Error("enqueue failed");
        }),
        cancel: vi.fn(async () => undefined),
      },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toEqual({ error: "Could not schedule the reminder. Try again." });
    expect(update).toHaveBeenCalledWith({
      where: { id: "routine-1" },
      data: { active: false, nextRunAt: null },
    });
  });

  it("propagates when enqueue rollback cannot deactivate", async () => {
    const deps = {
      prisma: {
        routine: {
          create: vi.fn(async () => ({
            id: "routine-1",
            name: "Morning joke",
            crons: ["*/1 * * * *"],
            nextRunAt: new Date(),
          })),
          delete: vi.fn(async () => {
            throw new Error("delete failed");
          }),
          update: vi.fn(async () => {
            throw new Error("deactivate failed");
          }),
        },
      },
      events: { append: vi.fn(async () => undefined) },
      jobs: {
        enqueue: vi.fn(async () => {
          throw new Error("enqueue failed");
        }),
        cancel: vi.fn(async () => undefined),
      },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    await expect(
      createScheduleFromTool(deps, {
        spaceId: "ws-1",
        botId: "bot-1",
        userId: "user-1",
        threadId: "thread-1",
        name: "Morning joke",
        prompt: "Tell a joke",
        schedule: { every: 1, unit: "minutes" },
      }),
    ).rejects.toThrow("deactivate failed");
  });

  it("scopes group list and cancel to the current thread without narrowing DMs", async () => {
    const findMany = vi.fn(async () => []);
    const findFirst = vi.fn(async () => null);
    const deps = {
      prisma: {
        routine: { findMany, findFirst, delete: vi.fn(async () => undefined) },
      },
      events: { append: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof cancelScheduleFromTool>[0];

    await listSchedulesFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "group-thread-1",
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          threadId: "group-thread-1",
        },
      }),
    );

    const cancelled = await cancelScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "group-thread-1",
      routineId: "routine-1",
    });
    expect(cancelled).toEqual({ error: "Schedule not found." });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          threadId: "group-thread-1",
          id: "routine-1",
        },
      }),
    );

    findMany.mockClear();
    await listSchedulesFromTool(deps, { spaceId: "ws-1", botId: "bot-1", userId: "user-1" });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "ws-1", botId: "bot-1", userId: "user-1" },
      }),
    );

    findFirst.mockClear();
    await cancelScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      routineId: "routine-1",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "ws-1", botId: "bot-1", userId: "user-1", id: "routine-1" },
      }),
    );
  });
});

describe("changing a routine", () => {
  it("queues its wake-up when a retry finds the new time already stored", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
    try {
      const stored = {
        id: "routine-1",
        name: "Stretch",
        prompt: "Remind me to stretch",
        notify: false,
        timezone: "UTC",
        crons: ["0 * * * *"],
        active: true,
        webhookEnabled: false,
        githubEnabled: false,
        messageProvider: null,
        lastRunAt: null,
        nextRunAt: new Date("2026-10-07T11:00:00Z"),
      };
      const queued: unknown[] = [];
      let queueDown = true;
      const deps = {
        prisma: {
          routine: {
            update: async ({ data }: { data: Record<string, unknown> }) =>
              Object.assign(
                stored,
                Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
              ),
          },
        },
        events: { append: async () => undefined },
        jobs: {
          enqueue: async (job: unknown) => {
            if (queueDown) {
              queueDown = false;
              throw new Error("queue down");
            }
            queued.push(job);
          },
          cancel: async () => undefined,
        },
      } as unknown as Parameters<typeof updateRoutine>[0];
      const signal = { spaceId: "ws-1", botId: "bot-1", threadId: null };

      await expect(
        updateRoutine(deps, { ...stored }, { crons: ["0 9 * * *"] }, signal),
      ).rejects.toThrow("queue down");
      await updateRoutine(deps, { ...stored }, { crons: ["0 9 * * *"] }, signal);

      expect(queued).toEqual([
        {
          name: "routine.wakeup",
          payload: { routineId: "routine-1", scheduledFor: "2026-10-08T09:00:00.000Z" },
          availableAt: new Date("2026-10-08T09:00:00Z"),
          replaceKey: "routine:routine-1",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the next run a wake-up claimed while a rename was in flight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T11:00:01Z"));
    try {
      const stored = {
        id: "routine-1",
        name: "Stretch",
        prompt: "Remind me to stretch",
        notify: false,
        timezone: "UTC",
        crons: ["0 * * * *"],
        active: true,
        webhookEnabled: false,
        githubEnabled: false,
        messageProvider: null,
        lastRunAt: null as Date | null,
        nextRunAt: new Date("2026-10-07T11:00:00Z") as Date | null,
      };
      const readByRename = { ...stored };
      stored.lastRunAt = new Date("2026-10-07T11:00:01Z");
      stored.nextRunAt = new Date("2026-10-07T12:00:00Z");
      const queued: unknown[] = [];
      const deps = {
        prisma: {
          routine: {
            update: async ({ data }: { data: Record<string, unknown> }) =>
              Object.assign(
                stored,
                Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
              ),
          },
        },
        events: { append: async () => undefined },
        jobs: {
          enqueue: async (job: unknown) => {
            queued.push(job);
          },
          cancel: async () => undefined,
        },
      } as unknown as Parameters<typeof updateRoutine>[0];

      await updateRoutine(
        deps,
        readByRename,
        { name: "Stretch more" },
        {
          spaceId: "ws-1",
          botId: "bot-1",
          threadId: null,
        },
      );

      expect(stored.nextRunAt).toEqual(new Date("2026-10-07T12:00:00Z"));
      expect(queued).toEqual([
        {
          name: "routine.wakeup",
          payload: { routineId: "routine-1", scheduledFor: "2026-10-07T12:00:00.000Z" },
          availableAt: new Date("2026-10-07T12:00:00Z"),
          replaceKey: "routine:routine-1",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
