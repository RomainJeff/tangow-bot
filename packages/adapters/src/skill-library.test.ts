import { execFileSync } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSkillMd, skillHistorySegments } from "@rakazo/core";
import { afterEach, describe, expect, it } from "vitest";
import type { BotWriteContext, SkillContent, SkillUid } from "./skill-library.js";
import {
  parseSkillUid,
  parseVersionId,
  purgeUserSkills,
  repairSkillLibrary,
  SkillRefusal,
} from "./skill-library.js";
import { fakeSkillPrisma, testLibrary } from "./skill-library.test-support.js";
import { createInMemorySkillLock } from "./skill-lock.js";
import { listUserSkills, skillDirName, userSkillsRoot } from "./skill-store.js";

const owner = { spaceId: "ws-1", userId: "user-1" };
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-skill-library-"));
  dirs.push(dir);
  return dir;
}

const md = (name: string, body = "Steps") =>
  buildSkillMd({ name, description: `About ${name}`, body });
const skillMd = (name: string, body?: string): SkillContent => ({
  kind: "skill-md",
  name,
  content: md(name, body),
});
const text = (value: string) => new TextEncoder().encode(value);
const files = (name: string, extra: Record<string, string>, executable: string[] = []) => ({
  kind: "files" as const,
  name,
  content: md(name),
  files: [
    { path: "SKILL.md", bytes: text(md(name)), executable: false },
    ...Object.entries(extra).map(([file, value]) => ({
      path: file,
      bytes: text(value),
      executable: executable.includes(file),
    })),
  ],
});
const bot = (runId: string, toolCallId = `${runId}-call`): BotWriteContext => ({
  botId: "bot-1",
  botName: "Ada",
  runId,
  toolCallId,
});
const liveDir = (data: string, name: string) =>
  path.join(userSkillsRoot(data, owner), skillDirName(name));
const liveSkillMd = (data: string, name: string) =>
  readFile(path.join(liveDir(data, name), "SKILL.md"), "utf8");
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "written",
    (error: unknown) => (error instanceof SkillRefusal ? error.reason : error),
  );
const rows = (prisma: ReturnType<typeof fakeSkillPrisma>) => ({
  settings: prisma.skillSetting.rows.map(({ skillKey, availability }) => ({
    skillKey,
    availability,
  })),
  bots: prisma.botSkill.rows.map(({ skillKey, botId, enabled }) => ({ skillKey, botId, enabled })),
});

