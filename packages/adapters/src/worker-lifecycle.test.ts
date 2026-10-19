import type { PrismaClient } from "@rakazo/db";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeWorkerProvider } from "./fake-worker-provider.js";
import { allFiles, mcpOnly, workerFixture } from "./worker-fixture.test-support.js";
import {
  createWorkerLifecycle,
  StaleAttemptError,
  VolumeBusyError,
  VolumeRefusedError,
} from "./worker-lifecycle.js";

let database: PgliteDatabase;
let prisma: PrismaClient;
let fake: FakeWorkerProvider;
let workers: ReturnType<typeof createWorkerLifecycle>;
let fixture: ReturnType<typeof workerFixture>;
let spaceA: string;
let spaceB: string;

beforeAll(async () => {
  database = await openPgliteDatabase();
  prisma = database.prisma;
  fixture = workerFixture(prisma);
  await fixture.seedOwner();
  spaceA = await fixture.seedSpace();
  spaceB = await fixture.seedSpace();
});
afterAll(() => database.close());
beforeEach(() => {
  fake = new FakeWorkerProvider();
  workers = createWorkerLifecycle({ prisma, provider: fake });
});

describe("worker plan", () => {
  it("keeps every run in process without a query when no worker provider is composed", async () => {
    const noDatabase = new Proxy({} as PrismaClient, {
      get() {
        throw new Error("plan queried the database");
      },
    });
    const lifecycle = createWorkerLifecycle({ prisma: noDatabase, provider: null });

    await expect(lifecycle.plan({ attemptId: "attempt", needs: allFiles })).resolves.toEqual({
      mode: "in_process",
      reason: "no_worker_provider",
    });
  });

  it("keeps a run that needs files in process while its home is a snapshot", async () => {
    const computer = await fixture.seedComputer(spaceA);
    const bot = await fixture.seedBot(spaceA, computer.id);
    const attempt = await fixture.seedAttempt((await fixture.seedRun(bot)).id);

    await expect(
      workers.plan({
        attemptId: attempt.id,
        needs: { files: { private: "rw", shared: null }, computer: "none" },
      }),
    ).resolves.toEqual({ mode: "in_process", reason: "home_not_migrated" });
  });

  it("plans the bot's own volumes and a lazy computer once its home is migrated", async () => {
    const { computer, bot, privateVolume, sharedVolume } = await fixture.migratedBot();
    const run = await fixture.seedRun(bot, { leaseFence: 3 });
    const attempt = await fixture.seedAttempt(run.id, 3);

    await expect(workers.plan({ attemptId: attempt.id, needs: allFiles })).resolves.toEqual({
      mode: "worker",
      runId: run.id,
      botId: bot.id,
      spaceId: bot.spaceId,
      attemptId: attempt.id,
      fence: 3,
      volumes: [
        { volumeId: privateVolume.id, access: "rw" },
        { volumeId: sharedVolume.id, access: "rw" },
      ],
      computer: { mode: "on_use", computerId: computer.id },
    });
  });

  it("refuses to plan for an attempt that lost its fence", async () => {
    const { bot } = await fixture.migratedBot();
    const run = await fixture.seedRun(bot, { leaseFence: 2 });
    const stale = await fixture.seedAttempt(run.id, 1);

    await expect(workers.plan({ attemptId: stale.id, needs: mcpOnly })).rejects.toThrow(
      StaleAttemptError,
    );
  });
});

