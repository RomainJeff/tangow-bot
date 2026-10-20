import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, PortableFile } from "@rakazo/adapter-kit";
import { AgentRuntimeBusyError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createThreadEvents } from "@rakazo/db";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerBusyError, provisionComputer } from "./computer-lifecycle.js";
import { checkpointComputerWorkspace, restoreComputerWorkspace } from "./computer-workspace.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { MemoryVolumeFiles } from "./fake-volume-files.js";
import { FakeWorkerProvider } from "./fake-worker-provider.js";
import { LocalAgentHomeStore } from "./home.js";
import type { HomeMoveOptions } from "./home-volume-migration.js";
import { moveHomeToVolumes } from "./home-volume-migration.js";
import { createJobReconciler } from "./job-reconciler.js";
import { InMemoryJobQueue } from "./wakeup.js";
import { composeWorkers } from "./worker-composition.js";
import { allFiles, mcpOnly, workerFixture } from "./worker-fixture.test-support.js";
import { createWorkerLifecycle } from "./worker-lifecycle.js";

let database: PgliteDatabase;
let prisma: PrismaClient;
let fixture: ReturnType<typeof workerFixture>;
let root: string;
let home: LocalAgentHomeStore;
let volumeFiles: MemoryVolumeFiles;
let provider: FakeWorkerProvider;

const text = new TextEncoder();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
  database = await openPgliteDatabase();
  prisma = database.prisma;
  fixture = workerFixture(prisma);
  await fixture.seedOwner();
});
afterAll(() => database.close());
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rakazo-home-move-"));
  home = new LocalAgentHomeStore(root);
  volumeFiles = new MemoryVolumeFiles();
  provider = new FakeWorkerProvider();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function move(
  computerId: string,
  options: Partial<Omit<HomeMoveOptions, "computerId">> = {},
  files = volumeFiles,
) {
  return moveHomeToVolumes(
    { prisma, home, files, workers: createWorkerLifecycle({ prisma, provider }) },
    { computerId, dryRun: false, leaveUnmapped: false, manifestPath: null, ...options },
    fixture.context,
  );
}