describe("skill library", () => {
  it("keeps every write as a version and the live folder equal to the newest one", async () => {
    const data = await dataDir();
    const { library } = testLibrary(data);
    const admin = library.forOwner(owner);
    const created = await admin.create(skillMd("Deploy", "One"));
    await admin.update("user:deploy", skillMd("Deploy", "Two"));

    const versions = await admin.versions("user:deploy");
    expect(versions.map((v) => [v.seq, v.name, v.author.kind, v.nature])).toEqual([
      [2, "Deploy", "user", "modified"],
      [1, "Deploy", "user", "created"],
    ]);
    expect(versions.every((v) => v.uid === created.uid)).toBe(true);
    expect(versions[0]?.access).toEqual({ availability: null, bots: [] });
    expect(await liveSkillMd(data, "Deploy")).toBe(md("Deploy", "Two"));
  });

  it("names the bot, the exchange and the call behind a version and reserves a new skill to it", async () => {
    const data = await dataDir();
    const { library, prisma } = testLibrary(data);
    await library.forBot(owner, bot("run-1", "call-7")).create(skillMd("Deploy"));

    const [version] = await library.forOwner(owner).versions("user:deploy");
    expect(version?.author).toEqual({
      kind: "bot",
      botId: "bot-1",
      botName: "Ada",
      runId: "run-1",
      toolCallIds: ["call-7"],
    });
    expect(version?.access).toEqual({
      availability: "selected",
      bots: [{ botId: "bot-1", enabled: true }],
    });
    expect(rows(prisma)).toEqual({
      settings: [{ skillKey: "user:deploy", availability: "selected" }],
      bots: [{ skillKey: "user:deploy", botId: "bot-1", enabled: true }],
    });
  });

  it("writes a replayed tool call once", async () => {
    const data = await dataDir();
    const { library } = testLibrary(data);
    const writer = library.forBot(owner, bot("run-1", "call-1"));
    const first = await writer.create(skillMd("Deploy"));
    const replay = await writer.create(skillMd("Deploy"));
    expect(replay).toEqual({ ...first, changed: false });

    const update = library.forBot(owner, bot("run-2", "call-2"));
    await update.update("user:deploy", skillMd("Deploy", "Two"));
    await update.update("user:deploy", skillMd("Deploy", "Three"));
    expect((await library.forOwner(owner).versions("user:deploy")).map((v) => v.seq)).toEqual([
      2, 1,
    ]);
    expect(await liveSkillMd(data, "Deploy")).toBe(md("Deploy", "Two"));

    const rename = library.forBot(owner, bot("run-3", "call-3"));
    const renamed = await rename.update("user:deploy", skillMd("Ship"));
    expect(await rename.update("user:deploy", skillMd("Ship"))).toEqual({
      ...renamed,
      changed: false,
    });
    expect(await rename.replayed()).toEqual({ ...renamed, changed: false });
  });

  it("adds no version for content identical to the current one", async () => {
    const data = await dataDir();
    const { library } = testLibrary(data);
    const admin = library.forOwner(owner);
    await admin.create(skillMd("Deploy"));
    const again = await library
      .forBot(owner, bot("run-1"))
      .update("user:deploy", skillMd("Deploy"));
    expect(again.changed).toBe(false);
    expect((await admin.versions("user:deploy")).length).toBe(1);
  });

  it("folds every write of one exchange into one version", async () => {
    const data = await dataDir();
    const { library } = testLibrary(data);
    const admin = library.forOwner(owner);
    await admin.create(skillMd("Deploy", "Mine"));
    for (let i = 0; i < 25; i += 1) {
      await library
        .forBot(owner, bot("run-1", `call-${i}`))
        .update("user:deploy", skillMd("Deploy", `Bot ${i}`));
    }
    const versions = await admin.versions("user:deploy");
    expect(versions.map((v) => [v.author.kind, v.nature])).toEqual([
      ["bot", "modified"],
      ["user", "created"],
    ]);
    expect(versions[0]?.author.kind === "bot" && versions[0].author.toolCallIds.length).toBe(25);
    expect(await liveSkillMd(data, "Deploy")).toBe(md("Deploy", "Bot 24"));
  });

  it("keeps a skill written before history as a base version on its first change", async () => {
    const data = await dataDir();
    await mkdir(liveDir(data, "Legacy"), { recursive: true });
    await writeFile(path.join(liveDir(data, "Legacy"), "SKILL.md"), md("Legacy", "Old"));
    const { library } = testLibrary(data);
    await library.forBot(owner, bot("run-1")).update("user:legacy", skillMd("Legacy", "New"));

    const versions = await library.forOwner(owner).versions("user:legacy");
    expect(versions.map((v) => [v.author.kind, v.nature])).toEqual([
      ["bot", "modified"],
      ["unknown", "created"],
    ]);
  });

  it("records a change made outside the store as an unknown version", async () => {
    const data = await dataDir();
    const { library } = testLibrary(data);
    const admin = library.forOwner(owner);
    await admin.create(skillMd("Deploy", "Mine"));
    await writeFile(path.join(liveDir(data, "Deploy"), "SKILL.md"), md("Deploy", "Desktop"));
    await library.forBot(owner, bot("run-1")).update("user:deploy", skillMd("Deploy", "Bot"));

    const versions = await admin.versions("user:deploy");
    expect(versions.map((v) => [v.author.kind, v.nature])).toEqual([
      ["bot", "modified"],
      ["unknown", "unknown"],
      ["user", "created"],
    ]);
  });

  it("keeps twenty versions plus the user's last one and the one before the first bot write", async () => {
    const data = await dataDir();
    const { library } = testLibrary(data);
    const admin = library.forOwner(owner);
    await admin.create(skillMd("Deploy", "u1"));
    await library.forBot(owner, bot("run-0")).update("user:deploy", skillMd("Deploy", "b0"));
    await admin.update("user:deploy", skillMd("Deploy", "u3"));
    for (let i = 1; i <= 30; i += 1) {
      await library
        .forBot(owner, bot(`run-${i}`))
        .update("user:deploy", skillMd("Deploy", `b${i}`));
    }
    const seqs = (await admin.versions("user:deploy")).map((v) => v.seq);
    expect(seqs).toEqual([...Array.from({ length: 20 }, (_, i) => 33 - i), 3, 1]);
  });

  it("protects nothing beyond twenty versions of a skill a bot created", async () => {
    const data = await dataDir();
    const { library } = testLibrary(data);
    await library.forBot(owner, bot("run-0")).create(skillMd("Deploy", "b0"));
    await library
      .forBot(owner, bot("run-0", "again"))
      .update("user:deploy", skillMd("Deploy", "b0'"));
    for (let i = 1; i <= 21; i += 1) {
      await library
        .forBot(owner, bot(`run-${i}`))
        .update("user:deploy", skillMd("Deploy", `b${i}`));
    }
    const seqs = (await library.forOwner(owner).versions("user:deploy")).map((v) => v.seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => 23 - i));
  });

  it("moves a deleted skill and its access rows to the trash instead of erasing them", async () => {
    const data = await dataDir();
    const { library, prisma } = testLibrary(data);
    const admin = library.forOwner(owner);
    const { uid } = await library
      .forBot(owner, bot("run-1"))
      .create(files("Deploy", { "scripts/run.sh": "echo" }));

    await library.forBot(owner, bot("run-2")).delete("user:deploy");
    expect(await listUserSkills(userSkillsRoot(data, owner))).toEqual([]);
    expect(rows(prisma)).toEqual({ settings: [], bots: [] });
    expect((await admin.trash()).map((entry) => [entry.uid, entry.name])).toEqual([
      [uid, "Deploy"],
    ]);
  });

  it("keeps history across a rename and moves the access rows with it", async () => {
    const data = await dataDir();
    const { library, prisma } = testLibrary(data);
    const admin = library.forOwner(owner);
    const { uid } = await library.forBot(owner, bot("run-1")).create(skillMd("Deploy"));
    const renamed = await admin.update("user:deploy", skillMd("Ship"));

    expect(renamed).toMatchObject({ uid, key: "user:ship" });
    expect((await admin.versions("user:ship")).map((v) => [v.uid, v.name])).toEqual([
      [uid, "Ship"],
      [uid, "Deploy"],
    ]);
    expect(rows(prisma)).toEqual({
      settings: [{ skillKey: "user:ship", availability: "selected" }],
      bots: [{ skillKey: "user:ship", botId: "bot-1", enabled: true }],
    });
  });

  it("refuses ids shaped like paths", () => {
    expect(parseSkillUid("0123456789abcdef0123456789abcdef")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    expect(parseSkillUid("../../etc")).toBeUndefined();
    expect(parseVersionId("v000001-0a1b2c3d")).toBe("v000001-0a1b2c3d");
    expect(parseVersionId("v000001-0a1b2c3d/../x")).toBeUndefined();
  });

  it("gives bots only the three writes and their replay", () => {
    const { library } = testLibrary("/unused");
    expect(Object.keys(library.forBot(owner, bot("run-1"))).sort()).toEqual([
      "create",
      "delete",
      "replayed",
      "update",
    ]);
    expect(Object.keys(library.forOwner(owner)).sort()).toEqual([
      "create",
      "delete",
      "replayed",
      "setAccess",
      "trash",
      "update",
      "versions",
    ]);
  });

  it("orders two concurrent writers through the owner lock, losing neither", async () => {
    const data = await dataDir();
    const lock = createInMemorySkillLock();
    const prisma = fakeSkillPrisma();
    const api = testLibrary(data, { prisma, lock }).library;
    const worker = testLibrary(data, { prisma, lock }).library;
    await api.forOwner(owner).create(skillMd("Deploy", "Base"));

    await Promise.all([
      worker.forBot(owner, bot("run-1")).update("user:deploy", skillMd("Deploy", "Worker")),
      api.forOwner(owner).update("user:deploy", skillMd("Deploy", "Editor")),
    ]);
    const versions = await api.forOwner(owner).versions("user:deploy");
    expect(versions.map((v) => v.seq)).toEqual([3, 2, 1]);
    expect(await liveSkillMd(data, "Deploy")).toBe(
      versions[0]?.author.kind === "bot" ? md("Deploy", "Worker") : md("Deploy", "Editor"),
    );
  });

  describe("history storage", () => {
    it("lives outside the folder mounted into the bot's computer", async () => {
      const data = await dataDir();
      const { library } = testLibrary(data);
      await library.forOwner(owner).create(skillMd("Deploy"));
      await library.forOwner(owner).update("user:deploy", skillMd("Deploy", "Two"));
      await library.forOwner(owner).create(skillMd("Gone"));
      await library.forOwner(owner).delete("user:gone");

      expect(await readdir(userSkillsRoot(data, owner))).toEqual(["deploy"]);
      const history = path.join(data, ...skillHistorySegments(owner));
      expect(path.relative(userSkillsRoot(data, owner), history).startsWith("..")).toBe(true);
      expect((await readdir(history)).sort()).toEqual(["skills"]);
    });

    it("stores no executable bit and replays it only under scripts/", async () => {
      const data = await dataDir();
      const { library } = testLibrary(data);
      await library
        .forOwner(owner)
        .create(
          files("Deploy", { "scripts/run.sh": "echo", "tools/run.sh": "echo" }, [
            "scripts/run.sh",
            "tools/run.sh",
          ]),
        );

      const executable = async (file: string) => ((await lstat(file)).mode & 0o111) !== 0;
      expect(await executable(path.join(liveDir(data, "Deploy"), "scripts/run.sh"))).toBe(true);
      expect(await executable(path.join(liveDir(data, "Deploy"), "tools/run.sh"))).toBe(false);
      const [version] = await library.forOwner(owner).versions("user:deploy");
      const stored = path.join(
        data,
        ...skillHistorySegments(owner),
        "skills",
        version?.uid ?? "",
        "versions",
        version?.versionId ?? "",
        "files",
        "scripts/run.sh",
      );
      expect(await executable(stored)).toBe(false);
      expect(version?.files.find((file) => file.path === "scripts/run.sh")?.executable).toBe(true);
    });

    it("refuses a write rather than follow or drop a link, FIFO or hard link it cannot keep", async () => {
      const data = await dataDir();
      const admin = testLibrary(data).library.forOwner(owner);
      await admin.create(files("Deploy", { "notes.md": "n" }));
      const dir = liveDir(data, "Deploy");
      const write = () => refusal(admin.update("user:deploy", skillMd("Deploy", "Two")));
      await link(path.join(dir, "notes.md"), path.join(dir, "hard.md"));
      expect(await write()).toBe("invalid");
      await rm(path.join(dir, "hard.md"));
      await symlink("/etc/passwd", path.join(dir, "passwd"));
      expect(await write()).toBe("invalid");
      await rm(path.join(dir, "passwd"));
      execFileSync("mkfifo", [path.join(dir, "pipe")]);
      expect(await write()).toBe("invalid");

      expect((await readdir(dir)).sort()).toEqual(["SKILL.md", "notes.md", "pipe"]);
      expect(await readFile(path.join(dir, "notes.md"), "utf8")).toBe("n");
      await rm(path.join(dir, "pipe"));
      expect((await admin.versions("user:deploy")).map((v) => v.seq)).toEqual([1]);
    });

    it("skips a SKILL.md that is a link when listing", async () => {
      const data = await dataDir();
      const target = path.join(data, "elsewhere.md");
      await writeFile(target, md("Sneaky"));
      await mkdir(liveDir(data, "Sneaky"), { recursive: true });
      await symlink(target, path.join(liveDir(data, "Sneaky"), "SKILL.md"));
      expect(await listUserSkills(userSkillsRoot(data, owner))).toEqual([]);
    });

    it("lists a skill whose SKILL.md is hard-linked and names the link when refusing a change", async () => {
      const data = await dataDir();
      const admin = testLibrary(data).library.forOwner(owner);
      await admin.create(skillMd("Deploy"));
      await link(path.join(liveDir(data, "Deploy"), "SKILL.md"), path.join(data, "snapshot.md"));

      expect((await listUserSkills(userSkillsRoot(data, owner))).map((s) => s.id)).toEqual([
        "user:deploy",
      ]);
      const error = await admin.update("user:deploy", skillMd("Deploy", "Two")).catch((e) => e);
      expect([error.reason, error.message]).toEqual([
        "invalid",
        "SKILL.md is a hard link, and a skill keeps only plain files. Remove it and try again.",
      ]);
    });

    it("keeps a name like .. inside the owner's folder and refuses one too long for a folder", async () => {
      const data = await dataDir();
      const { library, prisma } = testLibrary(data);
      const admin = library.forOwner(owner);
      await admin.create(skillMd(".."));
      expect(await readdir(userSkillsRoot(data, owner))).toEqual(["%2E."]);

      const emoji = "\u{1F680}".repeat(40);
      expect(await refusal(library.forBot(owner, bot("run-1")).create(skillMd(emoji)))).toBe(
        "invalid",
      );
      expect(await readdir(userSkillsRoot(data, owner))).toEqual(["%2E."]);
      expect(rows(prisma)).toEqual({ settings: [], bots: [] });
      expect((await admin.trash()).length).toBe(0);
    });
  });

  describe("cleanup", () => {
    it("purges a deleted account's skills, history and trash in every space", async () => {
      const data = await dataDir();
      const { library } = testLibrary(data);
      const other = { spaceId: "ws-1", userId: "user-2" };
      for (const who of [owner, { spaceId: "ws-2", userId: "user-1" }, other]) {
        await library.forOwner(who).create(skillMd("Deploy"));
        await library.forOwner(who).create(skillMd("Gone"));
        await library.forOwner(who).delete("user:gone");
      }
      await purgeUserSkills(data, "user-1");
      expect((await readdir(path.join(data, "skills", "user", "ws-1"))).sort()).toEqual(["user-2"]);
      expect(await readdir(path.join(data, "skill-history", "ws-2"))).toEqual([]);
      expect((await library.forOwner(other).trash()).length).toBe(1);
    });

    it("keeps access rows with no skill at startup and leaves erasing history to account deletion", async () => {
      const data = await dataDir();
      const prisma = fakeSkillPrisma({ users: ["user-1"] });
      const { library } = testLibrary(data, { prisma });
      await library.forOwner(owner).create(skillMd("Deploy"));
      await library.forOwner({ spaceId: "ws-1", userId: "ghost" }).create(skillMd("Old"));
      prisma.skillSetting.rows.push({
        ...owner,
        skillKey: "user:vanished",
        availability: "selected",
      });
      await mkdir(path.join(userSkillsRoot(data, owner), ".import-abc123", "bundle"), {
        recursive: true,
      });

      await repairSkillLibrary({
        prisma: prisma as never,
        dataDir: data,
        lock: createInMemorySkillLock(),
      });
      expect((await readdir(path.join(data, "skill-history", "ws-1"))).sort()).toEqual([
        "ghost",
        "user-1",
      ]);
      expect(rows(prisma).settings).toEqual([
        { skillKey: "user:vanished", availability: "selected" },
      ]);
      expect(await readdir(userSkillsRoot(data, owner))).toEqual(["deploy"]);
    });

    it("keeps a skill reserved to its bot when the skills folder is briefly missing", async () => {
      const data = await dataDir();
      const lock = createInMemorySkillLock();
      const { library, prisma } = testLibrary(data, { lock });
      await library.forBot(owner, bot("run-1")).create(skillMd("Deploy"));
      const root = userSkillsRoot(data, owner);
      await rename(root, `${root}.away`);

      await repairSkillLibrary({ prisma: prisma as never, dataDir: data, lock });
      await rename(`${root}.away`, root);
      expect(rows(prisma)).toEqual({
        settings: [{ skillKey: "user:deploy", availability: "selected" }],
        bots: [{ skillKey: "user:deploy", botId: "bot-1", enabled: true }],
      });
      expect(await library.forOwner(owner).trash()).toEqual([]);
    });
  });
});

