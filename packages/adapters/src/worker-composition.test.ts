import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeWorkerProvider } from "./fake-worker-provider.js";
import { createJobReconciler } from "./job-reconciler.js";
import { composeWorkers, resolveWorkerProvider } from "./worker-composition.js";
import { privateFiles, workerFixture } from "./worker-fixture.test-support.js";

describe("the worker provider a deployment runs", () => {
  it.each([
    [
      "E2B workers with the default template on an E2B deployment",
      { SANDBOX_PROVIDER: "e2b", E2B_API_KEY: "e2b-key" },
      { kind: "e2b", apiKey: "e2b-key", template: "rakazo-worker-pi-native" },
    ],
    [
      "E2B workers with a template of its own",
      { SANDBOX_PROVIDER: "e2b", E2B_API_KEY: "e2b-key", WORKER_TEMPLATE: " own-worker " },
      { kind: "e2b", apiKey: "e2b-key", template: "own-worker" },
    ],
    [
      "Docker workers on the supervisor and DATA_DIR of a Docker deployment",
      {
        SANDBOX_PROVIDER: "docker",
        SANDBOX_SUPERVISOR_URL: "http://supervisor:7091",
        SANDBOX_SUPERVISOR_TOKEN: "supervisor-token-of-at-least-32-chars",
        DATA_DIR: "/data",
      },
      {
        kind: "docker",
        supervisorUrl: "http://supervisor:7091",
        supervisorToken: "supervisor-token-of-at-least-32-chars",
        dataDir: "/data",
      },
    ],
  ])("resolves %s", (_name, env, expected) => {
    expect(resolveWorkerProvider(env)).toEqual(expected);
  });
});

describe("the reconciler of a deployment with workers", () => {
  let database: PgliteDatabase;
  let prisma: PrismaClient;
  beforeAll(async () => {
    database = await openPgliteDatabase();
    prisma = database.prisma;
  });
  afterAll(() => database.close());

  it("destroys a worker whose prior release was not confirmed", async () => {
    const fixture = workerFixture(prisma);
    await fixture.seedOwner();
    const provider = Object.assign(new FakeWorkerProvider(), {
      connect: () => {
        throw new Error("No guest in this test");
      },
    });
    const workers = composeWorkers(prisma, provider);
    const { bot } = await fixture.migratedBot();
    const run = await fixture.seedRun(bot);
    const attempt = await fixture.seedAttempt(run.id);
    await workers.lifecycle.start(
      await fixture.launchFor(workers.lifecycle, attempt.id, privateFiles),
      fixture.context,
    );
    provider.failDestroy = new Error("The provider cannot confirm");
    await expect(workers.lifecycle.release(attempt.id, fixture.context)).rejects.toThrow();
    provider.failDestroy = null;
    const jobs: JobPublisher = {
      enqueue: async () => undefined,
      cancel: async () => undefined,
      close: async () => undefined,
    };

    await createJobReconciler({
      prisma,
      jobs,
      reconcileWorkers: workers.reconcileWorkers,
    }).reconcileOnce();

    expect(await fixture.workerStateOf(attempt.id)).toBe("released");
    expect(provider.live.size).toBe(0);
  });
});
