import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AdapterContext, PortableFile } from "@tangow/adapter-kit";
import { AgentRuntimeBusyError } from "@tangow/adapter-kit";
import type { PrismaClient } from "@tangow/db";
import { createDb, deleteOwnerVolumes, OwnerWorkerLiveError } from "@tangow/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inspectLocalVolume } from "./docker-volume-import.js";
import { DockerWorkerProvider } from "./docker-worker.js";
import { migrateE2BToDocker } from "./e2b-docker-migration.js";
import { carryDockerVolumesToE2B } from "./e2b-home-upgrade.js";
import { MemoryVolumeFiles } from "./fake-volume-files.js";
import { FakeWorkerProvider } from "./fake-worker-provider.js";
import { allFiles, mcpOnly, privateFiles, workerFixture } from "./worker-fixture.test-support.js";
import { createWorkerLifecycle, StaleAttemptError } from "./worker-lifecycle.js";

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

  it.each(["docker", "e2b"])(
    "refuses %s provider cutover after database expiry despite a slow process clock",
    async (kind) => {
      const root = await mkdtemp(path.join(tmpdir(), "rakazo-cutover-clock-"));
      const spaceId = await fixture.seedSpace();
      const computer = await fixture.seedComputer(spaceId, {
        kind,
        scope: "dedicated",
        homeStorage: "volumes",
      });
      const bot = await fixture.seedBot(spaceId, computer.id);
      const ref = `tangow-${randomUUID()}`;
      const volume = await fixture.seedVolume("bot_private", spaceId, bot.id, ref);
      await prisma.volume.update({
        where: { id: volume.id },
        data: { providerKind: `${kind}-worker` },
      });
      const directory = path.join(root, "volumes", ref);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "notes.md"), "notes");
      const expire = async () => {
        await prisma.$executeRaw`UPDATE computers SET "homeMoveExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second'
        WHERE id = ${computer.id}`;
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() - 120_000);
      };
      try {
        if (kind === "docker") {
          class ExpireDuringCopy extends MemoryVolumeFiles {
            override async write(target: string, file: PortableFile, context: AdapterContext) {
              await super.write(target, file, context);
              await expire();
            }
          }
          const source = new DockerWorkerProvider({
            dataDir: root,
            supervisorUrl: "http://127.0.0.1:9",
            supervisorToken: "unused",
          });
          expect(
            await carryDockerVolumesToE2B(
              {
                prisma,
                dataDir: root,
                source,
                target: new FakeWorkerProvider(),
                files: new ExpireDuringCopy(),
              },
              computer.id,
              fixture.context,
            ),
          ).toMatchObject({ outcome: "refused", refusal: { code: "computer_active" } });
        } else {
          await expect(
            migrateE2BToDocker(
              {
                prisma,
                dataDir: path.join(root, "destination"),
                source: {
                  inspect: () => inspectLocalVolume(directory),
                  read: async (_, file) => {
                    const content = await readFile(path.join(directory, file));
                    await expire();
                    return content;
                  },
                },
                workers: new FakeWorkerProvider(),
                destroyComputer: async () => {},
              },
              randomUUID(),
              fixture.context,
            ),
          ).rejects.toThrow("Migration reservation expired");
        }
        expect(
          (await prisma.volume.findUniqueOrThrow({ where: { id: volume.id } })).providerKind,
        ).toBe(`${kind}-worker`);
        expect((await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })).kind).toBe(
          kind,
        );
        expect(await readFile(path.join(directory, "notes.md"), "utf8")).toBe("notes");
      } finally {
        vi.useRealTimers();
        await prisma.volume.deleteMany({ where: { spaceId } });
        await prisma.space.delete({ where: { id: spaceId } });
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([-120_000, 120_000])(
    "uses the database clock with process skew %i for every reservation operation",
    async (skew) => {
      const { computer } = await fixture.migratedBot();
      const workers = createWorkerLifecycle({ prisma, provider: null });
      await prisma.computer.update({
        where: { id: computer.id },
        data: { homeStorage: "snapshot" },
      });
      const { start } = await workers.inspectHomeMove(computer.id);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + skew);
      try {
        const reservation = await workers.reserveHomeMove(computer.id);
        if (!("marker" in reservation)) throw new Error(reservation.blocker);
        const [reserved] = await prisma.$queryRaw<{ remaining: number }[]>`
          SELECT EXTRACT(EPOCH FROM ("homeMoveExpiresAt" - (now() AT TIME ZONE 'UTC')))::float8 AS remaining
          FROM computers WHERE id = ${computer.id}`;
        expect(reserved!.remaining).toBeGreaterThan(50);
        expect(reserved!.remaining).toBeLessThanOrEqual(60.001);
        vi.setSystemTime(Date.now() - 2 * skew);
        expect(await workers.renewHomeMove(reservation.marker)).toBe(true);
        const [renewed] = await prisma.$queryRaw<{ remaining: number }[]>`
          SELECT EXTRACT(EPOCH FROM ("homeMoveExpiresAt" - (now() AT TIME ZONE 'UTC')))::float8 AS remaining
          FROM computers WHERE id = ${computer.id}`;
        expect(renewed!.remaining).toBeGreaterThan(50);
        expect(renewed!.remaining).toBeLessThanOrEqual(60.001);
        expect(await workers.clearStaleHomeMove(computer.id)).toBe(false);
        await workers.reconcile({ limit: 10 }, fixture.context);
        expect(await workers.adoptVolumeHome(computer.id, start, reservation.marker)).toBe(
          "adopted",
        );
        await prisma.$executeRaw`UPDATE computers SET "homeMoveExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE id = ${computer.id}`;
        vi.setSystemTime(Date.now() - 24 * 60 * 60_000);
        expect(await workers.renewHomeMove(reservation.marker)).toBe(false);
        expect(await workers.adoptVolumeHome(computer.id, start, reservation.marker)).toBe(
          "computer_active",
        );
        expect(await workers.clearStaleHomeMove(computer.id)).toBe(true);
        const next = await workers.reserveHomeMove(computer.id);
        if (!("marker" in next)) throw new Error(next.blocker);
        await prisma.$executeRaw`UPDATE computers SET "homeMoveExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE id = ${computer.id}`;
        await workers.reconcile({ limit: 10 }, fixture.context);
        expect(
          (await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })).maintenanceId,
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("reports whether clear-stale-move matched an expired reservation without E2B credentials", async () => {
    const { computer } = await fixture.migratedBot();
    const workers = createWorkerLifecycle({ prisma, provider: null });
    const clear = async () => {
      const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl };
      delete env.E2B_API_KEY;
      return (
        await promisify(execFile)(
          process.execPath,
          [
            "--import",
            "tsx",
            "scripts/migrate-home-to-volumes.ts",
            "--computer",
            computer.id,
            "--clear-stale-move",
          ],
          { env },
        )
      ).stdout.trim();
    };
    expect(await clear()).toBe("No expired home move reservation matched.");
    const reservation = await workers.reserveHomeMove(computer.id);
    if (!("marker" in reservation)) throw new Error(reservation.blocker);
    expect(await clear()).toBe("No expired home move reservation matched.");
    await prisma.computer.updateMany({
      where: { maintenanceId: reservation.marker },
      data: { homeMoveExpiresAt: new Date(0) },
    });
    expect(await clear()).toBe("Expired home move reservation cleared; rerun the move to resume.");
    expect(await clear()).toBe("No expired home move reservation matched.");
  });

  it.each(["team", "dedicated"])(
    "serializes a %s home move reservation against an already planned worker",
    async (scope) => {
      for (let round = 0; round < ROUNDS; round++) {
        const provider = new FakeWorkerProvider();
        const workers = createWorkerLifecycle({ prisma, provider });
        const { computer, bot } = await fixture.migratedBot();
        await prisma.computer.update({ where: { id: computer.id }, data: { scope } });
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
    },
  );

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

  it("starts both runs racing for the same volumes, whatever their grant order", async () => {
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

      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      const mounts = [
        { volumeRef: privateVolume.providerRef, path: `/workspace/bots/${bot.id}`, access: "rw" },
        { volumeRef: sharedVolume.providerRef, path: "/workspace/shared", access: "rw" },
      ];
      expect(fake.live.get(`fake-worker-${first.id}`)?.mounts).toEqual(mounts);
      expect(fake.live.get(`fake-worker-${second.id}`)?.mounts).toEqual([...mounts].reverse());
      expect([
        await fixture.workerStateOf(first.id),
        await fixture.workerStateOf(second.id),
      ]).toEqual(["ready", "ready"]);
      await workers.release(first.id, fixture.context);
      expect([...fake.live.keys()]).toEqual([`fake-worker-${second.id}`]);
      await workers.release(second.id, fixture.context);
      expect(fake.live.size).toBe(0);
    }
  });

  it("lets two bots of one space racing for the shared volume both write it", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const fake = new FakeWorkerProvider();
      const workers = createWorkerLifecycle({ prisma, provider: fake });
      const { computer, bot } = await fixture.migratedBot();
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
      expect(fake.live.size).toBe(2);
    }
  });

  it("lets one of two concurrent starts of the same attempt reach the provider", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const fake = new FakeWorkerProvider();
      const workers = createWorkerLifecycle({ prisma, provider: fake });
      const { bot } = await fixture.migratedBot();
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
      expect([...fake.live.keys()]).toEqual([`fake-worker-${attempt.id}`]);
    }
  });

  it("lets a start racing its bot's deletion either block the deletion or never start", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const fake = new FakeWorkerProvider();
      const workers = createWorkerLifecycle({ prisma, provider: fake });
      const { bot } = await fixture.migratedBot();
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
        expect([...fake.live.keys()]).toEqual([`fake-worker-${attempt.id}`]);
      } else {
        expect(started.reason).toBeInstanceOf(StaleAttemptError);
        expect(deleted.status).toBe("fulfilled");
        expect(fake.calls).toEqual([]);
      }
    }
  });
});