describe("one owner's broken folder", () => {
  const a = { spaceId: "ws-1", userId: "user-a" };
  const b = { spaceId: "ws-1", userId: "user-b" };
  const sweepAll = (data: string, prisma: ReturnType<typeof fakeSkillPrisma>) =>
    repairSkillLibrary({ prisma: prisma as never, dataDir: data, lock: createInMemorySkillLock() });

  async function twoOwners() {
    const data = await dataDir();
    const prisma = fakeSkillPrisma({ users: ["user-a", "user-b"] });
    const { library } = testLibrary(data, { prisma });
    await library.forOwner(a).create(skillMd("A"));
    await library.forOwner(b).create(skillMd("B"));
    await rm(path.join(userSkillsRoot(data, b), skillDirName("B")), { recursive: true });
    await mkdir(path.join(userSkillsRoot(data, b), ".import-abc123"));
    return { data, prisma, library };
  }
  const swept = (data: string) => readdir(userSkillsRoot(data, b));

  it("heals a stray file in its history and never stops the sweep of other owners", async () => {
    const { data, prisma, library } = await twoOwners();
    await writeFile(path.join(data, ...skillHistorySegments(a), "skills", "0".repeat(32)), "x");

    await sweepAll(data, prisma);
    expect(await swept(data)).toEqual([]);
    expect(await refusal(library.forOwner(a).create(skillMd("A2")))).toBe("written");
  });

  it("refuses with a message while its folder is unusable, then works once it is fixed", async () => {
    const { data, prisma, library } = await twoOwners();
    await rm(userSkillsRoot(data, a), { recursive: true });
    await writeFile(userSkillsRoot(data, a), "not a folder");

    await sweepAll(data, prisma);
    expect(await swept(data)).toEqual([]);
    const error = await library
      .forOwner(a)
      .create(skillMd("A2"))
      .catch((e) => e);
    expect([error.reason, error.message]).toEqual([
      "unavailable",
      "Skills are unavailable right now. Try again later.",
    ]);
    await rm(userSkillsRoot(data, a));
    expect(await refusal(library.forOwner(a).create(skillMd("A2")))).toBe("written");
  });
});

