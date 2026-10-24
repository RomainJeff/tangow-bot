import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeWorkerProvider } from "./fake-worker-provider.js";
import { createJobReconciler } from "./job-reconciler.js";
import { composeWorkers, resolveWorkerProvider } from "./worker-composition.js";
import { privateFiles, workerFixture } from "./worker-fixture.test-support.js";

describe("the worker provider a deployment configures", () => {
  it.each([
    ["none", {}, null],
    [
      "E2B with its default template",
      { WORKER_PROVIDER: "e2b", E2B_API_KEY: "e2b-key" },
      { kind: "e2b", apiKey: "e2b-key", template: "rakazo-worker-pi-native" },
    ],
    [
      "E2B with a template of its own",
      { WORKER_PROVIDER: " e2b ", E2B_API_KEY: "e2b-key", WORKER_TEMPLATE: "pilot-worker" },
      { kind: "e2b", apiKey: "e2b-key", template: "pilot-worker" },
    ],
  ])("reads %s", (_name, env, expected) => {
    expect(resolveWorkerProvider(env)).toEqual(expected);
  });

  it.each([
    [{ WORKER_PROVIDER: "docker" }, "Unknown WORKER_PROVIDER: docker"],
    [{ WORKER_PROVIDER: "e2b" }, "WORKER_PROVIDER=e2b needs E2B_API_KEY"],
  ])("refuses %o", (env, message) => {
    expect(() => resolveWorkerProvider(env)).toThrow(message);
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

  it("releases a worker whose destruction was not confirmed, and frees its volume", async () => {
    const fixture = workerFixture(prisma);
    await fixture.seedOwner();
    const provider = Object.assign(new FakeWorkerProvider(), {
      connect: () => {
        throw new Error("No guest in this test");
      },
    });
    const workers = composeWorkers(prisma, provider);
    const { bot, privateVolume } = await fixture.migratedBot();
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
    expect(await fixture.writerOf(privateVolume.id)).toBeNull();
  });
});
