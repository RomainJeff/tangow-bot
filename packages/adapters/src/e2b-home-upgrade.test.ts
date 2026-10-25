import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, PortableFile } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DockerWorkerProvider } from "./docker-worker.js";
import {
  carryDockerVolumesToE2B,
  prepareHomeForE2B,
  previewDockerVolumeCarry,
} from "./e2b-home-upgrade.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { MemoryVolumeFiles } from "./fake-volume-files.js";
import { FakeWorkerProvider } from "./fake-worker-provider.js";
import { LocalAgentHomeStore } from "./home.js";
import { workerFixture } from "./worker-fixture.test-support.js";
import { createWorkerLifecycle } from "./worker-lifecycle.js";

let database: PgliteDatabase;
let prisma: PrismaClient;
let fixture: ReturnType<typeof workerFixture>;
let dataDir: string;
let docker: DockerWorkerProvider;
let e2b: FakeWorkerProvider;

beforeAll(async () => {
  database = await openPgliteDatabase();
  prisma = database.prisma;
  fixture = workerFixture(prisma);
  await fixture.seedOwner();
});
afterAll(() => database.close());
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-docker-carry-"));
  docker = new DockerWorkerProvider({
    supervisorUrl: "http://127.0.0.1:9",
    supervisorToken: "unused",
    dataDir,
  });
  e2b = new FakeWorkerProvider();
});

/** A stopped Docker team computer on volumes: one bot's private volume and the space's shared one. */
async function dockerTeamOnVolumes() {
  const spaceId = await fixture.seedSpace();
  const computer = await fixture.seedComputer(spaceId, {
    kind: "docker",
    scope: "team",
    homeStorage: "volumes",
  });
  const bot = await fixture.seedBot(spaceId, computer.id);
  const lifecycle = createWorkerLifecycle({ prisma, provider: docker });
  const own = await lifecycle.ensureVolume(
    { kind: "bot_private", spaceId, botId: bot.id },
    fixture.context,
  );
  const shared = await lifecycle.ensureVolume({ kind: "space_shared", spaceId }, fixture.context);
  return { computer, bot, own, shared };
}

