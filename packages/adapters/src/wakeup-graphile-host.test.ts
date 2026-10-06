import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import type { Runner } from "graphile-worker";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());

vi.mock("graphile-worker", () => ({
  run: (...args: unknown[]) => run(...args),
  makeWorkerUtils: vi.fn(),
}));

import {
  ISOLATED_JOB_NAMES,
  LINK_PREVIEW_JOB_CONCURRENCY,
  linkPreviewJob,
} from "@rakazo/adapter-kit";
import { makeWorkerUtils } from "graphile-worker";
import {
  databaseCapacityBackoffMs,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
} from "./wakeup.js";

function handlers(): BackgroundJobHandlers {
  return {
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "link.preview": vi.fn(async () => undefined),
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mockRunner() {
  const life = deferred();
  // Keep a rejection handler so Node does not treat the mock lifecycle as an
  // unexpected unhandledRejection before the host attaches supervise().
  life.promise.catch(() => undefined);
  const runner = {
    promise: life.promise,
    stop: vi.fn(async () => {
      life.resolve();
    }),
    kill: vi.fn(async () => undefined),
    addJob: vi.fn(),
    events: { on: vi.fn(), off: vi.fn(), once: vi.fn(), emit: vi.fn() },
  } as unknown as Runner;
  return {
    runner,
    rejectLife: (error: unknown) => life.reject(error),
  };
}

const tooMany = Object.assign(new Error("sorry, too many clients already"), { code: "53300" });

describe("databaseCapacityBackoffMs", () => {
  it("matches the worker startup backoff curve", () => {
    expect(databaseCapacityBackoffMs(0)).toBe(200);
    expect(databaseCapacityBackoffMs(3)).toBe(1_600);
    expect(databaseCapacityBackoffMs(8)).toBe(30_000);
    expect(databaseCapacityBackoffMs(20)).toBe(30_000);
  });
});

describe("GraphileJobWorkerHost runner lifecycle", () => {
  afterEach(() => {
    run.mockReset();
  });

  it("backs off then restarts when runner.promise rejects with 53300", async () => {
    const first = mockRunner();
    const second = mockRunner();
    run.mockResolvedValueOnce(first.runner).mockResolvedValueOnce(second.runner);
    const sleeps: number[] = [];
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await host.start(handlers());
    expect(run).toHaveBeenCalledTimes(1);

    first.rejectLife(tooMany);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(sleeps).toEqual([200]);

    await host.stop();
    expect(second.runner.stop).toHaveBeenCalled();
  });

  it("retries launch with escalating backoff when restart start hits 53300", async () => {
    const first = mockRunner();
    const recovered = mockRunner();
    run
      .mockResolvedValueOnce(first.runner)
      .mockRejectedValueOnce(tooMany)
      .mockResolvedValueOnce(recovered.runner);
    const sleeps: number[] = [];
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await host.start(handlers());
    first.rejectLife(tooMany);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect(sleeps).toEqual([200, 400]);

    await host.stop();
    expect(recovered.runner.stop).toHaveBeenCalled();
  });

  it("does not restart when runner.promise rejects for a non-53300 error", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async () => undefined,
    });
    await host.start(handlers());
    const superviseTask = (host as unknown as { superviseTask: Promise<void> }).superviseTask;

    first.rejectLife(new Error("runner exploded"));
    await expect(superviseTask).rejects.toThrow("runner exploded");
    expect(run).toHaveBeenCalledTimes(1);

    await host.stop();
  });

  it("wakes a pending restart delay when stop is called", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner);
    const sleepStarted = deferred();
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: () => {
        sleepStarted.resolve();
        return new Promise(() => undefined);
      },
    });
    await host.start(handlers());
    first.rejectLife(tooMany);
    await sleepStarted.promise;

    await host.stop();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("link.preview isolation (CA 36, CA 37)", () => {
  afterEach(() => {
    run.mockReset();
  });

  it("keeps link.preview out of the run workers' slots and gives it a runner of its own", async () => {
    const main = mockRunner();
    const previews = mockRunner();
    run.mockResolvedValueOnce(main.runner).mockResolvedValueOnce(previews.runner);
    const runHost = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 4,
      except: ISOLATED_JOB_NAMES,
    });
    const previewHost = new GraphileJobWorkerHost({} as Pool, {
      concurrency: LINK_PREVIEW_JOB_CONCURRENCY,
      only: ISOLATED_JOB_NAMES,
      noHandleSignals: true,
    });

    await runHost.start(handlers());
    await previewHost.start(handlers());

    const [mainOptions, previewOptions] = run.mock.calls.map(([options]) => options);
    // Run workers: everything but link.preview, with the usual four slots.
    expect(Object.keys(mainOptions.taskList)).toContain("run.continue");
    expect(Object.keys(mainOptions.taskList)).not.toContain("link.preview");
    expect(mainOptions.concurrency).toBe(4);
    // Previews: only themselves, two at a time, so ten slow sites can never reach a run.
    expect(Object.keys(previewOptions.taskList)).toEqual(["link.preview"]);
    expect(previewOptions.concurrency).toBe(2);
    expect(previewOptions.noHandleSignals).toBe(true);

    await runHost.stop();
    await previewHost.stop();
  });

  it("hands a link.preview job to its handler with the identifiers it was queued with", async () => {
    const preview = mockRunner();
    run.mockResolvedValueOnce(preview.runner);
    const target = handlers();
    const host = new GraphileJobWorkerHost({} as Pool, { only: ISOLATED_JOB_NAMES });
    await host.start(target);

    const { taskList } = run.mock.calls[0]![0];
    await taskList["link.preview"]({ messageId: "message-1" });

    expect(target["link.preview"]).toHaveBeenCalledWith({ messageId: "message-1" });
    await host.stop();
  });
});

describe("link.preview job definition", () => {
  it("is queued once, behind everything else, and never retried", () => {
    expect(linkPreviewJob({ messageId: "message-1" })).toEqual({
      name: "link.preview",
      payload: { messageId: "message-1" },
      replaceKey: "link.preview:message:message-1",
      priority: 10,
      maxAttempts: 1,
    });
    expect(linkPreviewJob({ runId: "run-1" })).toMatchObject({
      replaceKey: "link.preview:run:run-1",
      priority: 10,
      maxAttempts: 1,
    });
  });

  it("passes priority and maxAttempts to the queue", async () => {
    const addJob = vi.fn(async () => undefined);
    vi.mocked(makeWorkerUtils).mockResolvedValue({ addJob, release: vi.fn() } as never);
    const publisher = new GraphileJobPublisher({} as Pool);

    await publisher.enqueue(linkPreviewJob({ runId: "run-1" }));

    expect(addJob).toHaveBeenCalledWith(
      "link.preview",
      expect.anything(),
      expect.objectContaining({ jobKey: "link.preview:run:run-1", priority: 10, maxAttempts: 1 }),
    );
  });
});