async function seedHome(
  homeKey: string,
  files: Record<string, string>,
  modes: Record<string, number> = {},
) {
  const staging = await mkdtemp(path.join(tmpdir(), "rakazo-home-seed-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(staging, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { mode: modes[file] ?? 0o644 });
    }
    await home.commit(homeKey, staging, fixture.context);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function homeFiles(homeKey: string) {
  const files: Record<string, string> = {};
  for await (const file of home.exportHome(homeKey, fixture.context)) {
    files[file.path] = new TextDecoder().decode(file.content);
  }
  return files;
}

/** Each volume's files as `path: content`, followed by the mode when it is not 0644. */
async function volumeContents() {
  const contents: Record<string, Record<string, string>> = {};
  for (const [ref, files] of volumeFiles.volumes) {
    contents[ref] = Object.fromEntries(
      [...files].map(([file, stored]) => [
        file,
        `${new TextDecoder().decode(stored.content)}${stored.mode === 0o644 ? "" : ` (${stored.mode.toString(8)})`}`,
      ]),
    );
  }
  return contents;
}

async function volumeRef(where: { botId: string } | { spaceId: string; kind: "space_shared" }) {
  const volume = await prisma.volume.findFirstOrThrow({ where });
  return `rakazo-${volume.id}`;
}

async function homeStorageOf(computerId: string) {
  return (await prisma.computer.findUniqueOrThrow({ where: { id: computerId } })).homeStorage;
}

async function teamHome() {
  const spaceId = await fixture.seedSpace();
  const computer = await fixture.seedComputer(spaceId, { scope: "team" });
  const ada = await fixture.seedBot(spaceId, computer.id);
  const bob = await fixture.seedBot(spaceId, computer.id);
  await prisma.bot.update({ where: { id: bob.id }, data: { archivedAt: new Date() } });
  await seedHome(
    computer.homeKey,
    {
      [`bots/${ada.id}/notes.md`]: "ada notes",
      [`bots/${bob.id}/bin/run.sh`]: "echo bob",
      "shared/plan.md": "the plan",
      ".browser-profiles/chromium/Cache/blob": "cache",
    },
    { [`bots/${ada.id}/notes.md`]: 0o600, [`bots/${bob.id}/bin/run.sh`]: 0o755 },
  );
  return { spaceId, computer, ada, bob };
}

describe("moving a home from snapshots to volumes", () => {
  it("blocks planning and a previously planned worker during a copy, then adopts and releases the fence", async () => {
    const { spaceId, computer } = await teamHome();
    const bot = await fixture.seedBot(spaceId, null);
    const attempt = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    const workers = createWorkerLifecycle({ prisma, provider });
    const launch = await fixture.launchFor(workers, attempt.id, mcpOnly);
    let checked = false;
    class LaunchDuringCopy extends MemoryVolumeFiles {
      override async write(ref: string, file: PortableFile, context: AdapterContext) {
        if (!checked) {
          checked = true;
          expect(await workers.plan({ attemptId: attempt.id, needs: mcpOnly })).toEqual({
            mode: "busy",
            reason: "home_moving",
          });
          await expect(workers.start(launch, fixture.context)).rejects.toBeInstanceOf(
            AgentRuntimeBusyError,
          );
          const added = await fixture.seedComputer(spaceId, { homeStorage: "volumes" });
          for (const target of [computer, added])
            await expect(
              provisionComputer(
                {
                  prisma,
                  home,
                  sandbox: new FakeSandboxProvider(),
                  jobs: new InMemoryJobQueue(),
                  events: createThreadEvents(prisma),
                },
                target.id,
                fixture.context,
              ),
            ).rejects.toBeInstanceOf(ComputerBusyError);
        }
        return super.write(ref, file, context);
      }
    }
    volumeFiles = new LaunchDuringCopy();
    expect((await move(computer.id)).outcome).toBe("adopted");
    expect(checked).toBe(true);
    expect(await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })).toMatchObject({
      homeStorage: "volumes",
      maintenanceId: null,
    });
    await workers.start(launch, fixture.context);
    expect(await fixture.workerStateOf(attempt.id)).toBe("ready");
    await workers.release(attempt.id, fixture.context);
  });

  it("keeps unrelated worker launches and computer boots available during a dedicated move", async () => {
    const { computer: sibling, bot: otherBot } = await fixture.migratedBot();
    const source = await fixture.seedComputer(sibling.spaceId, { scope: "dedicated" });
    const bot = await fixture.seedBot(sibling.spaceId, source.id);
    const own = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    const other = await fixture.seedAttempt((await fixture.seedRun(otherBot)).id);
    const workers = createWorkerLifecycle({ prisma, provider });
    const ownLaunch = await fixture.launchFor(workers, own.id, mcpOnly);
    const otherLaunch = await fixture.launchFor(workers, other.id, allFiles);
    const reservation = await workers.reserveHomeMove(source.id);
    if (!("marker" in reservation)) throw new Error(reservation.blocker);
    try {
      expect(await workers.plan({ attemptId: own.id, needs: mcpOnly })).toEqual({
        mode: "busy",
        reason: "home_moving",
      });
      await expect(workers.start(ownLaunch, fixture.context)).rejects.toBeInstanceOf(
        AgentRuntimeBusyError,
      );
      expect((await workers.plan({ attemptId: other.id, needs: allFiles })).mode).toBe("worker");
      await workers.start(otherLaunch, fixture.context);
      await provisionComputer(
        {
          prisma,
          home,
          sandbox: new (class extends FakeSandboxProvider {
            override async provision(...args: Parameters<FakeSandboxProvider["provision"]>) {
              return { ...(await super.provision(...args)), kind: "e2b" as const };
            }
          })(),
          jobs: new InMemoryJobQueue(),
          events: createThreadEvents(prisma),
        },
        sibling.id,
        fixture.context,
      );
      expect(await fixture.workerStateOf(other.id)).toBe("ready");
      expect((await prisma.computer.findUniqueOrThrow({ where: { id: sibling.id } })).state).toBe(
        "running",
      );
    } finally {
      await workers.releaseHomeMove(reservation.marker);
    }
  });

  it("times out a hung renewal and cancels copying before the reservation can expire", async () => {
    const { computer } = await teamHome();
    const workers = createWorkerLifecycle({ prisma, provider });
    const renewal = deferred<boolean>();
    vi.spyOn(workers, "renewHomeMove").mockReturnValue(renewal.promise);
    const reading = deferred<AbortSignal>();
    const continueRead = deferred<void>();
    class WaitingForRead extends MemoryVolumeFiles {
      override async list(ref: string, context: AdapterContext) {
        reading.resolve(context.signal);
        await continueRead.promise;
        return super.list(ref, context);
      }
    }
    volumeFiles = new WaitingForRead();
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"],
    });
    const result = moveHomeToVolumes(
      { prisma, home, files: volumeFiles, workers },
      { computerId: computer.id, dryRun: false, leaveUnmapped: false, manifestPath: null },
      fixture.context,
    ).catch((error: unknown) => error);
    const signal = await reading.promise;
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(signal.aborted).toBe(true);
      expect(performance.now()).toBeLessThan(60_000);
    } finally {
      continueRead.resolve();
      renewal.resolve(false);
      await result;
    }
    expect(await result).toBeInstanceOf(Error);
    expect(volumeFiles.volumes.size).toBe(0);
    expect(await homeStorageOf(computer.id)).toBe("snapshot");
  });

  it("refuses the next write after its monotonic deadline even before timer callbacks run", async () => {
    const { computer } = await teamHome();
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    class PausedProcess extends MemoryVolumeFiles {
      override async list(ref: string, context: AdapterContext) {
        elapsed = 60_000;
        return super.list(ref, context);
      }
    }
    volumeFiles = new PausedProcess();
    await expect(move(computer.id)).rejects.toThrow("Home move reservation expired");
    expect(volumeFiles.volumes.size).toBe(0);
    expect(await homeStorageOf(computer.id)).toBe("snapshot");
  });

  it("automatically releases an expired reservation in reconciliation, then resumes", async () => {
    const { computer } = await teamHome();
    const workers = createWorkerLifecycle({ prisma, provider });
    const reservation = await workers.reserveHomeMove(computer.id);
    if (!("marker" in reservation)) throw new Error(reservation.blocker);
    expect(await move(computer.id)).toMatchObject({
      outcome: "refused",
      refusal: { code: "computer_active" },
    });
    await prisma.$executeRaw`UPDATE computers SET "homeMoveExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second'
      WHERE "maintenanceId" = ${reservation.marker}`;
    await createJobReconciler({
      prisma,
      jobs: new InMemoryJobQueue(),
      reconcileWorkers: composeWorkers(prisma, null).reconcileWorkers,
    }).reconcileOnce();
    expect((await move(computer.id)).outcome).toBe("adopted");
  });

  it("dry-run and copy both refuse a sibling's maintenance reservation without changing it", async () => {
    const { spaceId, computer } = await teamHome();
    const sibling = await fixture.seedComputer(spaceId);
    await prisma.computer.update({
      where: { id: sibling.id },
      data: { maintenanceId: "another-maintenance" },
    });
    for (const dryRun of [true, false]) {
      expect(await move(computer.id, { dryRun })).toMatchObject({
        outcome: "refused",
        refusal: { code: "computer_active" },
      });
    }
    expect(
      (await prisma.computer.findUniqueOrThrow({ where: { id: sibling.id } })).maintenanceId,
    ).toBe("another-maintenance");
  });

  it("does not clear a live reservation or claim to clear an unmatched one", async () => {
    const { computer } = await teamHome();
    const workers = createWorkerLifecycle({ prisma, provider });
    expect(await workers.clearStaleHomeMove(computer.id)).toBe(false);
    const reservation = await workers.reserveHomeMove(computer.id);
    if (!("marker" in reservation)) throw new Error(reservation.blocker);
    expect(await workers.clearStaleHomeMove(computer.id)).toBe(false);
    expect(await move(computer.id)).toMatchObject({
      outcome: "refused",
      refusal: { code: "computer_active" },
    });
    await prisma.$executeRaw`UPDATE computers SET "homeMoveExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second'
      WHERE "maintenanceId" = ${reservation.marker}`;
    expect(await workers.clearStaleHomeMove(computer.id)).toBe(true);
    expect(await workers.clearStaleHomeMove(computer.id)).toBe(false);
  });

  it("renews a reservation during a long copy so reconciliation cannot release the live owner", async () => {
    const { computer } = await teamHome();
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"],
    });
    const workers = createWorkerLifecycle({ prisma, provider });
    let checked = false;
    class SlowCopy extends MemoryVolumeFiles {
      override async write(ref: string, file: PortableFile, context: AdapterContext) {
        if (!checked) {
          checked = true;
          const initial = await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } });
          for (let tick = 0; tick < 8; tick++) {
            await prisma.$executeRaw`UPDATE computers SET "homeMoveExpiresAt" = (now() AT TIME ZONE 'UTC') + interval '1 second'
              WHERE "maintenanceId" = ${initial.maintenanceId}`;
            const renewed = deferred<boolean>();
            const renew = workers.renewHomeMove.bind(workers);
            // Observe the real renewal after the scheduled heartbeat, not a fabricated receipt.
            const lifecycle = vi
              .spyOn(workers, "renewHomeMove")
              .mockImplementation(async (marker) => {
                const result = await renew(marker);
                renewed.resolve(result);
                return result;
              });
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await renewed.promise).toBe(true);
            lifecycle.mockRestore();
          }
          const [lease] = await prisma.$queryRaw<{ remaining: number }[]>`
            SELECT EXTRACT(EPOCH FROM ("homeMoveExpiresAt" - (now() AT TIME ZONE 'UTC')))::float8 AS remaining
            FROM computers WHERE id = ${computer.id}`;
          expect(lease!.remaining).toBeGreaterThan(50);
          await workers.reconcile({ limit: 10 }, fixture.context);
          expect(await move(computer.id)).toMatchObject({
            outcome: "refused",
            refusal: { code: "computer_active" },
          });
        }
        return super.write(ref, file, context);
      }
    }
    volumeFiles = new SlowCopy();
    expect(
      (
        await moveHomeToVolumes(
          { prisma, home, files: volumeFiles, workers },
          { computerId: computer.id, dryRun: false, leaveUnmapped: false, manifestPath: null },
          fixture.context,
        )
      ).outcome,
    ).toBe("adopted");
    expect(checked).toBe(true);
  });

  it("copies a team home into each bot's private volume and the shared volume, and nowhere else", async () => {
    const { spaceId, computer, ada, bob } = await teamHome();

    const report = await move(computer.id);

    const ada_ = await volumeRef({ botId: ada.id });
    const bob_ = await volumeRef({ botId: bob.id });
    const shared = await volumeRef({ spaceId, kind: "space_shared" });
    expect(report.outcome).toBe("adopted");
    expect(await volumeContents()).toEqual({
      [ada_]: { "notes.md": "ada notes (600)" },
      [bob_]: { "bin/run.sh": "echo bob (755)" },
      [shared]: { "plan.md": "the plan" },
    });
    expect(report.outcome === "adopted" && report.manifest.files).toContainEqual({
      homePath: `bots/${ada.id}/notes.md`,
      destination: { scope: "private", botId: ada.id },
      volumeId: ada_.replace("rakazo-", ""),
      volumePath: "notes.md",
      size: 9,
      sha256: sha("ada notes"),
      mode: 0o600,
    });
    expect(await homeStorageOf(computer.id)).toBe("volumes");
  });

  it.each(["none", "desktop", "running", "worker"])(
    "copies a dedicated home despite a %s sibling, with no shared volume",
    async (sibling) => {
      const spaceId = await fixture.seedSpace();
      const bot = await fixture.seedBot(spaceId, null);
      const computer = await prisma.computer.create({
        data: {
          spaceId,
          userId: fixture.userId,
          scope: "dedicated",
          scopeKey: `bot:${bot.id}`,
          homeKey: bot.id,
          kind: "e2b",
        },
      });
      await prisma.bot.update({ where: { id: bot.id }, data: { computerId: computer.id } });
      await seedHome(bot.id, { "docs/a.md": "alpha", "shared/b.md": "not the space's" });
      if (sibling !== "none") {
        const other = await fixture.seedComputer(spaceId, {
          kind: sibling === "desktop" ? "desktop" : "e2b",
        });
        if (sibling === "running")
          await prisma.computer.update({ where: { id: other.id }, data: { state: "running" } });
        if (sibling === "worker") {
          const otherBot = await fixture.seedBot(spaceId, other.id);
          await fixture.seedAttempt((await fixture.seedRun(otherBot)).id, 1, {
            workerState: "ready",
            workerProviderKind: "fake-worker",
            workerProviderRef: fixture.unique("vm"),
            workerStateAt: new Date(),
            workerEnsureAt: new Date(),
          });
        }
      }

      const report = await move(computer.id);

      expect(report.outcome).toBe("adopted");
      expect(await volumeContents()).toEqual({
        [await volumeRef({ botId: bot.id })]: {
          "docs/a.md": "alpha",
          "shared/b.md": "not the space's",
        },
      });
      expect(await prisma.volume.count({ where: { spaceId, kind: "space_shared" } })).toBe(0);
    },
  );

  it("refuses a home holding what no volume receives, unless told to leave it in the original", async () => {
    const { spaceId, computer, ada, bob } = await teamHome();
    const detached = await fixture.seedBot(spaceId, null);
    await home.writeFile(computer.homeKey, `bots/${detached.id}/diary.md`, "x", fixture.context);
    await home.writeFile(computer.homeKey, "stray.txt", "y", fixture.context);
    const homeDir = home.pathFor(computer.homeKey);
    await symlink("plan.md", path.join(homeDir, "shared/link.md"));
    await mkdir(path.join(homeDir, `bots/${ada.id}/empty`));

    const refused = await move(computer.id);
    const createdBeforeLeave = await prisma.volume.count({ where: { spaceId } });
    const left = await move(computer.id, { leaveUnmapped: true });

    const notCopied = [
      { homePath: `bots/${ada.id}/empty`, kind: "empty_dir" },
      { homePath: `bots/${detached.id}/diary.md`, kind: "unmapped" },
      { homePath: "shared/link.md", kind: "symlink" },
      { homePath: "stray.txt", kind: "unmapped" },
    ];
    expect(refused).toEqual({
      outcome: "refused",
      refusal: { code: "not_copied", entries: notCopied },
    });
    expect(createdBeforeLeave).toBe(0);
    expect(left.outcome === "adopted" && left.manifest.notCopied).toEqual(notCopied);
    expect(await volumeContents()).toEqual({
      [await volumeRef({ botId: ada.id })]: { "notes.md": "ada notes (600)" },
      [await volumeRef({ botId: bob.id })]: { "bin/run.sh": "echo bob (755)" },
      [await volumeRef({ spaceId, kind: "space_shared" })]: { "plan.md": "the plan" },
    });
  });

  it("refuses paths a volume cannot hold, files bound for one volume path, and files the export missed", async () => {
    const { computer, ada } = await teamHome();
    class OddHomeStore extends LocalAgentHomeStore {
      override async *exportHome(botId: string, context: AdapterContext) {
        for await (const file of super.exportHome(botId, context)) {
          if (file.path === "shared/plan.md") continue;
          yield file;
          if (file.path === `bots/${ada.id}/notes.md`) yield { ...file };
        }
        yield { path: "shared/../escape.md", content: text.encode("out") };
        yield { path: "shared/back\\slash.md", content: text.encode("odd") };
      }
    }
    home = new OddHomeStore(root);

    const report = await move(computer.id);

    expect(report).toEqual({
      outcome: "refused",
      refusal: {
        code: "not_copied",
        entries: [
          { homePath: `bots/${ada.id}/notes.md`, kind: "duplicate" },
          { homePath: `bots/${ada.id}/notes.md`, kind: "duplicate" },
          { homePath: "shared/../escape.md", kind: "invalid_path" },
          { homePath: "shared/back\\slash.md", kind: "invalid_path" },
          { homePath: "shared/plan.md", kind: "not_exported" },
        ],
      },
    });
  });

  it("refuses a shared volume a worker already wrote, before writing anything", async () => {
    const { spaceId, computer, ada } = await teamHome();
    const shared = await fixture.seedVolume("space_shared", spaceId, null, null);
    const sharedRef = await createWorkerLifecycle({ prisma, provider }).provisionVolume(
      shared.id,
      fixture.context,
    );
    await volumeFiles.write(
      sharedRef,
      { path: "plan.md", content: text.encode("the worker's plan") },
      fixture.context,
    );

    const report = await move(computer.id);

    expect(report.outcome === "refused" && report.refusal).toEqual({
      code: "volume_not_empty",
      volumes: [
        {
          destination: { scope: "shared" },
          volumeId: shared.id,
          foreign: ["plan.md"],
          missing: ["plan.md"],
        },
      ],
    });
    expect(await volumeContents()).toEqual({ [sharedRef]: { "plan.md": "the worker's plan" } });
    expect(volumeFiles.volumes.has(await volumeRef({ botId: ada.id }))).toBe(false);
    expect(await homeStorageOf(computer.id)).toBe("snapshot");
  });

  it.each([
    [
      "another hash",
      (file: PortableFile) => ({ ...file, content: file.content.slice(0, -1) }),
      [["notes.md"], ["bin/run.sh"], ["plan.md"]],
    ],
    [
      "a wider mode",
      (file: PortableFile) => ({ ...file, mode: 0o644 }),
      [["notes.md"], ["bin/run.sh"]],
    ],
  ])("does not adopt when a copied file reads back with %s", async (_, alter, foreign) => {
    const { computer } = await teamHome();
    class AlteringVolumeFiles extends MemoryVolumeFiles {
      override write(ref: string, file: PortableFile, context: AdapterContext) {
        return super.write(ref, alter(file), context);
      }
    }
    volumeFiles = new AlteringVolumeFiles();

    const report = await move(computer.id);

    expect(report.outcome === "refused" && report.refusal.code).toBe("copy_mismatch");
    expect(
      report.outcome === "refused" &&
        report.refusal.code === "copy_mismatch" &&
        report.refusal.volumes.map((volume) => volume.foreign),
    ).toEqual(foreign);
    expect(await homeStorageOf(computer.id)).toBe("snapshot");
  });

  it("refuses a resumed copy when the home changed after it was planned, even files already copied", async () => {
    const { computer, ada } = await teamHome();
    class LostBeforeVerify extends MemoryVolumeFiles {
      override async list(ref: string, context: AdapterContext) {
        if (this.volumes.size > 0) throw new Error("connection lost");
        return super.list(ref, context);
      }
    }
    const interrupted = new LostBeforeVerify();
    await expect(move(computer.id, {}, interrupted)).rejects.toThrow("connection lost");
    const homeDir = home.pathFor(computer.homeKey);
    class ChangingHomeAfterPlan extends MemoryVolumeFiles {
      private changed = false;
      override async list(ref: string, context: AdapterContext) {
        if (!this.changed) {
          this.changed = true;
          await writeFile(path.join(homeDir, `bots/${ada.id}/notes.md`), "newer notes");
          await writeFile(path.join(homeDir, `bots/${ada.id}/added.md`), "added");
          await rm(path.join(homeDir, "shared/plan.md"));
        }
        return super.list(ref, context);
      }
    }
    volumeFiles = new ChangingHomeAfterPlan();
    for (const [ref, files] of interrupted.volumes) volumeFiles.volumes.set(ref, files);

    const report = await move(computer.id);

    expect(report.outcome === "refused" && report.refusal).toEqual({
      code: "home_changed",
      paths: [`bots/${ada.id}/added.md`, `bots/${ada.id}/notes.md`, "shared/plan.md"],
    });
    expect(await homeStorageOf(computer.id)).toBe("snapshot");
  });

  it.each([
    [
      "a checkpoint gives the home a new revision",
      "home_revised",
      async (computerId: string) => {
        await prisma.computer.update({
          where: { id: computerId },
          data: { homeRevision: "rev-during-copy" },
        });
      },
    ],
  ])("does not adopt when %s during the copy", async (_, code, during) => {
    const { computer } = await teamHome();
    class SomethingHappensDuringCopy extends MemoryVolumeFiles {
      private happened = false;
      override async write(ref: string, file: PortableFile, context: AdapterContext) {
        if (!this.happened) {
          this.happened = true;
          await during(computer.id);
        }
        return super.write(ref, file, context);
      }
    }
    volumeFiles = new SomethingHappensDuringCopy();

    const report = await move(computer.id);

    expect(report.outcome === "refused" && report.refusal).toEqual({ code });
    expect(await homeStorageOf(computer.id)).toBe("snapshot");
  });

  it("refuses a team home while a worker of the space may still write the shared volume", async () => {
    const { spaceId, computer } = await teamHome();
    const otherBot = await fixture.seedBot(spaceId, null);
    const attempt = await fixture.seedAttempt((await fixture.seedRun(otherBot)).id);
    const workers = createWorkerLifecycle({ prisma, provider });
    await workers.start(await fixture.launchFor(workers, attempt.id, mcpOnly), fixture.context);

    const report = await move(computer.id);

    expect(report).toEqual({ outcome: "refused", refusal: { code: "space_worker_live" } });
    expect(await prisma.volume.count({ where: { spaceId } })).toBe(0);
  });

  it("plans a dry run without creating, writing or adopting anything", async () => {
    const { spaceId, computer, ada } = await teamHome();
    const manifestPath = path.join(root, "dry-run.json");

    const report = await move(computer.id, { dryRun: true, manifestPath });

    expect(
      report.outcome === "planned" && report.manifest.files.map((file) => file.homePath),
    ).toEqual(expect.arrayContaining([`bots/${ada.id}/notes.md`, "shared/plan.md"]));
    expect(report.outcome === "planned" && report.manifest.volumes.map((v) => v.volumeId)).toEqual([
      null,
      null,
      null,
    ]);
    expect(await prisma.volume.count({ where: { spaceId } })).toBe(0);
    expect(provider.calls).toEqual([]);
    expect(volumeFiles.volumes.size).toBe(0);
    expect(await homeStorageOf(computer.id)).toBe("snapshot");
    await expect(readFile(manifestPath)).rejects.toThrow("ENOENT");
  });

  it("refuses a manifest path that already exists before creating anything", async () => {
    const { spaceId, computer } = await teamHome();
    const manifestPath = path.join(root, "taken.json");
    await writeFile(manifestPath, "an earlier record");

    await expect(move(computer.id, { manifestPath })).rejects.toThrow("already exists");
    expect(await prisma.volume.count({ where: { spaceId } })).toBe(0);
    expect(await readFile(manifestPath, "utf8")).toBe("an earlier record");
  });

  it("resumes a copy interrupted midway, and does nothing once adopted", async () => {
    const { computer } = await teamHome();
    class FailingAfterOneWrite extends MemoryVolumeFiles {
      private writes = 0;
      override async write(ref: string, file: PortableFile, context: AdapterContext) {
        if (++this.writes > 1) throw new Error("connection lost");
        return super.write(ref, file, context);
      }
    }
    const interrupted = new FailingAfterOneWrite();

    const interruptedRecord = path.join(root, "first.json");
    const resumedRecord = path.join(root, "second.json");
    await expect(
      move(computer.id, { manifestPath: interruptedRecord }, interrupted),
    ).rejects.toThrow("connection lost");
    for (const [ref, files] of interrupted.volumes) volumeFiles.volumes.set(ref, files);
    const resumed = await move(computer.id, { manifestPath: resumedRecord });
    const again = await move(computer.id);

    const record = async (file: string) =>
      JSON.parse(await readFile(file, "utf8")) as { adoptedAt: string | null; volumes: unknown[] };
    expect(await record(interruptedRecord)).toMatchObject({
      adoptedAt: null,
      volumes: [
        { volumeId: expect.any(String) },
        { volumeId: expect.any(String) },
        { volumeId: expect.any(String) },
      ],
    });
    expect((await record(resumedRecord)).adoptedAt).toEqual(expect.any(String));
    expect(resumed.outcome).toBe("adopted");
    expect(
      Object.values(await volumeContents())
        .flatMap(Object.keys)
        .sort(),
    ).toEqual(["bin/run.sh", "notes.md", "plan.md"]);
    expect(again).toEqual({ outcome: "already_on_volumes" });
  });

  it("leaves the original in place, and restore and checkpoint stop touching an adopted home", async () => {
    const { computer, ada } = await teamHome();
    const original = await homeFiles(computer.homeKey);
    await move(computer.id);
    const record = await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } });
    const sandbox = new FakeSandboxProvider();
    const machine = await sandbox.provision(
      { botId: computer.homeKey, homePath: "/m" },
      fixture.context,
    );
    await sandbox.writeFile(
      machine,
      { path: "new.txt", content: text.encode("on the machine") },
      fixture.context,
    );

    await restoreComputerWorkspace(home, sandbox, record, machine, fixture.context);
    const revision = await checkpointComputerWorkspace(
      home,
      sandbox,
      record,
      machine,
      fixture.context,
    );

    expect(await sandbox.listFiles(machine, "", fixture.context)).toEqual([
      expect.objectContaining({ path: "new.txt" }),
    ]);
    expect(revision).toBe(record.homeRevision);
    expect(await homeFiles(computer.homeKey)).toEqual(original);
    expect(original[`bots/${ada.id}/notes.md`]).toBe("ada notes");
  });
});
