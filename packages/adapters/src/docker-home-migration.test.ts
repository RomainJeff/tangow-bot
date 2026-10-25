import {
  chmod,
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
import { createThreadEvents } from "@rakazo/db";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { provisionComputer } from "./computer-lifecycle.js";
import {
  copyLegacyUserSkills,
  homeMovePending,
  moveDockerHomeToVolumes,
  moveIdleDockerHomes,
} from "./docker-home-migration.js";
import { DockerWorkerProvider } from "./docker-worker.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";
import { assertE2BHomesOnVolumes, E2BHomesNotMigrated } from "./home-volume-migration.js";
import { skillDirName } from "./skill-store.js";
import { InMemoryJobQueue } from "./wakeup.js";
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

  it("moves a dedicated home's entries but its dot entries, then never touches the home again", async () => {
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
    // What the person makes in ~ afterwards is theirs: no marker, so no sweep moves it.
    await mkdir(path.join(dataDir, home, "notes"));
    await expect(moveIdleDockerHomes(deps, fixture.context, computer.id)).resolves.toEqual({
      adopted: 0,
      deferred: 0,
    });
    expect((await readdir(path.join(dataDir, home))).sort()).toEqual([".config", "notes"]);
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
    expect(await homeMovePending(path.join(dataDir, home))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps a computer whose move failed midway from booting until a sweep finishes it",
    async () => {
      const { computer, bots } = await dockerComputer("team");
      const ada = bots[0]!;
      const home = path.join(dataDir, "homes", computer.homeKey);
      await put(`homes/${computer.homeKey}/bots/${ada.id}/notes.md`, "ada");
      await put(`homes/${computer.homeKey}/shared/team.txt`, "team");
      // The bot folder moves, then the shared folder cannot leave the read-only home.
      const failing = {
        ...deps,
        workers: {
          ...deps.workers,
          adoptVolumeHome: async (...args: Parameters<typeof deps.workers.adoptVolumeHome>) => {
            const adopted = await deps.workers.adoptVolumeHome(...args);
            await chmod(home, 0o555);
            return adopted;
          },
        },
      };

      // Storage the move cannot write is the deployment's problem: the sweep fails, not defers.
      await expect(moveIdleDockerHomes(failing, fixture.context, computer.id)).rejects.toThrow(
        /EACCES/,
      );
      await chmod(home, 0o755);
      expect(await storageOf(computer.id)).toBe("volumes");
      expect(await homeMovePending(home)).toBe(true);
      const boot = provisionComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: new LocalAgentHomeStore(dataDir),
          jobs: new InMemoryJobQueue(),
          events: createThreadEvents(prisma),
          dataDir,
        },
        computer.id,
        { ...fixture.context, spaceId: computer.spaceId },
      );
      await expect(boot).rejects.toMatchObject({ reason: "home_move_incomplete" });

      await expect(moveIdleDockerHomes(deps, fixture.context, computer.id)).resolves.toEqual({
        adopted: 1,
        deferred: 0,
      });
      expect(await homeMovePending(home)).toBe(false);
      expect(await readdir(await volumeDir("bot_private", { botId: ada.id }))).toEqual([
        "notes.md",
      ]);
      expect(await readdir(await volumeDir("space_shared", { spaceId: computer.spaceId }))).toEqual(
        ["team.txt"],
      );
    },
  );

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

  it.each([
    { state: "error", minutesAgo: 0, moves: true },
    { state: "booting", minutesAgo: 10, moves: true },
    { state: "suspending", minutesAgo: 10, moves: true },
    { state: "booting", minutesAgo: 1, moves: false },
  ])(
    "moves a home whose computer an upgrade left $state $minutesAgo min ago: $moves",
    async ({ state, minutesAgo, moves }) => {
      const { computer, bots } = await dockerComputer("team");
      await put(`homes/${computer.homeKey}/bots/${bots[0]!.id}/notes.md`);
      await prisma.$executeRaw`UPDATE computers SET state = ${state},
      "updatedAt" = ${new Date(Date.now() - minutesAgo * 60_000)} WHERE id = ${computer.id}`;

      await expect(moveIdleDockerHomes(deps, fixture.context, computer.id)).resolves.toEqual({
        adopted: moves ? 1 : 0,
        deferred: moves ? 0 : 1,
      });
      expect(await storageOf(computer.id)).toBe(moves ? "volumes" : "snapshot");
    },
  );

  it("skips a dedicated home whose bot moved away, on a DATA_DIR with no volumes yet", async () => {
    const { computer, bots } = await dockerComputer("dedicated");
    await put(`homes/${computer.homeKey}/notes.md`, "notes");
    await prisma.bot.update({ where: { id: bots[0]!.id }, data: { computerId: null } });

    await expect(moveIdleDockerHomes(deps, fixture.context, computer.id)).resolves.toEqual({
      adopted: 0,
      deferred: 1,
    });
    expect(await storageOf(computer.id)).toBe("snapshot");
    expect(await readdir(path.join(dataDir, "homes", computer.homeKey))).toEqual(["notes.md"]);
  });

  it("lets a computer other than Docker boot with a move marker in its home", async () => {
    const spaceId = await fixture.seedSpace();
    const computer = await fixture.seedComputer(spaceId, { kind: "e2b" });
    await put(`homes/${computer.homeKey}/.rakazo-move-pending`, "");

    const boot = provisionComputer(
      {
        prisma,
        sandbox: new FakeSandboxProvider(),
        home: new LocalAgentHomeStore(dataDir),
        jobs: new InMemoryJobQueue(),
        events: createThreadEvents(prisma),
        dataDir,
      },
      computer.id,
      { ...fixture.context, spaceId },
    );

    await expect(boot).resolves.toBeDefined();
  });
});

