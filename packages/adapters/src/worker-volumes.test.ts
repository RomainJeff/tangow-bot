import { tmpdir } from "node:os";
import type { PrismaClient } from "@rakazo/db";
import {
  claimEmptySpaceDeletionForMember,
  createThreadEvents,
  deleteEmptySpaceForMember,
} from "@rakazo/db";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { destroyBot } from "./child-bots.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { FakeWorkerProvider } from "./fake-worker-provider.js";
import { LocalAgentHomeStore } from "./home.js";
import { InMemoryJobQueue } from "./wakeup.js";
import { allFiles, workerFixture } from "./worker-fixture.test-support.js";
import { createWorkerLifecycle } from "./worker-lifecycle.js";

let database: PgliteDatabase;
let prisma: PrismaClient;
let fake: FakeWorkerProvider;
let workers: ReturnType<typeof createWorkerLifecycle>;
let fixture: ReturnType<typeof workerFixture>;
let spaceA: string;

beforeAll(async () => {
  database = await openPgliteDatabase();
  prisma = database.prisma;
  fixture = workerFixture(prisma);
  await fixture.seedOwner();
  spaceA = await fixture.seedSpace();
});
afterAll(() => database.close());
beforeEach(() => {
  fake = new FakeWorkerProvider();
  workers = createWorkerLifecycle({ prisma, provider: fake });
});

describe("volume provisioning and home adoption", () => {
  it("creates a volume at the provider once and records its ref", async () => {
    const bot = await fixture.seedBot(spaceA, null);
    const volume = await fixture.seedVolume("bot_private", spaceA, bot.id, null);

    const refs = [
      await workers.provisionVolume(volume.id, fixture.context),
      await workers.provisionVolume(volume.id, fixture.context),
    ];

    expect(refs).toEqual([`fake-volume-rakazo-${volume.id}`, `fake-volume-rakazo-${volume.id}`]);
    expect(fake.calls).toEqual([{ op: "ensureVolume", name: `rakazo-${volume.id}` }]);
    expect((await prisma.volume.findUniqueOrThrow({ where: { id: volume.id } })).providerRef).toBe(
      `fake-volume-rakazo-${volume.id}`,
    );
  });

  it("adopts a team home only when every bot and the space have a free provisioned volume", async () => {
    const space = await fixture.seedSpace();
    const computer = await fixture.seedComputer(space);
    const [ada, bob] = [
      await fixture.seedBot(space, computer.id),
      await fixture.seedBot(space, computer.id),
    ];
    const adaVolume = await fixture.seedVolume("bot_private", space, ada.id);
    const bobVolume = await fixture.seedVolume("bot_private", space, bob.id, null);
    const homeStorage = async () =>
      (await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })).homeStorage;

    await expect(workers.adoptVolumeHome(computer.id)).resolves.toBe("volume_missing");
    await prisma.volume.update({ where: { id: bobVolume.id }, data: { providerRef: "bob" } });
    await expect(workers.adoptVolumeHome(computer.id)).resolves.toBe("volume_missing");
    await fixture.seedVolume("space_shared", space, null);
    const busy = await fixture.seedAttempt((await fixture.seedRun(ada)).id);
    await prisma.volume.update({ where: { id: adaVolume.id }, data: { writerAttemptId: busy.id } });
    await expect(workers.adoptVolumeHome(computer.id)).resolves.toBe("volume_busy");
    expect(await homeStorage()).toBe("snapshot");

    await prisma.volume.update({ where: { id: adaVolume.id }, data: { writerAttemptId: null } });
    await expect(workers.adoptVolumeHome(computer.id)).resolves.toBe("adopted");
    await expect(workers.adoptVolumeHome(computer.id)).resolves.toBe("adopted");
    expect(await homeStorage()).toBe("volumes");
  });

  it("adopts a home only once nothing runs on its computer", async () => {
    const computer = await fixture.seedComputer(spaceA, { scope: "dedicated" });
    const bot = await fixture.seedBot(spaceA, computer.id);
    await fixture.seedVolume("bot_private", spaceA, bot.id);
    const run = await fixture.seedRun(bot);
    const update = (data: Record<string, string>) =>
      prisma.computer.update({ where: { id: computer.id }, data });
    const lease = (expiresAt: Date) =>
      prisma.computerExecutionLease.upsert({
        where: { computerId_botId: { computerId: computer.id, botId: bot.id } },
        create: { computerId: computer.id, botId: bot.id, runId: run.id, expiresAt },
        update: { expiresAt },
      });

    await update({ state: "running" });
    await expect(workers.adoptVolumeHome(computer.id)).resolves.toBe("computer_active");
    await update({ state: "suspended", controlHolder: "user" });
    await expect(workers.adoptVolumeHome(computer.id)).resolves.toBe("computer_active");
    await update({ controlHolder: "none" });
    await lease(new Date(Date.now() + 60_000));
    await expect(workers.adoptVolumeHome(computer.id)).resolves.toBe("computer_active");

    await lease(new Date(Date.now() - 60_000));
    await expect(workers.adoptVolumeHome(computer.id)).resolves.toBe("adopted");
  });

  it("never adopts a home on a computer kind without workers", async () => {
    const computer = await fixture.seedComputer(spaceA, { kind: "docker", scope: "dedicated" });
    const bot = await fixture.seedBot(spaceA, computer.id);
    await fixture.seedVolume("bot_private", spaceA, bot.id);

    await expect(workers.adoptVolumeHome(computer.id)).resolves.toBe("computer_kind_unsupported");
  });
});

