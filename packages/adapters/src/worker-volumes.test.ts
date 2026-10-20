import type { PrismaClient } from "@rakazo/db";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeWorkerProvider } from "./fake-worker-provider.js";
import { mcpOnly, workerFixture } from "./worker-fixture.test-support.js";
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

async function adopt(computerId: string) {
  return workers.adoptVolumeHome(computerId, (await workers.inspectHomeMove(computerId)).start);
}

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

    await expect(adopt(computer.id)).resolves.toBe("volume_missing");
    await prisma.volume.update({ where: { id: bobVolume.id }, data: { providerRef: "bob" } });
    await expect(adopt(computer.id)).resolves.toBe("volume_missing");
    await fixture.seedVolume("space_shared", space, null);
    const busy = await fixture.seedAttempt((await fixture.seedRun(ada)).id);
    await prisma.volume.update({ where: { id: adaVolume.id }, data: { writerAttemptId: busy.id } });
    await expect(adopt(computer.id)).resolves.toBe("volume_busy");
    expect(await homeStorage()).toBe("snapshot");

    await prisma.volume.update({ where: { id: adaVolume.id }, data: { writerAttemptId: null } });
    const dedicatedBot = await fixture.seedBot(space, null);
    const elsewhere = await fixture.seedAttempt((await fixture.seedRun(dedicatedBot)).id);
    await workers.start(await fixture.launchFor(workers, elsewhere.id, mcpOnly), fixture.context);
    await expect(adopt(computer.id)).resolves.toBe("space_worker_live");
    expect(await homeStorage()).toBe("snapshot");

    await workers.release(elsewhere.id, fixture.context);
    await expect(adopt(computer.id)).resolves.toBe("adopted");
    await expect(adopt(computer.id)).resolves.toBe("adopted");
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
    await expect(adopt(computer.id)).resolves.toBe("computer_active");
    await update({ state: "suspended", controlHolder: "user" });
    await expect(adopt(computer.id)).resolves.toBe("computer_active");
    await update({ controlHolder: "none" });
    await lease(new Date(Date.now() + 60_000));
    await expect(adopt(computer.id)).resolves.toBe("computer_active");

    await lease(new Date(Date.now() - 60_000));
    await expect(adopt(computer.id)).resolves.toBe("adopted");
  });

  it("provisions the private volume of a bot attached once its computer's home is on volumes", async () => {
    const computer = await fixture.seedComputer(spaceA);
    const bot = await fixture.seedBot(spaceA, computer.id);

    const beforeAdoption = await workers.provisionAttachedBotVolume(bot.id, fixture.context);
    await prisma.computer.update({ where: { id: computer.id }, data: { homeStorage: "volumes" } });
    const attached = await workers.provisionAttachedBotVolume(bot.id, fixture.context);
    const again = await workers.provisionAttachedBotVolume(bot.id, fixture.context);

    const volume = await prisma.volume.findFirstOrThrow({ where: { botId: bot.id } });
    expect(beforeAdoption).toBeNull();
    expect(attached).toEqual({
      volumeId: volume.id,
      providerRef: `fake-volume-rakazo-${volume.id}`,
    });
    expect(again).toEqual(attached);
    expect(volume.kind).toBe("bot_private");
  });

  it("never adopts a home on a computer kind without workers", async () => {
    const computer = await fixture.seedComputer(spaceA, { kind: "docker", scope: "dedicated" });
    const bot = await fixture.seedBot(spaceA, computer.id);
    await fixture.seedVolume("bot_private", spaceA, bot.id);

    await expect(adopt(computer.id)).resolves.toBe("computer_kind_unsupported");
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
