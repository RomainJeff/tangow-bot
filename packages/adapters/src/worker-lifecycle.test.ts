import type { PrismaClient } from "@rakazo/db";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWorkerProvider } from "./fake-worker-provider.js";
import { WORKER_LIMITS } from "./runtime-worker/limits.js";
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
  it("refuses a run that needs files while its home is a snapshot", async () => {
    const computer = await fixture.seedComputer(spaceA);
    const bot = await fixture.seedBot(spaceA, computer.id);
    const attempt = await fixture.seedAttempt((await fixture.seedRun(bot)).id);

    await expect(
      workers.plan({
        attemptId: attempt.id,
        needs: { files: { private: "rw", shared: null }, computer: "none" },
      }),
    ).resolves.toEqual({ mode: "refused", refusal: { code: "home_move_pending" } });
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
  it("gives an MCP-only run a worker without a computer or mount", async () => {
    const computer = await fixture.seedComputer(spaceA);
    const bot = await fixture.seedBot(spaceA, computer.id);
    const run = await fixture.seedRun(bot);
    const attempt = await fixture.seedAttempt(run.id);

    const launch = await fixture.launchFor(workers, attempt.id, mcpOnly);
    const started = await workers.start(launch, fixture.context);

    expect(launch.volumes).toEqual([]);
    expect(launch.computer).toEqual({ mode: "none" });
    expect(started).toEqual({
      providerRef: `fake-worker-${attempt.id}`,
      start: {
        version: 2,
        kind: "worker.start",
        worker: { runId: run.id, attemptId: attempt.id, fence: 1 },
        workspace: { cwd: "/workspace", mounts: [] },
        computer: "none",
      },
    });
    expect(fake.calls[0]).toMatchObject({
      op: "ensure",
      spec: { mounts: [], ttlSeconds: 3_600 },
    });
    expect(await prisma.computerExecutionLease.count({ where: { computerId: computer.id } })).toBe(
      0,
    );
    expect(await fixture.workerStateOf(attempt.id)).toBe("ready");
  });

  it("mounts the bot's volumes at fixed paths without telling the guest which volume", async () => {
    const { bot, privateVolume, sharedVolume } = await fixture.migratedBot();
    const attempt = await fixture.seedAttempt((await fixture.seedRun(bot)).id);

    const started = await workers.start(
      await fixture.launchFor(workers, attempt.id, allFiles),
      fixture.context,
    );
    const { workerEnsureAt } = await prisma.attempt.findUniqueOrThrow({
      where: { id: attempt.id },
      select: { workerEnsureAt: true },
    });

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
        ttlSeconds: 3_600,
        ensureDeadline: new Date(workerEnsureAt!.getTime() + 900_000),
      },
    });
    expect(started.start.workspace).toEqual({
      cwd: `/workspace/bots/${bot.id}`,
      mounts: [
        { path: `/workspace/bots/${bot.id}`, scope: "private", access: "rw" },
        { path: "/workspace/shared", scope: "shared", access: "rw" },
      ],
    });
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
  });

  it("starts two file runs of the same bot on the same persistent mounts", async () => {
    const { bot, privateVolume, sharedVolume } = await fixture.migratedBot();
    const first = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    const second = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    const firstStarted = await workers.start(
      await fixture.launchFor(workers, first.id, allFiles),
      fixture.context,
    );
    const secondStarted = await workers.start(
      await fixture.launchFor(workers, second.id, allFiles),
      fixture.context,
    );

    const mounts = [
      { volumeRef: privateVolume.providerRef, path: `/workspace/bots/${bot.id}`, access: "rw" },
      { volumeRef: sharedVolume.providerRef, path: "/workspace/shared", access: "rw" },
    ];
    expect([...fake.live.values()].map((spec) => spec.mounts)).toEqual([mounts, mounts]);
    for (const started of [firstStarted, secondStarted]) {
      expect(started.start.workspace).toEqual({
        cwd: `/workspace/bots/${bot.id}`,
        mounts: [
          { path: `/workspace/bots/${bot.id}`, scope: "private", access: "rw" },
          { path: "/workspace/shared", scope: "shared", access: "rw" },
        ],
      });
    }
    expect([await fixture.workerStateOf(first.id), await fixture.workerStateOf(second.id)]).toEqual(
      ["ready", "ready"],
    );

    await workers.release(first.id, fixture.context);
    expect([...fake.live.keys()]).toEqual([secondStarted.providerRef]);
    expect(await fixture.workerStateOf(second.id)).toBe("ready");
  });

  it("lets two bots of one space write the shared volume at once", async () => {
    const { computer, bot } = await fixture.migratedBot();
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
    expect(fake.live.size).toBe(2);
  });

  it("destroys the worker when setup fails", async () => {
    const { bot } = await fixture.migratedBot();
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
    expect(fake.live.size).toBe(0);
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

  it("tracks a run cancelled mid-ensure until its late VM is destroyed", async () => {
    const ensure = fake.ensure.bind(fake);
    const atEnsureReturn: unknown[] = [];
    fake.ensure = async (spec, context) => {
      const created = await ensure(spec, context);
      atEnsureReturn.push({
        live: [...fake.live.keys()],
        state: await fixture.workerStateOf(spec.attemptId),
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
    expect(atEnsureReturn).toEqual([{ live: [`fake-worker-${attempt.id}`], state: "releasing" }]);
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

  it("tracks a worker the provider cannot confirm destroyed without blocking other runs", async () => {
    const { bot } = await fixture.migratedBot();
    const attempt = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    await workers.start(await fixture.launchFor(workers, attempt.id, allFiles), fixture.context);
    fake.failDestroy = new Error("provider unreachable");

    await expect(workers.release(attempt.id, fixture.context)).rejects.toThrow(
      "provider unreachable",
    );
    expect(await fixture.workerStateOf(attempt.id)).toBe("releasing");
    expect([...fake.live.keys()]).toEqual([`fake-worker-${attempt.id}`]);
    const peer = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    await workers.start(await fixture.launchFor(workers, peer.id, allFiles), fixture.context);

    fake.failDestroy = null;
    await expect(workers.reconcile({ limit: 10 }, fixture.context)).resolves.toEqual({
      released: 1,
      awaitingEnsure: 0,
      failed: 0,
    });
    expect([...fake.live.keys()]).toEqual([`fake-worker-${peer.id}`]);
    expect(await fixture.workerStateOf(peer.id)).toBe("ready");
    expect(await fixture.workerStateOf(attempt.id)).toBe("released");
  });
});

describe("worker fence", () => {
  it("keeps a run paused on the user its attempt's without letting it act, and drops a superseded attempt", async () => {
    const { bot } = await fixture.migratedBot();
    const run = await fixture.seedRun(bot, { leaseFence: 2, status: "running" });
    const superseded = await fixture.seedAttempt(run.id, 1);
    const current = await fixture.seedAttempt(run.id, 2);
    await workers.start(await fixture.launchFor(workers, current.id, mcpOnly), fixture.context);
    const standing: Record<string, [boolean, boolean]> = {};
    for (const status of ["running", "waiting_input", "waiting_takeover", "cancelled"]) {
      await prisma.run.update({ where: { id: run.id }, data: { status } });
      standing[status] = [
        (await workers.status(current.id))?.active === true,
        await workers.ownsFence(current.id),
      ];
    }
    expect(standing).toEqual({
      running: [true, true],
      waiting_input: [false, true],
      waiting_takeover: [false, true],
      cancelled: [false, false],
    });

    await prisma.run.update({ where: { id: run.id }, data: { status: "waiting_input" } });
    expect(await workers.ownsFence(superseded.id)).toBe(false);
    await workers.release(current.id, fixture.context);
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
    const { bot } = await fixture.migratedBot();
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
    const spec = {
      runId: "run",
      botId: bot.id,
      mounts: [],
      ttlSeconds: 60,
      ensureDeadline: new Date(),
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
    expect([
      await fixture.workerStateOf(created.id),
      await fixture.workerStateOf(requested.id),
    ]).toEqual(["released", "released"]);
    expect(await fixture.workerStateOf(active.id)).toBe("ready");
  });

  it.each([
    ["waiting_input", "waiting_input", "ready", 1, true],
    ["waiting_takeover", "waiting_takeover", "ready", 1, true],
    ["queued", "waiting_input", "ready", 1, true],
    ["cancelled", "waiting_input", "ready", 1, false],
    ["waiting_input", "waiting_input", "ready", 2, false],
    ["waiting_input", "waiting_input", "releasing", 1, false],
    ["queued", "setup_failed", "ready", 1, false],
  ])(
    "reclaims %s/%s worker %s with fence %i, protecting a recent pause=%s",
    async (status, attemptStatus, workerState, leaseFence, protectedPause) => {
      const { bot } = await fixture.migratedBot();
      const run = await fixture.seedRun(bot);
      const attempt = await fixture.seedAttempt(run.id);
      await workers.start(await fixture.launchFor(workers, attempt.id, mcpOnly), fixture.context);
      const pausedAt = new Date();
      await prisma.run.update({
        where: { id: run.id },
        data: { status, leaseFence, leaseOwner: null, leaseExpiresAt: null },
      });
      await prisma.attempt.update({
        where: { id: attempt.id },
        data: {
          status: attemptStatus,
          workerState,
          finishedAt: pausedAt,
          workerStateAt: new Date(pausedAt.getTime() - 600_000),
        },
      });
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const deadline =
          pausedAt.getTime() + WORKER_LIMITS.pausedGraceMs + WORKER_LIMITS.stopConfirmMs;
        vi.setSystemTime(deadline - 1);
        await workers.reconcile({ limit: 100 }, fixture.context);
        expect(fake.live.has(`fake-worker-${attempt.id}`)).toBe(protectedPause);
        expect(await fixture.workerStateOf(attempt.id)).toBe(protectedPause ? "ready" : "released");

        vi.setSystemTime(deadline);
        await workers.reconcile({ limit: 100 }, fixture.context);
        expect(fake.live.has(`fake-worker-${attempt.id}`)).toBe(false);
        expect(await fixture.workerStateOf(attempt.id)).toBe("released");
      } finally {
        vi.useRealTimers();
      }
    },
  );

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
      version: 2,
      kind: "worker.status",
      worker: { runId: run.id, attemptId: attempt.id, fence: 1 },
      state: "ready",
      providerRef: `fake-worker-${attempt.id}`,
      active: false,
    });
  });
});
