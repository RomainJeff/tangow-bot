import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PgliteDatabase } from "@tangow/db/pglite.test-support";
import { openPgliteDatabase } from "@tangow/db/pglite.test-support";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { VolumeImportSource } from "./docker-volume-import.js";
import { inspectLocalVolume, MAX_IMPORT_FILE_BYTES } from "./docker-volume-import.js";
import { migrateE2BToDocker } from "./e2b-docker-migration.js";
import { FakeWorkerProvider } from "./fake-worker-provider.js";
import { pastEnsureTimeout, workerFixture } from "./worker-fixture.test-support.js";

let database: PgliteDatabase;
let root: string;
let fixture: ReturnType<typeof workerFixture>;
let workers: FakeWorkerProvider;
let operationId: string;
let source: VolumeImportSource;
let destroyed: string[];

beforeAll(async () => {
  database = await openPgliteDatabase();
});
afterAll(() => database.close());
beforeEach(async () => {
  await database.prisma.$executeRawUnsafe('TRUNCATE TABLE "user" CASCADE');
  fixture = workerFixture(database.prisma);
  await fixture.seedOwner();
  root = await mkdtemp(path.join(tmpdir(), "rakazo-e2b-docker-"));
  workers = new FakeWorkerProvider();
  operationId = randomUUID();
  destroyed = [];
  source = {
    inspect: (ref) => inspectLocalVolume(path.join(root, "source", ref)),
    read: (ref, file) => readFile(path.join(root, "source", ref, file)),
  };
});
afterEach(() => rm(root, { recursive: true, force: true }));

const prisma = () => database.prisma;
const dataDir = () => path.join(root, "data");
const journal = () => path.join(dataDir(), "docker-provider-migration", operationId, "state.json");
const target = (id: string) => path.join(dataDir(), "volumes", `rakazo-${id}`);
const migrate = (
  destroyComputer = async (ref: string) => {
    destroyed.push(ref);
  },
) =>
  migrateE2BToDocker(
    {
      prisma: prisma(),
      dataDir: dataDir(),
      source,
      workers,
      destroyComputer,
    },
    operationId,
    fixture.context,
  );

async function seed() {
  const spaceId = await fixture.seedSpace();
  const computer = await fixture.seedComputer(spaceId, { kind: "e2b", homeStorage: "volumes" });
  await prisma().computer.update({
    where: { id: computer.id },
    data: { providerRef: "source-computer", state: "running" },
  });
  const bot = await fixture.seedBot(spaceId, computer.id);
  const archived = await fixture.seedBot(spaceId, null);
  await prisma().bot.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
  const volumes = [];
  for (const [kind, botId, ref] of [
    ["bot_private", bot.id, "private"],
    ["bot_private", archived.id, "archived"],
    ["space_shared", null, "shared"],
  ] satisfies Array<["bot_private" | "space_shared", string | null, string]>) {
    const row = await fixture.seedVolume(kind, spaceId, botId, ref);
    await prisma().volume.update({ where: { id: row.id }, data: { providerKind: "e2b-worker" } });
    const directory = path.join(root, "source", ref);
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o755);
    await writeFile(path.join(directory, "note.txt"), ref, { mode: 0o640 });
    volumes.push({ ...row, providerKind: "e2b-worker", directory });
  }
  return { computer, bot, spaceId, volumes };
}

