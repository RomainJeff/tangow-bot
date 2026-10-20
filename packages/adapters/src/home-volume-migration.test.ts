import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, PortableFile } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkpointComputerWorkspace, restoreComputerWorkspace } from "./computer-workspace.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { MemoryVolumeFiles } from "./fake-volume-files.js";
import { FakeWorkerProvider } from "./fake-worker-provider.js";
import { LocalAgentHomeStore } from "./home.js";
import type { HomeMoveOptions } from "./home-volume-migration.js";
import { moveHomeToVolumes } from "./home-volume-migration.js";
import { mcpOnly, workerFixture } from "./worker-fixture.test-support.js";
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
afterEach(() => rm(root, { recursive: true, force: true }));

function move(
  computerId: string,
  options: Partial<Omit<HomeMoveOptions, "computerId">> = {},
  files = volumeFiles,
) {
  return moveHomeToVolumes(
    { prisma, home, files, workers: createWorkerLifecycle({ prisma, provider }) },
    { computerId, dryRun: false, leaveUnmapped: false, ...options },
    fixture.context,
  );
}

async function seedHome(homeKey: string, files: Record<string, string>, executable: string[] = []) {
  const staging = await mkdtemp(path.join(tmpdir(), "rakazo-home-seed-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(staging, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { mode: executable.includes(file) ? 0o755 : 0o644 });
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

/** Each volume's files as `path: content`, or `path: content (x)` when executable. */
async function volumeContents() {
  const contents: Record<string, Record<string, string>> = {};
  for (const [ref, files] of volumeFiles.volumes) {
    contents[ref] = Object.fromEntries(
      [...files].map(([file, stored]) => [
        file,
        `${new TextDecoder().decode(stored.content)}${stored.executable ? " (x)" : ""}`,
      ]),
    );
  }
  return contents;
}

async function volumeRef(where: { botId: string } | { spaceId: string; kind: "space_shared" }) {
  const volume = await prisma.volume.findFirstOrThrow({ where });
  return `fake-volume-rakazo-${volume.id}`;
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
    [`bots/${bob.id}/bin/run.sh`],
  );
  return { spaceId, computer, ada, bob };
}

describe("moving a home from snapshots to volumes", () => {
  it("copies a team home into each bot's private volume and the shared volume, and nowhere else", async () => {
    const { spaceId, computer, ada, bob } = await teamHome();

    const report = await move(computer.id);

    const ada_ = await volumeRef({ botId: ada.id });
    const bob_ = await volumeRef({ botId: bob.id });
    const shared = await volumeRef({ spaceId, kind: "space_shared" });
    expect(report.outcome).toBe("adopted");
    expect(await volumeContents()).toEqual({
      [ada_]: { "notes.md": "ada notes" },
      [bob_]: { "bin/run.sh": "echo bob (x)" },
      [shared]: { "plan.md": "the plan" },
    });
    expect(report.outcome === "adopted" && report.manifest.files).toContainEqual({
      homePath: `bots/${ada.id}/notes.md`,
      destination: { scope: "private", botId: ada.id },
      volumeId: ada_.replace("fake-volume-rakazo-", ""),
      volumePath: "notes.md",
      size: 9,
      sha256: sha("ada notes"),
      executable: false,
    });
    expect(await homeStorageOf(computer.id)).toBe("volumes");
  });

  it("copies a dedicated home whole into its bot's private volume, with no shared volume", async () => {
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

    const report = await move(computer.id);

    expect(report.outcome).toBe("adopted");
    expect(await volumeContents()).toEqual({
      [await volumeRef({ botId: bot.id })]: {
        "docs/a.md": "alpha",
        "shared/b.md": "not the space's",
      },
    });
    expect(await prisma.volume.count({ where: { spaceId, kind: "space_shared" } })).toBe(0);
  });

  it("refuses a team home holding files outside its bots and shared folder, unless told to leave them", async () => {
    const { spaceId, computer, ada } = await teamHome();
    const detached = await fixture.seedBot(spaceId, null);
    await home.writeFile(computer.homeKey, `bots/${detached.id}/diary.md`, "x", fixture.context);
    await home.writeFile(computer.homeKey, "stray.txt", "y", fixture.context);

    const refused = await move(computer.id);
    const createdBeforeLeave = await prisma.volume.count({ where: { spaceId } });
    const left = await move(computer.id, { leaveUnmapped: true });

    expect(refused).toEqual({
      outcome: "refused",
      refusal: { code: "unmapped_files", paths: [`bots/${detached.id}/diary.md`, "stray.txt"] },
    });
    expect(createdBeforeLeave).toBe(0);
    expect(left.outcome === "adopted" && left.manifest.leftInHome).toEqual([
      `bots/${detached.id}/diary.md`,
      "stray.txt",
    ]);
    expect(Object.keys((await volumeContents())[await volumeRef({ botId: ada.id })] ?? {})).toEqual(
      ["notes.md"],
    );
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

  it("does not adopt when a copied file reads back with another hash", async () => {
    const { computer } = await teamHome();
    class TruncatingVolumeFiles extends MemoryVolumeFiles {
      override write(ref: string, file: PortableFile, context: AdapterContext) {
        return super.write(ref, { ...file, content: file.content.slice(0, -1) }, context);
      }
    }
    volumeFiles = new TruncatingVolumeFiles();

    const report = await move(computer.id);

    expect(report.outcome === "refused" && report.refusal.code).toBe("copy_mismatch");
    expect(
      report.outcome === "refused" &&
        report.refusal.code === "copy_mismatch" &&
        report.refusal.volumes.map((volume) => volume.foreign),
    ).toEqual([["notes.md"], ["bin/run.sh"], ["plan.md"]]);
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

    const report = await move(computer.id, { dryRun: true });

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

    await expect(move(computer.id, {}, interrupted)).rejects.toThrow("connection lost");
    for (const [ref, files] of interrupted.volumes) volumeFiles.volumes.set(ref, files);
    const resumed = await move(computer.id);
    const again = await move(computer.id);

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