describe("copying legacy user skills to the shared volume", () => {
  const skill = (spaceId: string, user: string, name: string, body = "Steps.") =>
    put(
      `skills/user/${spaceId}/${user}/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: Does ${name}.\n---\n${body}\n`,
    );

  it("waits for the team home, then copies once, never through a link, never over a file", async () => {
    const { computer } = await dockerComputer("team");
    const { spaceId } = computer;
    await put(`homes/${computer.homeKey}/shared/team.txt`, "team");
    await skill(spaceId, "ada", "deploy");
    await skill(spaceId, "ada", "taken", "Ada's steps.");
    await mkdir(path.join(dataDir, `skills/user/${spaceId}/ada/linked`));
    await symlink("/etc/passwd", path.join(dataDir, `skills/user/${spaceId}/ada/linked/SKILL.md`));

    await expect(copyLegacyUserSkills(deps, spaceId, fixture.context)).resolves.toBe("waiting");

    await moveDockerHomeToVolumes(deps, computer.id, fixture.context);
    const volume = await volumeDir("space_shared", { spaceId });
    const taken = path.join(volume, "skills", skillDirName("taken"), "SKILL.md");
    await mkdir(path.dirname(taken), { recursive: true });
    await writeFile(taken, "the volume's own");
    await expect(copyLegacyUserSkills(deps, spaceId, fixture.context)).resolves.toBe("copied");

    expect(await readFile(path.join(volume, "team.txt"), "utf8")).toBe("team");
    expect(
      await readFile(path.join(volume, "skills", skillDirName("deploy"), "SKILL.md"), "utf8"),
    ).toContain("name: deploy");
    expect(await readFile(taken, "utf8")).toBe("the volume's own");
    expect((await readdir(path.join(volume, "skills"))).sort()).toEqual(
      [skillDirName("deploy"), skillDirName("taken")].sort(),
    );

    // Copied once: a skill the bots deleted since is not brought back.
    await rm(path.join(volume, "skills", skillDirName("deploy")), { recursive: true });
    await expect(copyLegacyUserSkills(deps, spaceId, fixture.context)).resolves.toBe(
      "already_copied",
    );
    expect(await readdir(path.join(volume, "skills"))).toEqual([skillDirName("taken")]);
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