async function put(volumeRef: string, relative: string, content = relative) {
  const file = path.join(docker.volumePath(volumeRef), relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

function carry(files: MemoryVolumeFiles, computerId: string, context: AdapterContext) {
  return carryDockerVolumesToE2B(
    { prisma, source: docker, target: e2b, files },
    computerId,
    context,
  );
}

const text = async (files: MemoryVolumeFiles, volumeRef: string, file: string) =>
  Buffer.from(await files.read(volumeRef, file, fixture.context)).toString();

describe("carrying a Docker computer's volumes to E2B", () => {
  it("copies and verifies each volume, switches it and the computer, and never follows a link", async () => {
    const { computer, own, shared } = await dockerTeamOnVolumes();
    await chmod(await put(own.providerRef, "bin/run.sh", "#!/bin/sh"), 0o755);
    await put(shared.providerRef, "team.txt", "team");
    const outside = path.join(dataDir, "secret.txt");
    await writeFile(outside, "host secret");
    await symlink(outside, path.join(docker.volumePath(own.providerRef), "secret"));
    await mkdir(path.join(docker.volumePath(own.providerRef), "empty"));
    // Sparse, so the disk holds none of it: one byte over what is copied in one piece.
    await truncate(await put(shared.providerRef, "huge.bin", ""), 1024 ** 3 + 1);
    const before = await readdir(docker.volumePath(own.providerRef));

    const preview = await previewDockerVolumeCarry({ prisma, source: docker }, computer.id);
    expect(preview).toMatchObject({ files: 2, bytes: 13 });
    const files = new MemoryVolumeFiles();
    const report = await carry(files, computer.id, fixture.context);

    const left = [
      { homePath: `volumes/${own.providerRef}/empty`, kind: "empty_dir" },
      { homePath: `volumes/${own.providerRef}/secret`, kind: "symlink" },
      { homePath: `volumes/${shared.providerRef}/huge.bin`, kind: "too_large" },
    ];
    expect(preview.notCopied).toEqual(expect.arrayContaining(left));
    expect(preview.notCopied).toHaveLength(left.length);
    expect(report).toMatchObject({ outcome: "carried" });
    expect(report.outcome === "carried" && report.volumes.flatMap((v) => v.notCopied)).toEqual(
      preview.notCopied,
    );
    const target = `rakazo-${own.volumeId}`;
    expect(await files.list(target, fixture.context)).toEqual([
      { path: "bin", kind: "dir", mode: 0o755 },
      { path: "bin/run.sh", kind: "file", mode: 0o755 },
    ]);
    expect(await files.list(`rakazo-${shared.volumeId}`, fixture.context)).toEqual([
      { path: "team.txt", kind: "file", mode: 0o644 },
    ]);
    expect(await text(files, `rakazo-${shared.volumeId}`, "team.txt")).toBe("team");
    const rows = await prisma.volume.findMany({
      where: { id: { in: [own.volumeId, shared.volumeId] } },
    });
    for (const row of rows) {
      expect(row).toMatchObject({ providerKind: "fake-worker", providerRef: `rakazo-${row.id}` });
    }
    expect(await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })).toMatchObject({
      kind: "e2b",
      homeStorage: "volumes",
      providerRef: null,
      maintenanceId: null,
    });
    expect(await readdir(docker.volumePath(own.providerRef))).toEqual(before);
    await expect(carry(files, computer.id, fixture.context)).resolves.toEqual({
      outcome: "already_on_e2b",
    });
  });

  it("resumes after an interruption that left a staged write, copying no file or volume twice", async () => {
    const { computer, own, shared } = await dockerTeamOnVolumes();
    await put(own.providerRef, "notes.md", "notes");
    await put(shared.providerRef, "a.txt", "a");
    await put(shared.providerRef, "b.txt", "b");
    const writes: string[] = [];
    let interrupt = true;
    class InterruptedOnce extends MemoryVolumeFiles {
      override async write(volumeRef: string, file: PortableFile, context: AdapterContext) {
        if (file.path === "b.txt" && interrupt) {
          interrupt = false;
          // What E2BVolumeFiles leaves when its sandbox dies mid-write.
          await super.write(volumeRef, { ...file, path: `.rakazo-${randomUUID()}` }, context);
          throw new Error("connection lost");
        }
        writes.push(`${volumeRef}/${file.path}`);
        await super.write(volumeRef, file, context);
      }
    }
    const files = new InterruptedOnce();

    await expect(carry(files, computer.id, fixture.context)).rejects.toThrow("connection lost");
    const sharedRow = await prisma.volume.findUniqueOrThrow({ where: { id: shared.volumeId } });
    expect(sharedRow.providerKind).toBe("docker-worker");
    expect(
      (await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })).maintenanceId,
    ).toBeNull();

    expect((await carry(files, computer.id, fixture.context)).outcome).toBe("carried");
    const sharedRef = `rakazo-${shared.volumeId}`;
    expect(writes.sort()).toEqual(
      [`rakazo-${own.volumeId}/notes.md`, `${sharedRef}/a.txt`, `${sharedRef}/b.txt`].sort(),
    );
    expect(await text(files, sharedRef, "b.txt")).toBe("b");
    expect((await files.list(sharedRef, fixture.context)).map((entry) => entry.path)).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  it("refuses an E2B volume holding files it did not copy, and keeps the volume on Docker", async () => {
    const { computer, own } = await dockerTeamOnVolumes();
    await put(own.providerRef, "notes.md", "notes");
    const files = new MemoryVolumeFiles();
    await files.write(
      `rakazo-${own.volumeId}`,
      { path: "stranger.txt", content: new TextEncoder().encode("?") },
      fixture.context,
    );

    const report = await carry(files, computer.id, fixture.context);

    expect(report).toMatchObject({
      outcome: "refused",
      refusal: { code: "volume_not_empty", volumes: [{ foreign: ["stranger.txt"] }] },
    });
    expect(
      (await prisma.volume.findUniqueOrThrow({ where: { id: own.volumeId } })).providerKind,
    ).toBe("docker-worker");
    expect((await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })).kind).toBe(
      "docker",
    );
  });
});

it("prepares a running Docker computer on volumes for the carry without checkpointing it", async () => {
  const { computer } = await dockerTeamOnVolumes();
  await prisma.computer.update({
    where: { id: computer.id },
    data: { providerRef: "old-docker", state: "running", controlHolder: "bot" },
  });
  const source = new FakeSandboxProvider();
  const home = new LocalAgentHomeStore(dataDir);

  await prepareHomeForE2B({ prisma, home, source }, computer.id, fixture.context);

  expect(await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })).toMatchObject({
    kind: "docker",
    state: "suspended",
    controlHolder: "none",
    maintenanceId: null,
  });
  await expect(readdir(path.join(dataDir, "homes"))).rejects.toThrow("ENOENT");
  expect((await carry(new MemoryVolumeFiles(), computer.id, fixture.context)).outcome).toBe(
    "carried",
  );
});
