import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@rakazo/db";
import {
  claimEmptySpaceDeletionForMember,
  createThreadEvents,
  deleteEmptySpaceForMember,
  deleteOwnerVolumes,
} from "@rakazo/db";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { destroyBot } from "./child-bots.js";
import { provisionComputer } from "./computer-lifecycle.js";
import { fakeE2BMachine } from "./e2b-machine.test-support.js";
import { E2BSandboxProvider, type E2BSandboxSdk } from "./e2b-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { FakeWorkerProvider } from "./fake-worker-provider.js";
import { LocalAgentHomeStore } from "./home.js";
import { InMemoryJobQueue } from "./wakeup.js";
import { allFiles, mcpOnly, workerFixture } from "./worker-fixture.test-support.js";
import { createWorkerLifecycle, VolumeRefusedError } from "./worker-lifecycle.js";

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

  it("provisions the volume of every bot on a computer once its home is on volumes", async () => {
    const computer = await fixture.seedComputer(spaceA);
    const [ada, bob] = [
      await fixture.seedBot(spaceA, computer.id),
      await fixture.seedBot(spaceA, computer.id),
    ];
    const adaVolume = await fixture.seedVolume("bot_private", spaceA, ada.id);
    const volumes = () =>
      prisma.volume.findMany({
        where: { botId: { in: [ada.id, bob.id] } },
        select: { botId: true, providerRef: true },
        orderBy: { createdAt: "asc" },
      });

    await workers.provisionHomeVolumes(computer.id, fixture.context);
    expect(await volumes()).toEqual([{ botId: ada.id, providerRef: adaVolume.providerRef }]);
    await prisma.computer.update({ where: { id: computer.id }, data: { homeStorage: "volumes" } });
    await workers.provisionHomeVolumes(computer.id, fixture.context);
    await workers.provisionHomeVolumes(computer.id, fixture.context);

    const bobVolume = await prisma.volume.findFirstOrThrow({ where: { botId: bob.id } });
    expect(await volumes()).toEqual([
      { botId: ada.id, providerRef: adaVolume.providerRef },
      { botId: bob.id, providerRef: `fake-volume-rakazo-${bobVolume.id}` },
    ]);
    expect(fake.calls).toEqual([{ op: "ensureVolume", name: `rakazo-${bobVolume.id}` }]);
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

describe("deleting the owner of a volume", () => {
  const destroy = (
    bot: { id: string; spaceId: string },
    lifecycle: ReturnType<typeof createWorkerLifecycle> = workers,
  ) =>
    destroyBot(
      {
        prisma,
        sandbox: new FakeSandboxProvider(),
        home: new LocalAgentHomeStore(tmpdir()),
        jobs: new InMemoryJobQueue(),
        events: createThreadEvents(prisma),
        workerLifecycle: lifecycle,
      },
      { ...bot, name: "Bot", archivedAt: null },
      fixture.context,
      { deleteMemories: true },
    );

  beforeEach(() => prisma.volumeDeletion.deleteMany());

  /** A volume the fake provider holds, provisioned from its row. */
  async function provisioned(
    kind: "bot_private" | "space_shared",
    spaceId: string,
    botId: string | null,
  ) {
    const volume = await fixture.seedVolume(kind, spaceId, botId, null);
    return { ...volume, providerRef: await workers.provisionVolume(volume.id, fixture.context) };
  }

  /** Records, for each provider volume deleted, whether a row still named it then. */
  function rowsAtDeletion() {
    const seen: Array<{ providerRef: string; rowExisted: boolean }> = [];
    const deleteVolume = fake.deleteVolume.bind(fake);
    fake.deleteVolume = async (input, context) => {
      seen.push({
        providerRef: input.providerRef,
        rowExisted: (await prisma.volume.count({ where: { providerRef: input.providerRef } })) > 0,
      });
      return deleteVolume(input, context);
    };
    return seen;
  }

  const recorded = async () =>
    (await prisma.volumeDeletion.findMany({ select: { providerRef: true } })).map(
      (deletion) => deletion.providerRef,
    );

  it("destroys a bot's live worker, deletes its volume row with it, then its provider volume", async () => {
    const spaceId = await fixture.seedSpace();
    const computer = await fixture.seedComputer(spaceId, { homeStorage: "volumes" });
    const bot = await fixture.seedBot(spaceId, computer.id);
    const privateVolume = await provisioned("bot_private", spaceId, bot.id);
    const sharedVolume = await provisioned("space_shared", spaceId, null);
    const run = await fixture.seedRun(bot);
    const attempt = await fixture.seedAttempt(run.id);
    await workers.start(await fixture.launchFor(workers, attempt.id, allFiles), fixture.context);
    const deletions = rowsAtDeletion();

    await destroy(bot);

    expect(await fixture.workerStateOf(attempt.id).catch(() => "deleted with the bot")).toBe(
      "deleted with the bot",
    );
    expect(fake.live.size).toBe(0);
    expect(deletions).toEqual([{ providerRef: privateVolume.providerRef, rowExisted: false }]);
    expect(await prisma.bot.count({ where: { id: bot.id } })).toBe(0);
    expect((await prisma.volume.findMany({ where: { spaceId } })).map(({ id }) => id)).toEqual([
      sharedVolume.id,
    ]);
    expect([...fake.volumes]).toEqual([sharedVolume.providerRef]);
    expect(await recorded()).toEqual([]);
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

    await expect(destroy(bot)).rejects.toThrow("A worker may still be running");

    expect(fake.calls.map((call) => call.op)).toEqual(["ensure"]);
    expect(await prisma.volume.count({ where: { id: privateVolume.id } })).toBe(1);
    const kept = await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
    expect(kept.archivedAt).toBeInstanceOf(Date);
    finishEnsure();
    await starting.catch(() => undefined);
  });

  it("deletes a bot without a worker provider, and sweeps its volume once one is configured", async () => {
    const spaceId = await fixture.seedSpace();
    const computer = await fixture.seedComputer(spaceId, { homeStorage: "volumes" });
    const bot = await fixture.seedBot(spaceId, computer.id);
    const privateVolume = await provisioned("bot_private", spaceId, bot.id);

    await destroy(bot, createWorkerLifecycle({ prisma, provider: null }));
    expect(await prisma.volume.count({ where: { id: privateVolume.id } })).toBe(0);
    expect([...fake.volumes]).toEqual([privateVolume.providerRef]);

    expect(await workers.sweepVolumes(fixture.context)).toEqual({ deleted: 1, failed: 0 });
    expect([...fake.volumes]).toEqual([]);
    expect(await recorded()).toEqual([]);
  });

  it("deletes only this provider's recorded volumes, once, and clears a record already gone", async () => {
    const spaceId = await fixture.seedSpace();
    const kept = await provisioned("space_shared", spaceId, null);
    fake.volumes.add("fake-volume-rakazo-of-another-deployment");
    fake.volumes.add("fake-volume-rakazo-deleted");
    fake.volumes.add("rakazo-of-another-kind");
    await prisma.volumeDeletion.createMany({
      data: [
        { providerKind: "fake-worker", providerRef: "fake-volume-rakazo-deleted", volumeId: "a" },
        { providerKind: "fake-worker", providerRef: "fake-volume-rakazo-gone", volumeId: "b" },
        { providerKind: "e2b", providerRef: "rakazo-of-another-kind", volumeId: "c" },
      ],
    });

    expect(await workers.sweepVolumes(fixture.context)).toEqual({ deleted: 2, failed: 0 });
    expect(await workers.sweepVolumes(fixture.context)).toEqual({ deleted: 0, failed: 0 });

    expect([...fake.volumes].sort()).toEqual([
      kept.providerRef,
      "fake-volume-rakazo-of-another-deployment",
      "rakazo-of-another-kind",
    ]);
    expect(await recorded()).toEqual(["rakazo-of-another-kind"]);
  });

  it("records a volume whose row was deleted while the provider created it, and sweeps it", async () => {
    const spaceId = await fixture.seedSpace();
    const bot = await fixture.seedBot(spaceId, null);
    const volume = await fixture.seedVolume("bot_private", spaceId, bot.id, null);
    const ensureVolume = fake.ensureVolume.bind(fake);
    fake.ensureVolume = async (input, context) => {
      await prisma.$transaction((tx) => deleteOwnerVolumes(tx, { botId: bot.id }));
      return ensureVolume(input, context);
    };

    await expect(workers.provisionVolume(volume.id, fixture.context)).rejects.toThrow(
      new VolumeRefusedError({ code: "volume_not_found", volumeId: volume.id }),
    );
    expect(await recorded()).toEqual([`fake-volume-rakazo-${volume.id}`]);

    expect(await workers.sweepVolumes(fixture.context)).toEqual({ deleted: 1, failed: 0 });
    expect([...fake.volumes]).toEqual([]);
  });

  it("keeps the record of a volume created again while a sweep was deleting it", async () => {
    const spaceId = await fixture.seedSpace();
    const bot = await fixture.seedBot(spaceId, null);
    const volume = await fixture.seedVolume("bot_private", spaceId, bot.id, null);
    const ensureVolume = fake.ensureVolume.bind(fake);
    let resumeLate!: () => void;
    const lateEnsure = new Promise<void>((resolve) => {
      resumeLate = resolve;
    });
    let held = false;
    fake.ensureVolume = async (input, context) => {
      if (!held) {
        held = true;
        await lateEnsure;
      }
      return ensureVolume(input, context);
    };
    const late = workers.provisionVolume(volume.id, fixture.context).catch(() => undefined);
    await vi.waitFor(() => expect(held).toBe(true));
    const providerRef = await workers.provisionVolume(volume.id, fixture.context);
    await prisma.$transaction((tx) => deleteOwnerVolumes(tx, { botId: bot.id }));
    const deleteVolume = fake.deleteVolume.bind(fake);
    fake.deleteVolume = async (input, context) => {
      await deleteVolume(input, context);
      resumeLate();
      await late;
    };

    await workers.sweepVolumes(fixture.context);

    expect([...fake.volumes]).toEqual([providerRef]);
    expect(await recorded()).toEqual([providerRef]);
    fake.deleteVolume = deleteVolume;
    expect(await workers.sweepVolumes(fixture.context)).toEqual({ deleted: 1, failed: 0 });
    expect([...fake.volumes]).toEqual([]);
  });

  it("deletes an empty space with its volume rows, then its provider volume", async () => {
    const [kept, emptied] = [await fixture.seedSpace(), await fixture.seedSpace()];
    const shared = await provisioned("space_shared", emptied, null);
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

    await deleteEmptySpaceForMember(prisma, { ...input, claimId });

    expect(await prisma.space.count({ where: { id: emptied } })).toBe(0);
    expect(await prisma.volume.count({ where: { id: shared.id } })).toBe(0);
    expect(await workers.sweepVolumes(fixture.context)).toEqual({ deleted: 1, failed: 0 });
    expect(fake.volumes.has(shared.providerRef)).toBe(false);
  });
});

describe("starting a computer whose home is on volumes", () => {
  async function start(
    computer: { id: string },
    botId: string,
    machines: { existing?: ReturnType<typeof fakeE2BMachine> },
  ) {
    const replacement = fakeE2BMachine("replacement");
    const sdk = {
      create: vi.fn(async () => replacement.sandbox),
      connect: vi.fn(async () => machines.existing!.sandbox),
      pause: vi.fn(),
    } as unknown as E2BSandboxSdk;
    const home = new LocalAgentHomeStore(await mkdtemp(path.join(tmpdir(), "rakazo-homes-")));
    await provisionComputer(
      {
        prisma,
        sandbox: new E2BSandboxProvider("e2b-key", sdk),
        home,
        jobs: new InMemoryJobQueue(),
        events: createThreadEvents(prisma),
        workers: {
          provisionHomeVolumes: (id, context) => workers.provisionHomeVolumes(id, context),
        },
      },
      computer.id,
      { ...fixture.context, botId },
      "bot",
    );
    return { sdk, home };
  }

  it("mounts the volume of a bot attached after the move", async () => {
    const { computer, bot } = await fixture.migratedBot();
    const attached = await fixture.seedBot(computer.spaceId, computer.id);

    const { sdk } = await start(computer, attached.id, {});

    const attachedVolume = await prisma.volume.findFirstOrThrow({ where: { botId: attached.id } });
    expect(Object.keys(vi.mocked(sdk.create).mock.calls[0]![0].volumeMounts ?? {}).sort()).toEqual(
      [`/workspace/bots/${bot.id}`, `/workspace/bots/${attached.id}`, "/workspace/shared"].sort(),
    );
    expect(vi.mocked(sdk.create).mock.calls[0]![0].volumeMounts).toMatchObject({
      [`/workspace/bots/${attached.id}`]: `fake-volume-rakazo-${attachedVolume.id}`,
    });
  });

  it("archives the files of the machine it replaces under a key of their own", async () => {
    const { computer, bot } = await fixture.migratedBot();
    await prisma.computer.update({
      where: { id: computer.id },
      data: { providerRef: "before-move", state: "stopped" },
    });
    const existing = fakeE2BMachine("before-move", { "notes.md": "edited after the export" });

    const { home } = await start(computer, bot.id, { existing });

    const archived = [];
    for await (const file of home.exportHome(
      `${computer.homeKey}.discarded-before-move`,
      fixture.context,
    )) {
      archived.push([file.path, new TextDecoder().decode(file.content)]);
    }
    expect(archived).toEqual([["notes.md", "edited after the export"]]);
    expect(await home.list(computer.homeKey, "", fixture.context)).toEqual([]);
    expect(existing.killed).toBe(true);
  });
});
