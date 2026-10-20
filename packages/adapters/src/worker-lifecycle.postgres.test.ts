import { AgentRuntimeBusyError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createDb, deleteOwnerVolumes, OwnerWorkerLiveError } from "@rakazo/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("serializes a home move reservation against a worker already planned in the space", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const provider = new FakeWorkerProvider();
      const workers = createWorkerLifecycle({ prisma, provider });
      const { computer, bot } = await fixture.migratedBot();
      const attempt = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
      const launch = await fixture.launchFor(workers, attempt.id, mcpOnly);
      const [started, reservation] = await Promise.allSettled([
        workers.start(launch, fixture.context),
        workers.reserveHomeMove(computer.id),
      ]);
      if (reservation.status !== "fulfilled") throw reservation.reason;
      if ("marker" in reservation.value) {
        expect(started).toMatchObject({
          status: "rejected",
          reason: expect.any(AgentRuntimeBusyError),
        });
        expect(provider.calls.filter((call) => call.op === "ensure")).toEqual([]);
        await workers.releaseHomeMove(reservation.value.marker);
      } else {
        expect(reservation.value.blocker).toBe("space_worker_live");
        expect(started.status).toBe("fulfilled");
        await workers.release(attempt.id, fixture.context);
      }
    }
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
      ]).toEqual([winner, null]);
    }
  });

  it("lets two bots of one space racing for the shared volume both write it", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const fake = new FakeWorkerProvider();
      const workers = createWorkerLifecycle({ prisma, provider: fake });
      const { computer, bot, sharedVolume } = await fixture.migratedBot();
      const teammate = await fixture.teammateOf(computer);
      const first = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
      const second = await fixture.seedAttempt((await fixture.seedRun(teammate.bot)).id);
      const firstLaunch = await fixture.launchFor(workers, first.id, allFiles);
      const secondLaunch = await fixture.launchFor(workers, second.id, allFiles);

      const results = await Promise.allSettled([
        workers.start(firstLaunch, fixture.context),
        workers.start(secondLaunch, fixture.context),
      ]);

      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(
        fake.calls
          .filter((call) => call.op === "ensure")
          .map((call) => call.spec.attemptId)
          .sort(),
      ).toEqual([first.id, second.id].sort());
      expect(await fixture.writerOf(sharedVolume.id)).toBeNull();
    }
  });

  it("lets one of two concurrent starts of the same attempt reach the provider", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const fake = new FakeWorkerProvider();
      const workers = createWorkerLifecycle({ prisma, provider: fake });
      const { bot, privateVolume } = await fixture.migratedBot();
      const attempt = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
      const launch = await fixture.launchFor(workers, attempt.id, privateFiles);

      const results = await Promise.allSettled([
        workers.start(launch, fixture.context),
        workers.start(launch, fixture.context),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(results.find((result) => result.status === "rejected")?.reason).toBeInstanceOf(
        StaleAttemptError,
      );
      expect(fake.calls.map((call) => call.op)).toEqual(["ensure", "prepare"]);
      expect(await fixture.workerStateOf(attempt.id)).toBe("ready");
      expect(await fixture.writerOf(privateVolume.id)).toBe(attempt.id);
    }
  });

  it("lets a start racing its bot's deletion either block the deletion or never start", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const fake = new FakeWorkerProvider();
      const workers = createWorkerLifecycle({ prisma, provider: fake });
      const { bot, privateVolume } = await fixture.migratedBot();
      const attempt = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
      const launch = await fixture.launchFor(workers, attempt.id, allFiles);

      const [started, deleted] = await Promise.allSettled([
        workers.start(launch, fixture.context),
        prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM bots WHERE id = ${bot.id} FOR UPDATE`;
          await deleteOwnerVolumes(tx, { botId: bot.id });
          await tx.bot.delete({ where: { id: bot.id } });
        }),
      ]);

      if (started.status === "fulfilled") {
        expect(deleted).toMatchObject({
          status: "rejected",
          reason: expect.any(OwnerWorkerLiveError),
        });
        expect(await fixture.writerOf(privateVolume.id)).toBe(attempt.id);
      } else {
        expect(started.reason).toBeInstanceOf(StaleAttemptError);
        expect(deleted.status).toBe("fulfilled");
        expect(fake.calls).toEqual([]);
      }
    }
  });
});
