import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@rakazo/db";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { moveDockerHomeToVolumes, moveIdleDockerHomes } from "./docker-home-migration.js";
import { DockerWorkerProvider } from "./docker-worker.js";
import { assertE2BHomesOnVolumes, E2BHomesNotMigrated } from "./home-volume-migration.js";
import { workerFixture } from "./worker-fixture.test-support.js";
import { createWorkerLifecycle } from "./worker-lifecycle.js";

let database: PgliteDatabase;
let prisma: PrismaClient;
let fixture: ReturnType<typeof workerFixture>;
let dataDir: string;
let deps: Parameters<typeof moveDockerHomeToVolumes>[0];

beforeAll(async () => {
  database = await openPgliteDatabase();
  prisma = database.prisma;
  fixture = workerFixture(prisma);
  await fixture.seedOwner();
});
afterAll(() => database.close());
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-docker-home-"));
  // The move only uses the provider's volume methods, which work on DATA_DIR alone.
  const provider = new DockerWorkerProvider({
    supervisorUrl: "http://127.0.0.1:9",
    supervisorToken: "unused",
    dataDir,
  });
  deps = { prisma, workers: createWorkerLifecycle({ prisma, provider }), dataDir };
});

async function put(relative: string, content = relative) {
  const file = path.join(dataDir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function dockerComputer(scope: "team" | "dedicated", bots = 1) {
  const spaceId = await fixture.seedSpace();
  const computer = await fixture.seedComputer(spaceId, { kind: "docker", scope });
  const seeded = [];
  for (let index = 0; index < bots; index++)
    seeded.push(await fixture.seedBot(spaceId, computer.id));
  // A dedicated home is keyed by its bot.
  const homeKey = scope === "dedicated" ? seeded[0]!.id : computer.homeKey;
  await prisma.computer.update({ where: { id: computer.id }, data: { homeKey } });
  return { computer: { ...computer, homeKey }, bots: seeded };
}

async function volumeDir(
  kind: "bot_private" | "space_shared",
  owner: { botId?: string; spaceId?: string },
) {
  const volume = await prisma.volume.findFirstOrThrow({
    where: kind === "bot_private" ? { kind, botId: owner.botId } : { kind, spaceId: owner.spaceId },
  });
  return path.join(dataDir, "volumes", volume.providerRef!);
}

describe("moving a Docker home onto its volumes", () => {
  it("renames a team home's bot and shared folders into their volumes, links included", async () => {
    const { computer, bots } = await dockerComputer("team", 2);
    const [ada, bob] = bots as [(typeof bots)[0], (typeof bots)[0]];
    const home = `homes/${computer.homeKey}`;
    await put(`${home}/bots/${ada.id}/notes.md`, "ada");
    await put(`${home}/shared/team.txt`, "team");
    await put(`${home}/.bashrc`, "dotfile");
    await put(`${home}/.browser-profiles/chromium-bot-x/Preferences`, "{}");
    await symlink("/etc/passwd", path.join(dataDir, home, "bots", ada.id, "passwd"));

    const move = await moveDockerHomeToVolumes(deps, computer.id, fixture.context);

    expect(move).toEqual({ outcome: "adopted", moved: [`bots/${ada.id}`, "shared"].sort() });
    const adaVolume = await volumeDir("bot_private", { botId: ada.id });
    expect(await readFile(path.join(adaVolume, "notes.md"), "utf8")).toBe("ada");
    expect(await readlink(path.join(adaVolume, "passwd"))).toBe("/etc/passwd");
    expect(await readdir(await volumeDir("bot_private", { botId: bob.id }))).toEqual([]);
    expect(
      await readFile(
        path.join(await volumeDir("space_shared", { spaceId: computer.spaceId }), "team.txt"),
        "utf8",
      ),
    ).toBe("team");
    expect((await readdir(path.join(dataDir, home))).sort()).toEqual([
      ".bashrc",
      ".browser-profiles",
      "bots",
    ]);
    expect(await readdir(path.join(dataDir, home, "bots"))).toEqual([]);
    expect(await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })).toMatchObject({
      homeStorage: "volumes",
      maintenanceId: null,
    });
    await expect(moveDockerHomeToVolumes(deps, computer.id, fixture.context)).resolves.toEqual({
      outcome: "already_on_volumes",
    });
  });

  it("moves a dedicated home's entries but its dot entries into the bot's volume", async () => {
    const { computer, bots } = await dockerComputer("dedicated");
    const home = `homes/${computer.homeKey}`;
    await put(`${home}/project/main.py`, "print()");
    await put(`${home}/notes.md`, "notes");
    await put(`${home}/.config/app.json`, "{}");

    const move = await moveDockerHomeToVolumes(deps, computer.id, fixture.context);

    expect(move).toEqual({ outcome: "adopted", moved: ["notes.md", "project"] });
    const volume = await volumeDir("bot_private", { botId: bots[0]!.id });
    expect((await readdir(volume)).sort()).toEqual(["notes.md", "project"]);
    expect(await readdir(path.join(dataDir, home))).toEqual([".config"]);
  });

  it("resumes after an interrupted move, dropping an empty folder a boot recreated", async () => {
    const { computer, bots } = await dockerComputer("team");
    const home = `homes/${computer.homeKey}`;
    await put(`${home}/bots/${bots[0]!.id}/notes.md`, "ada");
    await put(`${home}/shared/team.txt`, "team");
    // The first run renamed the bot folder, then stopped; a boot recreated it empty.
    const privateVolume = await deps.workers.ensureVolume(
      { kind: "bot_private", spaceId: computer.spaceId, botId: bots[0]!.id },
      fixture.context,
    );
    const target = path.join(dataDir, "volumes", privateVolume.providerRef);
    await put(`volumes/${privateVolume.providerRef}/notes.md`, "ada");
    await rm(path.join(dataDir, home, "bots", bots[0]!.id, "notes.md"));

    const move = await moveDockerHomeToVolumes(deps, computer.id, fixture.context);

    expect(move).toEqual({ outcome: "adopted", moved: ["shared"] });
    expect(await readdir(target)).toEqual(["notes.md"]);
    expect(await readdir(path.join(dataDir, home, "bots"))).toEqual([]);
  });

  it("refuses a link in place of a home folder and moves nothing", async () => {
    const { computer } = await dockerComputer("team");
    const elsewhere = await mkdtemp(path.join(tmpdir(), "rakazo-elsewhere-"));
    await mkdir(path.join(dataDir, "homes", computer.homeKey), { recursive: true });
    await symlink(elsewhere, path.join(dataDir, "homes", computer.homeKey, "bots"));

    await expect(moveDockerHomeToVolumes(deps, computer.id, fixture.context)).rejects.toThrow(
      /is not a directory/,
    );
    expect(
      (await lstat(path.join(dataDir, "homes", computer.homeKey, "bots"))).isSymbolicLink(),
    ).toBe(true);
    expect(await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })).toMatchObject({
      homeStorage: "snapshot",
      maintenanceId: null,
    });
  });

  it("leaves a running computer's home for when it suspends", async () => {
    const { computer, bots } = await dockerComputer("team");
    await put(`homes/${computer.homeKey}/bots/${bots[0]!.id}/notes.md`);
    await prisma.computer.update({ where: { id: computer.id }, data: { state: "running" } });

    await expect(moveIdleDockerHomes(deps, fixture.context, computer.id)).resolves.toEqual({
      adopted: 0,
      deferred: 1,
    });
    expect(await readdir(path.join(dataDir, "homes", computer.homeKey, "bots"))).toEqual([
      bots[0]!.id,
    ]);
  });
});

describe("the API's start", () => {
  it("refuses while an E2B home is on snapshots, and names the operator's move", async () => {
    const spaceId = await fixture.seedSpace();
    await dockerComputer("team");
    const e2b = await fixture.seedComputer(spaceId, { kind: "e2b" });

    const refused = assertE2BHomesOnVolumes(prisma);
    await expect(refused).rejects.toBeInstanceOf(E2BHomesNotMigrated);
    await expect(refused).rejects.toThrow(e2b.id);
    await expect(refused).rejects.toThrow("scripts/migrate-home-to-volumes.ts");

    await prisma.computer.update({ where: { id: e2b.id }, data: { homeStorage: "volumes" } });
    await expect(assertE2BHomesOnVolumes(prisma)).resolves.toBeUndefined();
  });
});