describe("worker schema", () => {
  it.each([
    [
      "attempts_runId_live_worker_key",
      async (runId: string) => {
        const live = { workerState: "requested", workerProviderKind: "fake-worker" };
        await fixture.seedAttempt(runId, 1, {
          ...live,
          workerStateAt: new Date(),
          workerEnsureAt: new Date(),
        });
        await prisma.$executeRaw`INSERT INTO attempts (id, "runId", fence, status, "workerState",
          "workerProviderKind", "workerStateAt", "workerEnsureAt")
          VALUES (${fixture.unique("attempt")}, ${runId}, 2, 'running', 'requested', 'fake-worker',
            now(), now())`;
      },
    ],
    [
      "attempts_runId_fence_key",
      async (runId: string) => {
        await fixture.seedAttempt(runId, 1);
        await prisma.$executeRaw`INSERT INTO attempts (id, "runId", fence, status)
          VALUES (${fixture.unique("attempt")}, ${runId}, 1, 'running')`;
      },
    ],
    [
      "attempts_worker_shape_check",
      (runId: string) =>
        prisma.$executeRaw`INSERT INTO attempts (id, "runId", fence, status, "workerState",
          "workerProviderKind", "workerStateAt", "workerEnsureAt")
          VALUES (${fixture.unique("attempt")}, ${runId}, 1, 'running', 'created', 'fake-worker',
            now(), now())`,
    ],
    [
      "computers_home_storage_check",
      (_runId: string) =>
        prisma.$executeRaw`INSERT INTO computers (id, "spaceId", "userId", "scopeKey", "homeKey",
          kind, "homeStorage", "updatedAt")
          VALUES (${fixture.unique("computer")}, ${spaceA}, ${fixture.userId}, ${fixture.unique("scope")},
            ${fixture.unique("home")}, 'docker', 'volumes', now())`,
    ],
  ])("rejects a row that breaks %s", async (constraint, write) => {
    const run = await fixture.seedRun(await fixture.seedBot(spaceA, null));

    await expect(write(run.id)).rejects.toThrow(constraint);
  });

  it("rejects a second private volume for one bot", async () => {
    const bot = await fixture.seedBot(spaceA, null);
    await fixture.seedVolume("bot_private", spaceA, bot.id);

    await expect(
      prisma.$executeRaw`INSERT INTO volumes (id, kind, "spaceId", "botId", "providerKind",
        "updatedAt") VALUES (${fixture.unique("volume")}, 'bot_private', ${spaceA}, ${bot.id}, 'fake-worker', now())`,
    ).rejects.toThrow("volumes_botId_private_key");
  });

  it("deletes a space without volumes, and refuses one that still owns a volume", async () => {
    const [empty, owner] = [await fixture.seedSpace(), await fixture.seedSpace()];
    for (const id of [empty, owner]) await fixture.seedComputer(id);
    await fixture.seedVolume("space_shared", owner, null);

    await prisma.space.delete({ where: { id: empty } });
    await expect(prisma.space.delete({ where: { id: owner } })).rejects.toThrow();
    expect(await prisma.space.count({ where: { id: { in: [empty, owner] } } })).toBe(1);
  });
});

