import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeWorkerProvider } from "./fake-worker-provider.js";
import { allFiles, mcpOnly, privateFiles, workerFixture } from "./worker-fixture.test-support.js";
import { createWorkerLifecycle, StaleAttemptError, VolumeBusyError } from "./worker-lifecycle.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;
const ROUNDS = 10;

describePostgres("worker lifecycle under concurrent transactions (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let fixture: ReturnType<typeof workerFixture>;

  beforeAll(async () => {
    ({ prisma, pool } = createDb(databaseUrl!, { poolMax: 8 }));
    fixture = workerFixture(prisma);
    await fixture.seedOwner();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  it("starts a worker only for the attempt holding the run's fence", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const fake = new FakeWorkerProvider();
      const workers = createWorkerLifecycle({ prisma, provider: fake });
      const { bot } = await fixture.migratedBot();
      const run = await fixture.seedRun(bot, { leaseFence: 2 });
      const stale = await fixture.seedAttempt(run.id, 1);
      const current = await fixture.seedAttempt(run.id, 2);
      const launch = await fixture.launchFor(workers, current.id, mcpOnly);

      const [staleStart, currentStart] = await Promise.allSettled([
        workers.start({ ...launch, attemptId: stale.id, fence: 1 }, fixture.context),
        workers.start(launch, fixture.context),
      ]);

      expect(staleStart).toMatchObject({
        status: "rejected",
        reason: expect.any(StaleAttemptError),
      });
      expect(currentStart.status).toBe("fulfilled");
      expect(
        fake.calls.filter((call) => call.op === "ensure").map((call) => call.spec.attemptId),
      ).toEqual([current.id]);
      expect(
        await prisma.attempt.count({
          where: { runId: run.id, workerState: { in: ["requested", "created", "ready"] } },
        }),
      ).toBe(1);
    }
  });

  it("lets one of two runs racing for the same volumes write, whatever their grant order", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const fake = new FakeWorkerProvider();
      const workers = createWorkerLifecycle({ prisma, provider: fake });
      const { bot, privateVolume, sharedVolume } = await fixture.migratedBot();
      const first = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
      const second = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
      const firstLaunch = await fixture.launchFor(workers, first.id, allFiles);
      const secondLaunch = await fixture.launchFor(workers, second.id, allFiles);

      const results = await Promise.allSettled([
        workers.start(firstLaunch, fixture.context),
        workers.start(
          { ...secondLaunch, volumes: [...secondLaunch.volumes].reverse() },
          fixture.context,
        ),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      const refused = results.find((result) => result.status === "rejected");
      expect(refused?.reason).toBeInstanceOf(VolumeBusyError);
      const winner = results[0]!.status === "fulfilled" ? first.id : second.id;
      expect(
        fake.calls.filter((call) => call.op === "ensure").map((call) => call.spec.attemptId),
      ).toEqual([winner]);
      expect([
        await fixture.writerOf(privateVolume.id),
        await fixture.writerOf(sharedVolume.id),
      ]).toEqual([winner, winner]);
    }
  });

  it("frees the lease of a worker released while its start waited for a volume", async () => {
    const fake = new FakeWorkerProvider();
    const workers = createWorkerLifecycle({ prisma, provider: fake });
    const { bot, privateVolume } = await fixture.migratedBot();
    const attempt = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    const launch = await fixture.launchFor(workers, attempt.id, privateFiles);
    const lockWaiters = async (sql: string) => {
      const { rows } = await pool.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [`%${sql}%`],
      );
      return rows[0]!.waiting;
    };
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM volumes WHERE id = $1 FOR UPDATE", [privateVolume.id]);

    const started = workers.start(launch, fixture.context).catch((error: unknown) => error);
    await vi.waitFor(async () => expect(await lockWaiters("FROM volumes WHERE id = ANY")).toBe(1));
    let releaseSettled = false;
    const released = workers.release(attempt.id, fixture.context).finally(() => {
      releaseSettled = true;
    });
    await vi.waitFor(async () =>
      expect(releaseSettled || (await lockWaiters(`SET "workerState" = 'releasing'`)) === 1).toBe(
        true,
      ),
    );
    await holder.query("COMMIT");
    holder.release();

    await expect(released).resolves.toBe("awaiting_ensure");
    expect(await started).toBeInstanceOf(StaleAttemptError);
    expect(fake.live.size).toBe(0);
    expect(await fixture.workerStateOf(attempt.id)).toBe("released");
    expect(await fixture.writerOf(privateVolume.id)).toBeNull();
  });
});