describe("worker start", () => {
  it("gives an MCP-only run a worker without a computer, mount or lease", async () => {
    const computer = await fixture.seedComputer(spaceA);
    const bot = await fixture.seedBot(spaceA, computer.id);
    const privateVolume = await fixture.seedVolume("bot_private", spaceA, bot.id);
    const run = await fixture.seedRun(bot);
    const attempt = await fixture.seedAttempt(run.id);

    const launch = await fixture.launchFor(workers, attempt.id, mcpOnly);
    const started = await workers.start(launch, fixture.context);

    expect(launch.volumes).toEqual([]);
    expect(launch.computer).toEqual({ mode: "none" });
    expect(started).toEqual({
      providerRef: `fake-worker-${attempt.id}`,
      start: {
        version: 1,
        kind: "worker.start",
        worker: { runId: run.id, attemptId: attempt.id, fence: 1 },
        workspace: { cwd: "/workspace", mounts: [] },
        computer: "none",
      },
    });
    expect(fake.calls[0]).toMatchObject({ op: "ensure", spec: { mounts: [], ttlSeconds: 14_400 } });
    expect(await prisma.computerExecutionLease.count({ where: { computerId: computer.id } })).toBe(
      0,
    );
    expect(await fixture.writerOf(privateVolume.id)).toBeNull();
    expect(await fixture.workerStateOf(attempt.id)).toBe("ready");
  });

  it("mounts the bot's volumes at fixed paths without telling the guest which volume", async () => {
    const { bot, privateVolume, sharedVolume } = await fixture.migratedBot();
    const attempt = await fixture.seedAttempt((await fixture.seedRun(bot)).id);

    const started = await workers.start(
      await fixture.launchFor(workers, attempt.id, allFiles),
      fixture.context,
    );

    expect(fake.calls[0]).toEqual({
      op: "ensure",
      spec: {
        attemptId: attempt.id,
        runId: started.start.worker.runId,
        botId: bot.id,
        mounts: [
          { volumeRef: privateVolume.providerRef, path: `/workspace/bots/${bot.id}`, access: "rw" },
          { volumeRef: sharedVolume.providerRef, path: "/workspace/shared", access: "rw" },
        ],
        ttlSeconds: 14_400,
      },
    });
    expect(started.start.workspace).toEqual({
      cwd: `/workspace/bots/${bot.id}`,
      mounts: [
        { path: `/workspace/bots/${bot.id}`, scope: "private", access: "rw" },
        { path: "/workspace/shared", scope: "shared", access: "rw" },
      ],
    });
    expect([
      await fixture.writerOf(privateVolume.id),
      await fixture.writerOf(sharedVolume.id),
    ]).toEqual([attempt.id, attempt.id]);
  });

  it("refuses an attempt that no longer holds the run's fence before the provider", async () => {
    const { bot } = await fixture.migratedBot();
    const run = await fixture.seedRun(bot, { leaseFence: 2 });
    const stale = await fixture.seedAttempt(run.id, 1);
    const current = await fixture.seedAttempt(run.id, 2);
    const launch = await fixture.launchFor(workers, current.id, mcpOnly);

    await expect(
      workers.start({ ...launch, attemptId: stale.id, fence: 1 }, fixture.context),
    ).rejects.toThrow(StaleAttemptError);
    expect(fake.calls).toEqual([]);
    expect(await fixture.workerStateOf(stale.id)).toBeNull();
  });

  it.each([
    ["private_volume_of_other_bot", "bot_private"],
    ["shared_volume_of_other_space", "space_shared"],
  ] as const)("refuses %s before the provider", async (code, kind) => {
    const { bot } = await fixture.migratedBot();
    const other = await fixture.seedBot(spaceB, null);
    const foreign = await fixture.seedVolume(
      kind,
      spaceB,
      kind === "bot_private" ? other.id : null,
    );
    const attempt = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    const launch = await fixture.launchFor(workers, attempt.id, mcpOnly);

    const refused = workers.start(
      { ...launch, volumes: [{ volumeId: foreign.id, access: "rw" }] },
      fixture.context,
    );

    await expect(refused).rejects.toThrow(VolumeRefusedError);
    await expect(refused).rejects.toMatchObject({ refusal: { code, volumeId: foreign.id } });
    expect(fake.calls).toEqual([]);
    expect(await fixture.workerStateOf(attempt.id)).toBeNull();
    expect(await fixture.writerOf(foreign.id)).toBeNull();
  });

  it("requeues a second file run of the bot until the first worker is gone", async () => {
    const { bot, privateVolume, sharedVolume } = await fixture.migratedBot();
    const first = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    const second = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    await workers.start(await fixture.launchFor(workers, first.id, allFiles), fixture.context);
    const secondLaunch = await fixture.launchFor(workers, second.id, allFiles);

    const busy = workers.start(secondLaunch, fixture.context);

    await expect(busy).rejects.toThrow(VolumeBusyError);
    await expect(busy).rejects.toMatchObject({
      volumeIds: [privateVolume.id, sharedVolume.id],
    });
    expect(fake.calls.filter((call) => call.op === "ensure")).toHaveLength(1);
    expect(await fixture.workerStateOf(second.id)).toBeNull();

    await workers.release(first.id, fixture.context);
    await expect(workers.start(secondLaunch, fixture.context)).resolves.toMatchObject({
      providerRef: `fake-worker-${second.id}`,
    });
  });

  it("releases the worker and its volumes when setup fails", async () => {
    const { bot, privateVolume } = await fixture.migratedBot();
    const attempt = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    fake = new FakeWorkerProvider({ failPrepare: new Error("runner unreachable") });
    workers = createWorkerLifecycle({ prisma, provider: fake });

    await expect(
      workers.start(await fixture.launchFor(workers, attempt.id, allFiles), fixture.context),
    ).rejects.toThrow("runner unreachable");
    expect(fake.calls.at(-1)).toEqual({
      op: "destroy",
      attemptId: attempt.id,
      providerRef: `fake-worker-${attempt.id}`,
      result: "destroyed",
    });
    expect(await fixture.workerStateOf(attempt.id)).toBe("released");
    expect(await fixture.writerOf(privateVolume.id)).toBeNull();
  });
});