it("preserves private, archived and shared volume identities, contents, empty directories and modes", async () => {
  const { computer, volumes } = await seed();
  const own = volumes[0]!;
  await mkdir(path.join(own.directory, "empty"), { mode: 0o750 });
  await writeFile(path.join(own.directory, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  const result = await migrate();
  expect(result).toEqual({ outcome: "migrated", volumes: 3, computers: 1 });
  for (const volume of volumes) {
    expect(await prisma().volume.findUniqueOrThrow({ where: { id: volume.id } })).toMatchObject({
      id: volume.id,
      kind: volume.kind,
      spaceId: volume.spaceId,
      botId: volume.botId,
      providerKind: "docker-worker",
      providerRef: `rakazo-${volume.id}`,
    });
    expect(await readFile(path.join(target(volume.id), "note.txt"), "utf8")).toBe(
      volume.providerRef,
    );
    expect(await readFile(path.join(volume.directory, "note.txt"), "utf8")).toBe(
      volume.providerRef,
    );
    expect((await stat(path.join(target(volume.id), "note.txt"))).mode & 0o777).toBe(0o640);
  }
  expect((await stat(path.join(target(own.id), "empty"))).mode & 0o777).toBe(0o750);
  expect((await stat(path.join(target(own.id), "run.sh"))).mode & 0o777).toBe(0o755);
  expect(destroyed).toEqual(["source-computer"]);
  expect(await prisma().computer.findUniqueOrThrow({ where: { id: computer.id } })).toMatchObject({
    kind: "docker",
    homeStorage: "volumes",
    state: "stopped",
    providerRef: null,
    controlHolder: "none",
    maintenanceId: null,
    screenUrl: null,
  });
  await expect(migrate()).resolves.toEqual(result);
});

it("restarts an interrupted volume copy without switching any row early or deleting source data", async () => {
  const { volumes } = await seed();
  const read = source.read;
  let fail = true;
  source.read = async (ref, file, context) => {
    if (ref === "shared" && fail) {
      fail = false;
      throw new Error("network lost");
    }
    return read(ref, file, context);
  };
  await expect(migrate()).rejects.toThrow("network lost");
  expect(await prisma().volume.count({ where: { providerKind: "docker-worker" } })).toBe(0);
  await expect(migrate()).resolves.toMatchObject({ outcome: "migrated", volumes: 3 });
  for (const volume of volumes) {
    expect(await readFile(path.join(target(volume.id), "note.txt"), "utf8")).toBe(
      volume.providerRef,
    );
    expect(await readFile(path.join(volume.directory, "note.txt"), "utf8")).toBe(
      volume.providerRef,
    );
  }
});

it.each(["link", "large", "missing", "conflict"])(
  "refuses a %s source/destination without adopting or overwriting data",
  async (failure) => {
    const { volumes } = await seed();
    const own = volumes[0]!;
    if (failure === "link") await symlink("note.txt", path.join(own.directory, "link"));
    if (failure === "large")
      await truncate(path.join(own.directory, "note.txt"), MAX_IMPORT_FILE_BYTES + 1);
    if (failure === "missing") await rm(own.directory, { recursive: true });
    if (failure === "conflict") {
      await mkdir(target(own.id), { recursive: true });
      await writeFile(path.join(target(own.id), "note.txt"), "newer Docker data");
    }
    await expect(migrate()).rejects.toThrow();
    expect(await prisma().volume.count({ where: { providerKind: "docker-worker" } })).toBe(0);
    if (failure === "conflict")
      expect(await readFile(path.join(target(own.id), "note.txt"), "utf8")).toBe(
        "newer Docker data",
      );
  },
);

it.each(["expired", "missing", "uncovered"])(
  "refuses cutover with %s reservation before changing any supplier",
  async (failure) => {
    const { computer, spaceId, volumes } = await seed();
    const sibling = await fixture.seedComputer(spaceId, {
      kind: "e2b",
      scope: "dedicated",
      homeStorage: "volumes",
    });
    const read = source.read;
    let changed = false;
    source.read = async (ref, file, context) => {
      const content = await read(ref, file, context);
      if (!changed) {
        changed = true;
        if (failure === "expired") {
          await prisma()
            .$executeRaw`UPDATE computers SET "homeMoveExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second'
          WHERE "spaceId" = ${spaceId}`;
        } else {
          await prisma().computer.updateMany({
            where: failure === "uncovered" ? { id: sibling.id } : { spaceId },
            data: { maintenanceId: null },
          });
        }
      }
      return content;
    };
    await expect(migrate()).rejects.toThrow("Migration reservation expired");
    expect(await prisma().volume.count({ where: { providerKind: "docker-worker" } })).toBe(0);
    expect((await prisma().computer.findUniqueOrThrow({ where: { id: computer.id } })).kind).toBe(
      "e2b",
    );
    for (const volume of volumes) {
      expect(await readFile(path.join(volume.directory, "note.txt"), "utf8")).toBe(
        volume.providerRef,
      );
      expect(await readFile(path.join(target(volume.id), "note.txt"), "utf8")).toBe(
        volume.providerRef,
      );
    }
  },
);

it("reconciles an adoption committed before its journal update without re-reading E2B", async () => {
  const { volumes } = await seed();
  await migrate();
  const state = JSON.parse(await readFile(journal(), "utf8"));
  state.phase = "copying";
  await writeFile(journal(), JSON.stringify(state));
  source.inspect = async () => {
    throw new Error("source must not be reopened");
  };
  await expect(migrate()).resolves.toMatchObject({ outcome: "migrated" });
  expect(await readFile(path.join(target(volumes[0]!.id), "note.txt"), "utf8")).toBe("private");
});

it("requires confirmed computer and worker teardown before switching providers", async () => {
  const { volumes, bot } = await seed();
  await expect(
    migrate(async () => {
      throw new Error("computer still alive");
    }),
  ).rejects.toThrow("computer still alive");
  expect(await prisma().volume.count({ where: { providerKind: "docker-worker" } })).toBe(0);
  const run = await fixture.seedRun(bot, { status: "completed" });
  const attempt = await fixture.seedAttempt(run.id, 1, {
    workerState: "ready",
    workerProviderKind: "e2b-worker",
    workerProviderRef: "worker-ref",
    workerEnsureAt: pastEnsureTimeout(),
    workerStateAt: new Date(),
  });
  workers.live.set("worker-ref", {
    attemptId: attempt.id,
    runId: run.id,
    botId: bot.id,
    mounts: [],
    ttlSeconds: 3_600,
    ensureDeadline: new Date(),
  });
  workers.failDestroy = new Error("worker still alive");
  await expect(migrate()).rejects.toThrow("worker still alive");
  expect(await fixture.workerStateOf(attempt.id)).toBe("releasing");
  expect(workers.live.has("worker-ref")).toBe(true);
  expect(
    (await prisma().volume.findUniqueOrThrow({ where: { id: volumes[0]!.id } })).providerKind,
  ).toBe("e2b-worker");
  workers.failDestroy = null;
  await expect(migrate()).resolves.toMatchObject({ outcome: "migrated" });
  expect(await fixture.workerStateOf(attempt.id)).toBe("released");
  expect(workers.live.size).toBe(0);
});

it("refuses active work and snapshot homes before destroying computers", async () => {
  const { computer, bot } = await seed();
  const run = await fixture.seedRun(bot);
  await expect(migrate()).rejects.toThrow("runs");
  expect(destroyed).toEqual([]);
  await prisma().run.update({ where: { id: run.id }, data: { status: "completed" } });
  await prisma().computer.update({ where: { id: computer.id }, data: { homeStorage: "snapshot" } });
  await expect(migrate()).rejects.toThrow("snapshots");
  expect(destroyed).toEqual([]);
});

it("converts never-provisioned volume rows without inventing files or retaining the wrong supplier", async () => {
  const { spaceId } = await seed();
  const newBot = await fixture.seedBot(spaceId, null);
  const row = await fixture.seedVolume("bot_private", spaceId, newBot.id, null);
  await prisma().volume.update({ where: { id: row.id }, data: { providerKind: "e2b-worker" } });
  await migrate();
  expect(await prisma().volume.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
    providerKind: "docker-worker",
    providerRef: null,
  });
});

it("migrates a Space whose members each have their own team computer", async () => {
  const { spaceId } = await seed();
  const member = fixture.unique("user");
  await prisma().user.create({ data: { id: member, name: "M", email: `${member}@rakazo.test` } });
  const theirs = await fixture.seedComputer(spaceId, { userId: member, homeStorage: "volumes" });
  await expect(migrate()).resolves.toMatchObject({ outcome: "migrated", computers: 2 });
  expect((await prisma().computer.findUniqueOrThrow({ where: { id: theirs.id } })).kind).toBe(
    "docker",
  );
});
