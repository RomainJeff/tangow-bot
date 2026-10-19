import type { PrismaClient } from "@rakazo/db";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWorkerProvider } from "./fake-worker-provider.js";
import {
  allFiles,
  mcpOnly,
  pastEnsureTimeout,
  privateFiles,
  workerFixture,
} from "./worker-fixture.test-support.js";
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

  it.each([
    ["private", { private: "rw", shared: null }],
    ["shared", { private: null, shared: "rw" }],
  ] as const)("refuses a run whose migrated home lacks its %s volume", async (slot, files) => {
    const computer = await fixture.seedComputer(spaceA, { homeStorage: "volumes" });
    const bot = await fixture.seedBot(spaceA, computer.id);
    const attempt = await fixture.seedAttempt((await fixture.seedRun(bot)).id);

    await expect(
      workers.plan({ attemptId: attempt.id, needs: { files, computer: "none" } }),
    ).resolves.toEqual({ mode: "refused", refusal: { code: "slot_volume_missing", slot } });
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
    expect(fake.calls[0]).toMatchObject({
      op: "ensure",
      spec: { mounts: [], ttlSeconds: 14_400, ensureTimeoutSeconds: 900 },
    });
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
        ensureTimeoutSeconds: 900,
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
    ]).toEqual([attempt.id, null]);
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
    const { bot, privateVolume } = await fixture.migratedBot();
    const first = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    const second = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    await workers.start(await fixture.launchFor(workers, first.id, allFiles), fixture.context);
    const secondLaunch = await fixture.launchFor(workers, second.id, allFiles);

    const busy = workers.start(secondLaunch, fixture.context);

    await expect(busy).rejects.toThrow(VolumeBusyError);
    await expect(busy).rejects.toMatchObject({ volumeIds: [privateVolume.id] });
    expect(fake.calls.filter((call) => call.op === "ensure")).toHaveLength(1);
    expect(await fixture.workerStateOf(second.id)).toBeNull();

    await workers.release(first.id, fixture.context);
    await expect(workers.start(secondLaunch, fixture.context)).resolves.toMatchObject({
      providerRef: `fake-worker-${second.id}`,
    });
  });

  it("lets two bots of one space write the shared volume at once", async () => {
    const { computer, bot, sharedVolume } = await fixture.migratedBot();
    const teammate = await fixture.teammateOf(computer);
    const first = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    const second = await fixture.seedAttempt((await fixture.seedRun(teammate.bot)).id);

    await workers.start(await fixture.launchFor(workers, first.id, allFiles), fixture.context);
    await workers.start(await fixture.launchFor(workers, second.id, allFiles), fixture.context);

    expect(
      fake.calls.flatMap((call) =>
        call.op === "ensure"
          ? [[call.spec.attemptId, call.spec.mounts.map((mount) => mount.path)]]
          : [],
      ),
    ).toEqual([
      [first.id, [`/workspace/bots/${bot.id}`, "/workspace/shared"]],
      [second.id, [`/workspace/bots/${teammate.bot.id}`, "/workspace/shared"]],
    ]);
    expect([
      await fixture.writerOf(sharedVolume.id),
      await fixture.writerOf(teammate.privateVolume.id),
    ]).toEqual([null, second.id]);
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

describe("worker ownership while start is in flight", () => {
  async function startHeldInEnsure(needs = allFiles) {
    const { bot } = await fixture.migratedBot();
    const run = await fixture.seedRun(bot);
    const attempt = await fixture.seedAttempt(run.id);
    const launch = await fixture.launchFor(workers, attempt.id, needs);
    const letEnsureFinish = fake.holdEnsure();
    const started = workers.start(launch, fixture.context).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fake.calls.map((call) => call.op)).toEqual(["ensure"]));
    return { bot, run, attempt, launch, letEnsureFinish, started };
  }

  it("refuses a second start of the same attempt before the provider", async () => {
    const { attempt, launch, letEnsureFinish, started } = await startHeldInEnsure(privateFiles);

    await expect(workers.start(launch, fixture.context)).rejects.toThrow(StaleAttemptError);
    expect(fake.calls.map((call) => call.op)).toEqual(["ensure"]);
    letEnsureFinish();

    expect(await started).toMatchObject({ providerRef: `fake-worker-${attempt.id}` });
    expect(await fixture.workerStateOf(attempt.id)).toBe("ready");
  });

  it("holds the leases of a run cancelled mid-ensure until its late VM is destroyed", async () => {
    const ensure = fake.ensure.bind(fake);
    const atEnsureReturn: unknown[] = [];
    fake.ensure = async (spec, context) => {
      const created = await ensure(spec, context);
      atEnsureReturn.push({
        live: [...fake.live.keys()],
        leases: await prisma.volume.count({ where: { writerAttemptId: spec.attemptId } }),
      });
      return created;
    };
    const { bot, run, attempt, letEnsureFinish, started } = await startHeldInEnsure();
    await prisma.run.update({ where: { id: run.id }, data: { status: "cancelled" } });

    await expect(workers.reconcile({ limit: 10 }, fixture.context)).resolves.toEqual({
      released: 0,
      awaitingEnsure: 1,
      failed: 0,
    });
    letEnsureFinish();

    expect(await started).toBeInstanceOf(StaleAttemptError);
    expect(atEnsureReturn).toEqual([{ live: [`fake-worker-${attempt.id}`], leases: 1 }]);
    expect(fake.calls.filter((call) => call.op === "destroy")).toEqual([
      {
        op: "destroy",
        attemptId: attempt.id,
        providerRef: `fake-worker-${attempt.id}`,
        result: "destroyed",
      },
    ]);
    expect(fake.live.size).toBe(0);
    expect(await fixture.workerStateOf(attempt.id)).toBe("released");
    const next = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    await expect(
      workers.start(await fixture.launchFor(workers, next.id, allFiles), fixture.context),
    ).resolves.toMatchObject({ providerRef: `fake-worker-${next.id}` });
  });

  it("records the VM of an ensure that outlived its timeout until a destroy succeeds", async () => {
    const { attempt, letEnsureFinish, started } = await startHeldInEnsure();
    await fixture.outliveEnsure(attempt.id);
    await expect(workers.release(attempt.id, fixture.context)).resolves.toBe("released");
    fake.failDestroy = new Error("provider unreachable");
    letEnsureFinish();

    expect(await started).toBeInstanceOf(StaleAttemptError);
    expect(
      await prisma.attempt.findUniqueOrThrow({
        where: { id: attempt.id },
        select: { workerState: true, workerProviderRef: true },
      }),
    ).toEqual({ workerState: "releasing", workerProviderRef: `fake-worker-${attempt.id}` });
    expect([...fake.live.keys()]).toEqual([`fake-worker-${attempt.id}`]);

    fake.failDestroy = null;
    await expect(workers.reconcile({ limit: 10 }, fixture.context)).resolves.toEqual({
      released: 1,
      awaitingEnsure: 0,
      failed: 0,
    });
    expect(fake.live.size).toBe(0);
    expect(await fixture.workerStateOf(attempt.id)).toBe("released");
  });

  it("keeps the lease of a worker the provider cannot confirm destroyed", async () => {
    const { bot, privateVolume } = await fixture.migratedBot();
    const attempt = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    await workers.start(await fixture.launchFor(workers, attempt.id, allFiles), fixture.context);
    fake.failDestroy = new Error("provider unreachable");

    await expect(workers.release(attempt.id, fixture.context)).rejects.toThrow(
      "provider unreachable",
    );
    expect(await fixture.workerStateOf(attempt.id)).toBe("releasing");
    expect(await fixture.writerOf(privateVolume.id)).toBe(attempt.id);

    fake.failDestroy = null;
    await expect(workers.reconcile({ limit: 10 }, fixture.context)).resolves.toEqual({
      released: 1,
      awaitingEnsure: 0,
      failed: 0,
    });
    expect(fake.live.size).toBe(0);
    expect(await fixture.writerOf(privateVolume.id)).toBeNull();
    expect(await fixture.workerStateOf(attempt.id)).toBe("released");
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
      workerEnsureAt: new Date(),
    });
    const requested = await fixture.seedAttempt((await fixture.seedRun(bot, expired)).id, 1, {
      workerState: "requested",
      workerProviderKind: "fake-worker",
      workerStateAt: pastEnsureTimeout(),
      workerEnsureAt: pastEnsureTimeout(),
    });
    await prisma.volume.update({
      where: { id: privateVolume.id },
      data: { writerAttemptId: created.id },
    });
    const spec = {
      runId: "run",
      botId: bot.id,
      mounts: [],
      ttlSeconds: 60,
      ensureTimeoutSeconds: 60,
    };
    fake.live.set("fake-worker-crashed", { ...spec, attemptId: created.id });
    fake.live.set("fake-worker-untracked", { ...spec, attemptId: requested.id });
    const active = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    await workers.start(await fixture.launchFor(workers, active.id, mcpOnly), fixture.context);

    await expect(workers.reconcile({ limit: 10 }, fixture.context)).resolves.toEqual({
      released: 2,
      awaitingEnsure: 0,
      failed: 0,
    });
    expect([...fake.live.keys()]).toEqual([`fake-worker-${active.id}`]);
    expect(fake.calls.filter((call) => call.op === "destroy")).toEqual([
      { op: "destroy", attemptId: requested.id, providerRef: null, result: "destroyed" },
      {
        op: "destroy",
        attemptId: created.id,
        providerRef: "fake-worker-crashed",
        result: "destroyed",
      },
    ]);
    expect(await fixture.writerOf(privateVolume.id)).toBeNull();
    expect(await fixture.workerStateOf(active.id)).toBe("ready");
  });

  it("reaches a healthy worker behind one whose destroy fails, one worker per pass", async () => {
    const { bot } = await fixture.migratedBot();
    const cancelled = { status: "cancelled" };
    const stuckSince = new Date(pastEnsureTimeout().getTime() - 1000);
    const stuck = await fixture.seedAttempt((await fixture.seedRun(bot, cancelled)).id, 1, {
      workerState: "requested",
      workerProviderKind: "fake-worker",
      workerStateAt: stuckSince,
      workerEnsureAt: stuckSince,
    });
    const healthy = await fixture.seedAttempt((await fixture.seedRun(bot, cancelled)).id, 1, {
      workerState: "ready",
      workerProviderKind: "fake-worker",
      workerProviderRef: "fake-worker-healthy",
      workerStateAt: pastEnsureTimeout(),
      workerEnsureAt: pastEnsureTimeout(),
    });
    const pass = () => workers.reconcile({ limit: 1 }, fixture.context);

    fake.failDestroy = new Error("provider unreachable");
    await expect(pass()).resolves.toEqual({ released: 0, awaitingEnsure: 0, failed: 1 });
    fake.failDestroy = null;
    await expect(pass()).resolves.toEqual({ released: 1, awaitingEnsure: 0, failed: 0 });
    expect([
      await fixture.workerStateOf(stuck.id),
      await fixture.workerStateOf(healthy.id),
    ]).toEqual(["releasing", "released"]);
    await expect(pass()).resolves.toEqual({ released: 1, awaitingEnsure: 0, failed: 0 });
    expect(await fixture.workerStateOf(stuck.id)).toBe("released");
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