describe("worker release", () => {
  it("destroys once however often it is released, and an absent VM is released too", async () => {
    const { bot } = await fixture.migratedBot();
    const kept = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    const gone = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    await workers.start(await fixture.launchFor(workers, kept.id, mcpOnly), fixture.context);
    await workers.start(await fixture.launchFor(workers, gone.id, mcpOnly), fixture.context);
    fake.live.delete(`fake-worker-${gone.id}`);

    for (const attempt of [kept, gone, kept, gone])
      await workers.release(attempt.id, fixture.context);

    expect(fake.calls.filter((call) => call.op === "destroy")).toEqual([
      {
        op: "destroy",
        attemptId: kept.id,
        providerRef: `fake-worker-${kept.id}`,
        result: "destroyed",
      },
      {
        op: "destroy",
        attemptId: gone.id,
        providerRef: `fake-worker-${gone.id}`,
        result: "absent",
      },
    ]);
    expect([await fixture.workerStateOf(kept.id), await fixture.workerStateOf(gone.id)]).toEqual([
      "released",
      "released",
    ]);
  });

  it("keeps volume rows and provider refs after the run ends", async () => {
    const { bot, privateVolume, sharedVolume } = await fixture.migratedBot();
    const run = await fixture.seedRun(bot);
    const attempt = await fixture.seedAttempt(run.id);
    await workers.start(await fixture.launchFor(workers, attempt.id, allFiles), fixture.context);

    await workers.release(attempt.id, fixture.context);
    await prisma.run.update({ where: { id: run.id }, data: { status: "completed" } });

    const volumes = await prisma.volume.findMany({
      where: { id: { in: [privateVolume.id, sharedVolume.id] } },
      orderBy: { kind: "asc" },
    });
    expect(volumes).toEqual([
      { ...privateVolume, updatedAt: expect.any(Date) },
      { ...sharedVolume, updatedAt: expect.any(Date) },
    ]);
    expect(fake.calls.map((call) => call.op)).toEqual(["ensure", "prepare", "destroy"]);
  });

  it("reconciles workers whose run lease expired, by ref or by attempt tag", async () => {
    const { bot, privateVolume } = await fixture.migratedBot();
    const expired = { leaseExpiresAt: new Date(Date.now() - 60_000) };
    const created = await fixture.seedAttempt((await fixture.seedRun(bot, expired)).id, 1, {
      workerState: "created",
      workerProviderKind: "fake-worker",
      workerProviderRef: "fake-worker-crashed",
      workerStateAt: new Date(),
    });
    const requested = await fixture.seedAttempt((await fixture.seedRun(bot, expired)).id, 1, {
      workerState: "requested",
      workerProviderKind: "fake-worker",
      workerStateAt: new Date(),
    });
    await prisma.volume.update({
      where: { id: privateVolume.id },
      data: { writerAttemptId: created.id },
    });
    const spec = { runId: "run", botId: bot.id, mounts: [], ttlSeconds: 60 };
    fake.live.set("fake-worker-crashed", { ...spec, attemptId: created.id });
    fake.live.set("fake-worker-untracked", { ...spec, attemptId: requested.id });
    const active = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    await workers.start(await fixture.launchFor(workers, active.id, mcpOnly), fixture.context);

    await expect(workers.reconcile({ limit: 10 }, fixture.context)).resolves.toEqual({
      released: 2,
      failed: 0,
    });
    expect([...fake.live.keys()]).toEqual([`fake-worker-${active.id}`]);
    expect(fake.calls.filter((call) => call.op === "destroy")).toEqual([
      {
        op: "destroy",
        attemptId: created.id,
        providerRef: "fake-worker-crashed",
        result: "destroyed",
      },
      { op: "destroy", attemptId: requested.id, providerRef: null, result: "destroyed" },
    ]);
    expect(await fixture.writerOf(privateVolume.id)).toBeNull();
    expect(await fixture.workerStateOf(active.id)).toBe("ready");
  });

  it("reports a worker inactive once a newer claim takes the run's fence", async () => {
    const { bot } = await fixture.migratedBot();
    const run = await fixture.seedRun(bot);
    const attempt = await fixture.seedAttempt(run.id);
    await workers.start(await fixture.launchFor(workers, attempt.id, mcpOnly), fixture.context);
    await prisma.run.update({ where: { id: run.id }, data: { leaseFence: 2 } });

    await expect(workers.status(attempt.id)).resolves.toEqual({
      version: 1,
      kind: "worker.status",
      worker: { runId: run.id, attemptId: attempt.id, fence: 1 },
      state: "ready",
      providerRef: `fake-worker-${attempt.id}`,
      active: false,
    });
  });
});
