import type {
  AdapterContext,
  BackgroundJob,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sleepBotScreenIfIdle } from "./computer-idle.js";
import { releaseBotScreen } from "./computer-lifecycle.js";

const ref: ComputerRef = {
  id: "provider-1",
  botId: "team-home",
  kind: "fake",
  providerRef: "provider-1",
};
const context: AdapterContext = {
  operationId: "run-1",
  traceId: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  screenLeaseId: "run-1:1",
  signal: new AbortController().signal,
};
const idleJob = {
  name: "computer.screen-sleep",
  payload: { computerId: "computer-1", botId: "bot-1", screenLeaseId: "run-1:1" },
  availableAt: new Date("2026-10-31T12:10:00.000Z"),
  replaceKey: "computer.screen-sleep:computer-1:bot-1",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-31T12:00:00.000Z"));
  vi.stubEnv("SANDBOX_IDLE_MS", "600000");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function world(
  options: {
    release?: "kept" | undefined | Error;
    computer?: Record<string, unknown>;
    runs?: (statuses: string[]) => boolean;
  } = {},
) {
  const botGeneration = { value: 4 };
  const queued: BackgroundJob[] = [];
  const appended: unknown[] = [];
  const releases: Array<{ botId?: string; screenLeaseId?: string; release?: string }> = [];
  const prisma = {
    bot: {
      findUnique: async () => ({ computerId: "computer-1" }),
      update: async () => {
        botGeneration.value += 1;
        return { spaceId: "space-1", thread: { id: "thread-1" }, computer: { state: "running" } };
      },
    },
    computer: {
      findUnique: async () => ({
        id: "computer-1",
        homeKey: "team-home",
        providerRef: "provider-1",
        kind: "fake",
        state: "running",
        spaceId: "space-1",
        userId: "user-1",
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        ...options.computer,
      }),
    },
    run: {
      findFirst: async ({ where }: { where: { status: { in: string[] } } }) =>
        options.runs?.(where.status.in) ? { id: "run-2" } : null,
    },
  } as unknown as PrismaClient;
  const sandbox = {
    releaseScreen: async (_: ComputerRef, ctx: AdapterContext, release?: string) => {
      releases.push({ botId: ctx.botId, screenLeaseId: ctx.screenLeaseId, release });
      if (options.release instanceof Error) throw options.release;
      return options.release;
    },
  } as unknown as SandboxProvider;
  const jobs = { enqueue: async (job: BackgroundJob) => void queued.push(job) } as JobPublisher;
  const events = {
    append: async (input: unknown) => void appended.push(input),
  } as unknown as ThreadEvents;
  return { botGeneration, queued, appended, releases, deps: { prisma, sandbox, jobs, events } };
}

describe("releaseBotScreen after a run", () => {
  it("keeps the screen's generation and viewers, and schedules its idle release", async () => {
    const { botGeneration, queued, appended, releases, deps } = world({ release: "kept" });

    await expect(releaseBotScreen(deps, ref, context, "keep")).resolves.toBe(true);

    expect(releases).toEqual([{ botId: "bot-1", screenLeaseId: "run-1:1", release: "keep" }]);
    expect(botGeneration.value).toBe(4);
    expect(appended).toEqual([]);
    expect(queued).toEqual([idleJob]);
  });

  it("moves the generation on when the provider tore the screen down despite the request", async () => {
    const { botGeneration, queued, appended, deps } = world({ release: undefined });

    await releaseBotScreen(deps, ref, context, "keep");

    expect(botGeneration.value).toBe(5);
    expect(appended).toEqual([
      {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        type: "computer.status",
        payload: { status: "running" },
      },
    ]);
    expect(queued).toEqual([]);
  });

  it("tears down by default, moving the generation on and scheduling nothing", async () => {
    const { botGeneration, queued, releases, deps } = world({ release: undefined });

    await releaseBotScreen(deps, ref, context);

    expect(releases).toEqual([{ botId: "bot-1", screenLeaseId: "run-1:1", release: undefined }]);
    expect(botGeneration.value).toBe(5);
    expect(queued).toEqual([]);
  });
});

describe("sleepBotScreenIfIdle", () => {
  const payload = idleJob.payload;

  it("tears the screen down under the lease it was kept with once nothing needs it", async () => {
    const { botGeneration, queued, releases, deps } = world();

    await sleepBotScreenIfIdle(deps, payload);

    expect(releases).toEqual([{ botId: "bot-1", screenLeaseId: "run-1:1", release: undefined }]);
    expect(botGeneration.value).toBe(5);
    expect(queued).toEqual([]);
  });

  it.each(["queued", "leased", "running", "waiting_takeover"])(
    "waits while the bot has a %s run",
    async (status) => {
      const { queued, releases, deps } = world({ runs: (statuses) => statuses.includes(status) });

      await sleepBotScreenIfIdle(deps, payload);

      expect(releases).toEqual([]);
      expect(queued).toEqual([idleJob]);
    },
  );

  it("does not hold the screen for a run that waits for an answer", async () => {
    const { releases, deps } = world({ runs: (statuses) => statuses.includes("waiting_input") });

    await sleepBotScreenIfIdle(deps, payload);

    expect(releases).toHaveLength(1);
  });

  it("waits while a person holds control of the screen as this bot", async () => {
    const { queued, releases, deps } = world({
      computer: {
        controlHolder: "user",
        controlLeaseId: "control-1",
        controlLeaseExpiresAt: new Date("2026-10-31T12:05:00.000Z"),
        controlBotId: "bot-1",
      },
    });

    await sleepBotScreenIfIdle(deps, payload);

    expect(releases).toEqual([]);
    expect(queued).toEqual([idleJob]);
  });

  it("tries again later when the provider could not release the screen", async () => {
    const { botGeneration, queued, deps } = world({ release: new Error("supervisor down") });

    await sleepBotScreenIfIdle(deps, payload);

    expect(botGeneration.value).toBe(4);
    expect(queued).toEqual([idleJob]);
  });

  it("leaves a computer that is no longer running to its own shutdown", async () => {
    const { queued, releases, deps } = world({ computer: { state: "suspended" } });

    await sleepBotScreenIfIdle(deps, payload);

    expect(releases).toEqual([]);
    expect(queued).toEqual([]);
  });
});
