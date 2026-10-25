import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
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
  deps = moveDeps(prisma);
});

/** The move only uses the provider's volume methods, which work on DATA_DIR alone. */
function moveDeps(client: PrismaClient) {
  const provider = new DockerWorkerProvider({
    supervisorUrl: "http://127.0.0.1:9",
    supervisorToken: "unused",
    dataDir,
  });
  return { prisma: client, workers: createWorkerLifecycle({ prisma: client, provider }), dataDir };
}

async function put(relative: string, content = relative) {
  const file = path.join(dataDir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function dockerComputer(
  scope: "team" | "dedicated",
  bots = 1,
  seed: ReturnType<typeof workerFixture> = fixture,
  client: PrismaClient = prisma,
) {
  const spaceId = await seed.seedSpace();
  const computer = await seed.seedComputer(spaceId, { kind: "docker", scope });
  const seeded = [];
  for (let index = 0; index < bots; index++) seeded.push(await seed.seedBot(spaceId, computer.id));
  // A dedicated home is keyed by its bot.
  const homeKey = scope === "dedicated" ? seeded[0]!.id : computer.homeKey;
  await client.computer.update({ where: { id: computer.id }, data: { homeKey } });
  return { computer: { ...computer, homeKey }, bots: seeded };
}

async function volumeDir(
  kind: "bot_private" | "space_shared",
  owner: { botId?: string; spaceId?: string },
  client: PrismaClient = prisma,
) {
  const volume = await client.volume.findFirstOrThrow({
    where: kind === "bot_private" ? { kind, botId: owner.botId } : { kind, spaceId: owner.spaceId },
  });
  return path.join(dataDir, "volumes", volume.providerRef!);
}

const storageOf = async (id: string) =>
  (await prisma.computer.findUniqueOrThrow({ where: { id } })).homeStorage;

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

    expect(move).toEqual({ outcome: "adopted", moved: [`bots/${ada.id}`, "shared"] });
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
    expect(await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })).toMatchObject({
      homeStorage: "volumes",
      maintenanceId: null,
    });
    await expect(moveDockerHomeToVolumes(deps, computer.id, fixture.context)).resolves.toEqual({
      outcome: "already_on_volumes",
    });
  });

  it("moves a dedicated home's entries but its dot entries and workspace link", async () => {
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
    // The link a computer on volumes makes is not a leftover.
    await symlink(volume, path.join(dataDir, home, "workspace"));
    await expect(moveDockerHomeToVolumes(deps, computer.id, fixture.context)).resolves.toEqual({
      outcome: "already_on_volumes",
    });
  });

  it("renames nothing when adoption is refused, so the computer boots on its whole home", async () => {
    const { computer, bots } = await dockerComputer("team");
    const home = `homes/${computer.homeKey}`;
    await put(`${home}/bots/${bots[0]!.id}/notes.md`, "ada");
    await put(`${home}/shared/team.txt`, "team");
    const refusing = {
      ...deps,
      workers: { ...deps.workers, adoptVolumeHome: async () => "home_revised" as const },
    };

    await expect(moveDockerHomeToVolumes(refusing, computer.id, fixture.context)).resolves.toEqual({
      outcome: "refused",
      code: "home_revised",
    });
    expect(await storageOf(computer.id)).toBe("snapshot");
    expect(await readFile(path.join(dataDir, home, "bots", bots[0]!.id, "notes.md"), "utf8")).toBe(
      "ada",
    );
    expect(await readFile(path.join(dataDir, home, "shared", "team.txt"), "utf8")).toBe("team");
    expect(await readdir(await volumeDir("space_shared", { spaceId: computer.spaceId }))).toEqual(
      [],
    );
  });

  it("finishes a move that stopped after adoption, dropping an empty folder a boot recreated", async () => {
    const { computer, bots } = await dockerComputer("team");
    const ada = bots[0]!;
    const home = `homes/${computer.homeKey}`;
    await put(`${home}/bots/${ada.id}/notes.md`, "ada");
    await put(`${home}/shared/team.txt`, "team");
    // The process dies once the computer adopted its volumes, after the bot folder moved.
    const crashing = {
      ...deps,
      workers: {
        ...deps.workers,
        adoptVolumeHome: async (...args: Parameters<typeof deps.workers.adoptVolumeHome>) => {
          await deps.workers.adoptVolumeHome(...args);
          const adaVolume = await volumeDir("bot_private", { botId: ada.id });
          await rename(path.join(dataDir, home, "bots", ada.id), adaVolume);
          await mkdir(path.join(dataDir, home, "bots", ada.id));
          throw new Error("killed");
        },
      },
    };
    await expect(moveDockerHomeToVolumes(crashing, computer.id, fixture.context)).rejects.toThrow(
      "killed",
    );
    expect(await storageOf(computer.id)).toBe("volumes");

    const move = await moveDockerHomeToVolumes(deps, computer.id, fixture.context);

    expect(move).toEqual({ outcome: "adopted", moved: ["shared"] });
    expect(await readdir(await volumeDir("bot_private", { botId: ada.id }))).toEqual(["notes.md"]);
    expect(await readdir(path.join(dataDir, home, "bots"))).toEqual([]);
    expect(await readdir(path.join(dataDir, home)).then((names) => names.sort())).toEqual(["bots"]);
  });

  it("moves a link or a file a guest planted in place of a folder as it is, never followed", async () => {
    const { computer, bots } = await dockerComputer("team");
    const elsewhere = await mkdtemp(path.join(tmpdir(), "rakazo-elsewhere-"));
    await writeFile(path.join(elsewhere, "secret"), "outside");
    const home = path.join(dataDir, "homes", computer.homeKey);
    await mkdir(path.join(home, "bots"), { recursive: true });
    await symlink(elsewhere, path.join(home, "bots", bots[0]!.id));
    await writeFile(path.join(home, "shared"), "a file");

    const move = await moveDockerHomeToVolumes(deps, computer.id, fixture.context);

    expect(move).toEqual({ outcome: "adopted", moved: [`bots/${bots[0]!.id}`, "shared"] });
    const adaVolume = await volumeDir("bot_private", { botId: bots[0]!.id });
    expect((await lstat(adaVolume)).isDirectory()).toBe(true);
    expect(await readlink(path.join(adaVolume, bots[0]!.id))).toBe(elsewhere);
    const sharedVolume = await volumeDir("space_shared", { spaceId: computer.spaceId });
    expect(await readFile(path.join(sharedVolume, "shared"), "utf8")).toBe("a file");
    expect(await readdir(elsewhere)).toEqual(["secret"]);
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

describe("moving every idle Docker home", () => {
  // A database of its own: the sweep visits every Docker computer.
  let own: PgliteDatabase;
  beforeAll(async () => {
    own = await openPgliteDatabase();
  });
  afterAll(() => own.close());

  it("defers only the home that conflicts with its volume and moves the others", async () => {
    const seed = workerFixture(own.prisma);
    await seed.seedOwner();
    const conflicting = await dockerComputer("team", 1, seed, own.prisma);
    const clean = await dockerComputer("team", 1, seed, own.prisma);
    const ownDeps = moveDeps(own.prisma);
    const [bot] = conflicting.bots;
    const volume = await ownDeps.workers.ensureVolume(
      { kind: "bot_private", spaceId: conflicting.computer.spaceId, botId: bot!.id },
      seed.context,
    );
    await put(`volumes/${volume.providerRef}/written-since.txt`);
    await put(`homes/${conflicting.computer.homeKey}/bots/${bot!.id}/notes.md`);
    await put(`homes/${clean.computer.homeKey}/shared/team.txt`);

    await expect(moveIdleDockerHomes(ownDeps, seed.context)).resolves.toEqual({
      adopted: 1,
      deferred: 1,
    });
    const storage = async (id: string) =>
      (await own.prisma.computer.findUniqueOrThrow({ where: { id } })).homeStorage;
    expect(await storage(conflicting.computer.id)).toBe("snapshot");
    expect(await storage(clean.computer.id)).toBe("volumes");
    expect(
      await readdir(path.join(dataDir, "homes", conflicting.computer.homeKey, "bots", bot!.id)),
    ).toEqual(["notes.md"]);
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