describe("deleting the owner of a volume", () => {
  const destroy = (bot: { id: string; spaceId: string }) =>
    destroyBot(
      {
        prisma,
        sandbox: new FakeSandboxProvider(),
        home: new LocalAgentHomeStore(tmpdir()),
        jobs: new InMemoryJobQueue(),
        events: createThreadEvents(prisma),
        workerLifecycle: workers,
      },
      { ...bot, name: "Bot", archivedAt: null },
      fixture.context,
      { deleteMemories: true },
    );

  it("destroys a bot's live worker, then its volume, then the bot, and keeps the space's", async () => {
    const { bot, privateVolume, sharedVolume } = await fixture.migratedBot();
    const run = await fixture.seedRun(bot);
    const attempt = await fixture.seedAttempt(run.id);
    await workers.start(await fixture.launchFor(workers, attempt.id, allFiles), fixture.context);

    await destroy(bot);

    expect(fake.calls.filter((call) => call.op !== "ensure" && call.op !== "prepare")).toEqual([
      {
        op: "destroy",
        attemptId: attempt.id,
        providerRef: `fake-worker-${attempt.id}`,
        result: "destroyed",
      },
      { op: "deleteVolume", volumeRef: privateVolume.providerRef },
    ]);
    expect(await prisma.bot.count({ where: { id: bot.id } })).toBe(0);
    expect(
      (await prisma.volume.findMany({ where: { spaceId: bot.spaceId } })).map(({ id }) => id),
    ).toEqual([sharedVolume.id]);
  });

  it("keeps a bot whose worker may still be starting, with its volume", async () => {
    const { bot, privateVolume } = await fixture.migratedBot();
    const run = await fixture.seedRun(bot);
    const attempt = await fixture.seedAttempt(run.id);
    const finishEnsure = fake.holdEnsure();
    const starting = workers.start(
      await fixture.launchFor(workers, attempt.id, allFiles),
      fixture.context,
    );
    await vi.waitFor(() => expect(fake.calls.map((call) => call.op)).toEqual(["ensure"]));

    await expect(destroy(bot)).rejects.toThrow("may still be starting");

    expect(fake.calls.map((call) => call.op)).toEqual(["ensure"]);
    expect(await prisma.bot.count({ where: { id: bot.id } })).toBe(1);
    expect(await prisma.volume.count({ where: { id: privateVolume.id } })).toBe(1);
    finishEnsure();
    await starting.catch(() => undefined);
  });

  it("deletes an empty space once its shared volume is gone at the provider", async () => {
    const [kept, emptied] = [await fixture.seedSpace(), await fixture.seedSpace()];
    const shared = await fixture.seedVolume("space_shared", emptied, null);
    const { organizationId } = await prisma.space.findUniqueOrThrow({ where: { id: kept } });
    await prisma.member.create({
      data: {
        id: fixture.unique("member"),
        organizationId,
        userId: fixture.userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    for (const spaceId of [kept, emptied]) {
      await prisma.spaceMember.create({
        data: {
          id: fixture.unique("space-member"),
          spaceId,
          organizationId,
          userId: fixture.userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
    }
    const input = { currentSpaceId: kept, userId: fixture.userId, spaceId: emptied };
    const { claimId } = await claimEmptySpaceDeletionForMember(prisma, input);

    const volumeIds = await workers.retireOwner({ spaceId: emptied }, fixture.context);
    await deleteEmptySpaceForMember(prisma, { ...input, claimId, volumeIds });

    expect(fake.calls).toEqual([{ op: "deleteVolume", volumeRef: shared.providerRef }]);
    expect(await prisma.space.count({ where: { id: emptied } })).toBe(0);
  });
});