describe("store safety", () => {
  const history = (data: string) => path.join(data, ...skillHistorySegments(owner), "skills");
  const versionDirs = async (data: string) => {
    const [uid] = await readdir(history(data));
    const dir = path.join(history(data), uid ?? "", "versions");
    return { uid: uid as SkillUid, dir, names: (await readdir(dir)).sort() };
  };
  const deep = (name: string, count: number) => ({
    kind: "files" as const,
    name,
    content: md(name),
    files: Array.from({ length: count }, (_, i) => ({
      path: `references/d${i % 9}/f${i}.md`,
      bytes: text("x"),
      executable: false,
    })),
  });

  it("counts folders like the import does, so a skill it accepts stays editable", async () => {
    const data = await dataDir();
    const admin = testLibrary(data).library.forOwner(owner);
    // SKILL.md, references/, nine folders and 190 files: 201 entries.
    expect(await refusal(admin.create(deep("Wide", 190)))).toBe("invalid");
    expect(await refusal(admin.create(deep("Full", 189)))).toBe("written");
    expect(await refusal(admin.update("user:full", skillMd("Full", "Two")))).toBe("written");
    expect(await refusal(admin.delete("user:full"))).toBe("written");
    expect((await admin.trash()).map((entry) => entry.name)).toEqual(["Full"]);
  });

  it("still deletes a skill whose folder outgrew the caps outside the store", async () => {
    const data = await dataDir();
    const admin = testLibrary(data).library.forOwner(owner);
    await admin.create(skillMd("Big", "Kept"));
    await mkdir(path.join(liveDir(data, "Big"), "references"));
    for (let i = 0; i < 205; i += 1) {
      await writeFile(path.join(liveDir(data, "Big"), "references", `n${i}.md`), "x");
    }
    expect(await refusal(admin.update("user:big", skillMd("Big", "New")))).toBe("invalid");
    expect(await refusal(admin.delete("user:big"))).toBe("written");
    expect(await listUserSkills(userSkillsRoot(data, owner))).toEqual([]);
    expect((await admin.trash()).map((entry) => entry.name)).toEqual(["Big"]);
  });

  it("keeps every version when the history was snapshotted with hard links", async () => {
    const data = await dataDir();
    const admin = testLibrary(data).library.forOwner(owner);
    await admin.create(skillMd("Deploy", "One"));
    await admin.update("user:deploy", skillMd("Deploy", "Two"));
    const { dir, names } = await versionDirs(data);
    const snapshot = await dataDir();
    for (const name of names) {
      await link(path.join(dir, name, "manifest.json"), path.join(snapshot, `${name}.json`));
      await link(path.join(dir, name, "files", "SKILL.md"), path.join(snapshot, `${name}.md`));
    }
    await repairSkillLibrary({
      prisma: fakeSkillPrisma() as never,
      dataDir: data,
      lock: createInMemorySkillLock(),
    });
    expect((await admin.versions("user:deploy")).map((v) => v.seq)).toEqual([2, 1]);
  });

  it("works around a manifest torn by a power cut and keeps it on disk", async () => {
    const data = await dataDir();
    const { library } = testLibrary(data);
    const admin = library.forOwner(owner);
    await admin.create(skillMd("A"));
    await admin.create(skillMd("B"));
    let torn = "";
    for (const uid of await readdir(history(data))) {
      const [version] = await readdir(path.join(history(data), uid, "versions"));
      const manifest = path.join(history(data), uid, "versions", version ?? "", "manifest.json");
      if (JSON.parse(await readFile(manifest, "utf8")).name === "A") torn = manifest;
    }
    await writeFile(torn, "");

    expect(await refusal(admin.delete("user:b"))).toBe("written");
    expect(await refusal(library.forBot(owner, bot("run-1")).create(skillMd("C")))).toBe("written");
    await repairSkillLibrary({
      prisma: fakeSkillPrisma() as never,
      dataDir: data,
      lock: createInMemorySkillLock(),
    });
    expect(await readFile(torn, "utf8")).toBe("");
  });

  it("rebuilds a skill whose entry is unreadable from its versions", async () => {
    const data = await dataDir();
    const admin = testLibrary(data).library.forOwner(owner);
    const { uid } = await admin.create(skillMd("Deploy", "One"));
    await admin.update("user:deploy", skillMd("Deploy", "Two"));
    await writeFile(path.join(history(data), uid, "skill.json"), "{");

    expect((await admin.versions("user:deploy")).map((v) => [v.uid, v.seq])).toEqual([
      [uid, 2],
      [uid, 1],
    ]);
    expect((await admin.update("user:deploy", skillMd("Deploy", "Three"))).changed).toBe(true);
  });

  it("drops an unreadable journal entry instead of blocking every write", async () => {
    const data = await dataDir();
    const admin = testLibrary(data).library.forOwner(owner);
    await admin.create(skillMd("Deploy"));
    const journal = path.join(data, ...skillHistorySegments(owner), "journal");
    await mkdir(journal, { recursive: true });
    await writeFile(path.join(journal, `${"a".repeat(32)}.json`), "");

    expect(await refusal(admin.update("user:deploy", skillMd("Deploy", "Two")))).toBe("written");
  });

  it("keeps twenty versions when changes keep arriving from outside the store", async () => {
    const data = await dataDir();
    const admin = testLibrary(data).library.forOwner(owner);
    await admin.create(skillMd("Deploy", "Mine"));
    for (let i = 0; i < 24; i += 1) {
      await writeFile(path.join(liveDir(data, "Deploy"), "SKILL.md"), md("Deploy", `Desk ${i}`));
      await admin.versions("user:deploy");
    }
    expect((await admin.versions("user:deploy")).length).toBe(21);
  });
});
