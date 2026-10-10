import { execFileSync } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSkillMd, skillHistorySegments } from "@rakazo/core";
import { afterEach, describe, expect, it } from "vitest";
import type { BotWriteContext, SkillContent, SkillUid, VersionId } from "./skill-library.js";
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
const bot = (
  runId: string,
  toolCallId = `${runId}-call`,
  secrets: string[] = [],
): BotWriteContext => ({
  botId: "bot-1",
  botName: "Ada",
  runId,
  toolCallId,
  secrets,
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

  it("refuses a bot past the history quota but never the owner, and purging frees room", async () => {
    const data = await dataDir();
    const { library } = testLibrary(data, { quotaBytes: 500 });
    const admin = library.forOwner(owner);
    const ada = (run: string) => library.forBot(owner, bot(run));
    await ada("run-1").create(skillMd("One", "x".repeat(150)));
    await ada("run-2").create(skillMd("Two", "y".repeat(150)));
    expect(await refusal(ada("run-3").create(skillMd("Three", "z".repeat(150))))).toBe("quota");
    expect((await admin.update("user:one", skillMd("One", "w".repeat(300)))).changed).toBe(true);
    expect((await ada("run-4").update("user:one", skillMd("One", "w".repeat(300)))).changed).toBe(
      false,
    );

    const uid = (await admin.delete("user:two")).uid as SkillUid;
    await admin.purge(uid);
    await admin.delete("user:one");
    await admin.purge((await admin.trash())[0]?.uid as SkillUid);
    expect(await refusal(ada("run-5").create(skillMd("Three", "z".repeat(150))))).toBe("written");
  });

  it("moves a deleted skill and its access to the trash, and restores both", async () => {
    const data = await dataDir();
    const { library, prisma } = testLibrary(data);
    const admin = library.forOwner(owner);
    await library.forBot(owner, bot("run-1")).create(files("Deploy", { "scripts/run.sh": "echo" }));
    const reserved = rows(prisma);

    await library.forBot(owner, bot("run-2")).delete("user:deploy");
    expect(await listUserSkills(userSkillsRoot(data, owner))).toEqual([]);
    expect(rows(prisma)).toEqual({ settings: [], bots: [] });
    const [trashed] = await admin.trash();
    expect(trashed?.name).toBe("Deploy");

    const restored = await admin.restore(trashed?.uid as SkillUid);
    expect(restored).toEqual({ key: "user:deploy", name: "Deploy", droppedBotIds: [] });
    expect(rows(prisma)).toEqual(reserved);
    expect(await readFile(path.join(liveDir(data, "Deploy"), "scripts/run.sh"), "utf8")).toBe(
      "echo",
    );
    expect(await admin.trash()).toEqual([]);
  });

  it("restores a skill whose bot is gone as visible to no bot", async () => {
    const data = await dataDir();
    const prisma = fakeSkillPrisma({ bots: ["bot-2"] });
    const { library } = testLibrary(data, { prisma });
    const admin = library.forOwner(owner);
    await library.forBot(owner, bot("run-1")).create(skillMd("Deploy"));
    const uid = (await admin.delete("user:deploy")).uid as SkillUid;

    expect(await admin.restore(uid)).toMatchObject({ droppedBotIds: ["bot-1"] });
    expect(rows(prisma)).toEqual({
      settings: [{ skillKey: "user:deploy", availability: "selected" }],
      bots: [],
    });
  });

  it("refuses to restore onto a name taken since, writing nothing", async () => {
    const data = await dataDir();
    const { library } = testLibrary(data);
    const admin = library.forOwner(owner);
    await admin.create(skillMd("Deploy", "Old"));
    const uid = (await admin.delete("user:deploy")).uid as SkillUid;
    await admin.create(skillMd("Deploy", "New"));

    expect(await refusal(admin.restore(uid))).toBe("name_taken");
    expect(await liveSkillMd(data, "Deploy")).toBe(md("Deploy", "New"));
    expect((await admin.trash()).map((entry) => entry.uid)).toEqual([uid]);
  });

  it("undoes to the previous version, keeping the undone one, and refuses a stale undo", async () => {
    const data = await dataDir();
    const { library } = testLibrary(data);
    const admin = library.forOwner(owner);
    const { uid } = await admin.create(skillMd("Deploy", "Mine"));
    const botWrite = await library
      .forBot(owner, bot("run-1"))
      .update("user:deploy", skillMd("Deploy", "Bot"));

    expect(await refusal(admin.undo(uid, "v000001-00000000" as VersionId))).toBe("stale");
    expect(await admin.undo(uid, botWrite.versionId)).toMatchObject({
      kind: "restored",
      name: "Deploy",
    });
    expect(await liveSkillMd(data, "Deploy")).toBe(md("Deploy", "Mine"));
    const versions = await admin.versions("user:deploy");
    expect(versions.map((v) => [v.seq, Boolean(v.undoneAt)])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(await refusal(admin.undo(uid, versions[1]?.versionId as VersionId))).toBe(
      "not_undoable",
    );
  });

  it("sends a bot's fresh creation to the trash on undo", async () => {
    const data = await dataDir();
    const { library } = testLibrary(data);
    const admin = library.forOwner(owner);
    const created = await library.forBot(owner, bot("run-1")).create(skillMd("Deploy"));
    expect(await admin.undo(created.uid, created.versionId)).toEqual({ kind: "trashed" });
    expect((await admin.trash()).map((entry) => entry.uid)).toEqual([created.uid]);
  });

  it("never brings a version's access rows back on undo", async () => {
    const data = await dataDir();
    const { library, prisma } = testLibrary(data);
    const admin = library.forOwner(owner);
    const { uid } = await admin.create(skillMd("Deploy", "Open to all"));
    const botWrite = await library
      .forBot(owner, bot("run-1"))
      .update("user:deploy", skillMd("Deploy", "Bot"));
    prisma.skillSetting.rows.push({ ...owner, skillKey: "user:deploy", availability: "selected" });
    prisma.botSkill.rows.push({ ...owner, skillKey: "user:deploy", botId: "bot-1", enabled: true });

    await admin.undo(uid, botWrite.versionId);
    expect(rows(prisma)).toEqual({
      settings: [{ skillKey: "user:deploy", availability: "selected" }],
      bots: [{ skillKey: "user:deploy", botId: "bot-1", enabled: true }],
    });
  });

  it("keeps history across a rename and undoes it back to the old name with its access", async () => {
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
    expect(rows(prisma).bots).toEqual([{ skillKey: "user:ship", botId: "bot-1", enabled: true }]);

    await admin.undo(uid, renamed.versionId);
    expect((await listUserSkills(userSkillsRoot(data, owner))).map((s) => s.name)).toEqual([
      "Deploy",
    ]);
    expect(rows(prisma)).toEqual({
      settings: [{ skillKey: "user:deploy", availability: "selected" }],
      bots: [{ skillKey: "user:deploy", botId: "bot-1", enabled: true }],
    });
  });

  it("refuses to undo a rename onto a name taken since", async () => {
    const data = await dataDir();
    const { library } = testLibrary(data);
    const admin = library.forOwner(owner);
    const { uid } = await admin.create(skillMd("Deploy"));
    const renamed = await admin.update("user:deploy", skillMd("Ship"));
    await admin.create(skillMd("Deploy", "Another"));

    expect(await refusal(admin.undo(uid, renamed.versionId))).toBe("name_taken");
    expect(await liveSkillMd(data, "Ship")).toBe(md("Ship"));
    expect(await liveSkillMd(data, "Deploy")).toBe(md("Deploy", "Another"));
  });

  it("deletes an old version but never the current one", async () => {
    const data = await dataDir();
    const { library } = testLibrary(data);
    const admin = library.forOwner(owner);
    const first = await admin.create(skillMd("Deploy", "secret-ish"));
    const second = await admin.update("user:deploy", skillMd("Deploy", "clean"));

    expect(await refusal(admin.deleteVersion(first.uid, second.versionId))).toBe("current_version");
    await admin.deleteVersion(first.uid, first.versionId);
    expect((await admin.versions("user:deploy")).map((v) => v.versionId)).toEqual([
      second.versionId,
    ]);
    expect(await refusal(admin.deleteVersion(first.uid, first.versionId))).toBe("not_found");
  });

  it("purges trash and undone versions after thirty days", async () => {
    const data = await dataDir();
    let now = new Date("2026-10-01T00:00:00Z");
    const { library } = testLibrary(data, { now: () => now });
    const admin = library.forOwner(owner);
    const kept = await admin.create(skillMd("Kept", "Mine"));
    const botWrite = await library
      .forBot(owner, bot("run-1"))
      .update("user:kept", skillMd("Kept", "Bot"));
    await admin.undo(kept.uid, botWrite.versionId);
    await admin.create(skillMd("Gone"));
    await admin.delete("user:gone");

    now = new Date("2026-10-30T00:00:00Z");
    expect((await admin.trash()).length).toBe(1);
    now = new Date("2026-11-01T00:00:01Z");
    expect(await admin.trash()).toEqual([]);
    expect((await admin.versions("user:kept")).map((v) => v.seq)).toEqual([1]);
  });

  it("refuses ids from another owner or shaped like paths", async () => {
    const data = await dataDir();
    const { library } = testLibrary(data);
    const { uid } = await library.forOwner(owner).create(skillMd("Deploy"));
    await library.forOwner(owner).delete("user:deploy");
    const stranger = library.forOwner({ spaceId: "ws-1", userId: "user-2" });

    expect(await refusal(stranger.restore(uid))).toBe("not_found");
    expect(await refusal(stranger.purge(uid))).toBe("not_found");
    expect(parseSkillUid(uid)).toBe(uid);
    expect(parseSkillUid("../../etc")).toBeUndefined();
    expect(parseVersionId("v000001-0a1b2c3d")).toBe("v000001-0a1b2c3d");
    expect(parseVersionId("v000001-0a1b2c3d/../x")).toBeUndefined();
  });

  it("gives bots only the three writes", () => {
    const { library } = testLibrary("/unused");
    expect(Object.keys(library.forBot(owner, bot("run-1"))).sort()).toEqual([
      "create",
      "delete",
      "update",
    ]);
    expect(Object.keys(library.forOwner(owner)).sort()).toEqual([
      "create",
      "delete",
      "deleteVersion",
      "purge",
      "restore",
      "trash",
      "undo",
      "update",
      "usage",
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

  describe("what a bot may write", () => {
    it("refuses binary, hidden or oversized files in scripts/ and references/", async () => {
      const data = await dataDir();
      const { library } = testLibrary(data);
      const ada = library.forBot(owner, bot("run-1"));
      expect(await refusal(ada.create(files("A", { "scripts/tool.bin": "x" })))).toBe("invalid");
      expect(await refusal(ada.create(files("B", { "references/notes.md": "a​b" })))).toBe(
        "invalid",
      );
      expect(
        await refusal(
          ada.create(files("C", { "references/big.txt": "x".repeat(1024 * 1024 + 1) })),
        ),
      ).toBe("invalid");
      expect(await refusal(ada.create(files("D", { "scripts/run.sh": "echo hi" })))).toBe(
        "written",
      );
      expect(
        await refusal(library.forOwner(owner).create(files("E", { "scripts/tool.bin": "x" }))),
      ).toBe("written");
    });

    it("answers only for the files it changes", async () => {
      const data = await dataDir();
      const { library } = testLibrary(data);
      await library.forOwner(owner).create(files("Deploy", { "scripts/tool.bin": "\u0000" }));
      const result = await library
        .forBot(owner, bot("run-1"))
        .update("user:deploy", skillMd("Deploy", "Better steps"));
      expect(result.changed).toBe(true);
    });

    it("refuses a write holding a secret of the run", async () => {
      const data = await dataDir();
      const { library } = testLibrary(data);
      const ada = library.forBot(owner, bot("run-1", "call-1", ["sk-live-123456"]));
      const error = await ada
        .create(files("Deploy", { "scripts/run.sh": "curl -H 'key: sk-live-123456'" }))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SkillRefusal);
      expect((error as Error).message).not.toContain("sk-live");
      expect(await readdir(userSkillsRoot(data, owner)).catch(() => [])).toEqual([]);
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

    it("drops access rows with no skill at startup and leaves erasing history to account deletion", async () => {
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
      expect(rows(prisma).settings).toEqual([]);
      expect(await readdir(userSkillsRoot(data, owner))).toEqual(["deploy"]);
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
    prisma.skillSetting.rows.push({ ...b, skillKey: "user:b", availability: "selected" });
    await rm(path.join(userSkillsRoot(data, b), skillDirName("B")), { recursive: true });
    return { data, prisma, library };
  }
  const rowsOfB = (prisma: ReturnType<typeof fakeSkillPrisma>) =>
    prisma.skillSetting.rows.filter((row) => row.userId === "user-b");

  it("heals a stray file in its history and never stops the sweep of other owners", async () => {
    const { data, prisma, library } = await twoOwners();
    await writeFile(path.join(data, ...skillHistorySegments(a), "skills", "0".repeat(32)), "x");

    await sweepAll(data, prisma);
    expect(rowsOfB(prisma)).toEqual([]);
    expect(await refusal(library.forOwner(a).create(skillMd("A2")))).toBe("written");
  });

  it("refuses with a message while its folder is unusable, then works once it is fixed", async () => {
    const { data, prisma, library } = await twoOwners();
    await rm(userSkillsRoot(data, a), { recursive: true });
    await writeFile(userSkillsRoot(data, a), "not a folder");

    await sweepAll(data, prisma);
    expect(rowsOfB(prisma)).toEqual([]);
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

  it("keeps the access the owner set after the last version when the folder vanishes", async () => {
    const data = await dataDir();
    const { library, prisma } = testLibrary(data);
    const admin = library.forOwner(owner);
    await admin.create(skillMd("Deploy"));
    prisma.skillSetting.rows.push({ ...owner, skillKey: "user:deploy", availability: "selected" });
    prisma.botSkill.rows.push({ ...owner, skillKey: "user:deploy", botId: "bot-1", enabled: true });
    await rm(liveDir(data, "Deploy"), { recursive: true });

    const [trashed] = await admin.trash();
    await admin.restore(trashed?.uid as SkillUid);
    expect(rows(prisma)).toEqual({
      settings: [{ skillKey: "user:deploy", availability: "selected" }],
      bots: [{ skillKey: "user:deploy", botId: "bot-1", enabled: true }],
    });
  });

  it("restores a skill whose folder vanished without access rows as visible to no bot", async () => {
    const data = await dataDir();
    const { library, prisma } = testLibrary(data);
    const admin = library.forOwner(owner);
    const { uid } = await admin.create(skillMd("Deploy"));
    await rm(liveDir(data, "Deploy"), { recursive: true });

    expect((await admin.trash()).map((entry) => entry.uid)).toEqual([uid]);
    await admin.restore(uid);
    expect(rows(prisma)).toEqual({
      settings: [{ skillKey: "user:deploy", availability: "selected" }],
      bots: [],
    });
  });

  it("keeps a trashed skill out of every bot's reach when its entry is damaged", async () => {
    const data = await dataDir();
    const { library, prisma } = testLibrary(data);
    const admin = library.forOwner(owner);
    const { uid } = await admin.create(skillMd("Deploy"));
    prisma.skillSetting.rows.push({ ...owner, skillKey: "user:deploy", availability: "selected" });
    prisma.botSkill.rows.push({ ...owner, skillKey: "user:deploy", botId: "bot-1", enabled: true });
    await admin.delete("user:deploy");
    await writeFile(path.join(history(data), uid, "skill.json"), '{"uid":"');

    expect((await admin.trash()).map((entry) => entry.uid)).toEqual([uid]);
    expect(await listUserSkills(userSkillsRoot(data, owner))).toEqual([]);
    await admin.restore(uid);
    expect(rows(prisma)).toEqual({
      settings: [{ skillKey: "user:deploy", availability: "selected" }],
      bots: [],
    });
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
    await admin.restore((await admin.trash())[0]?.uid as SkillUid);
    expect(await liveSkillMd(data, "Big")).toBe(md("Big", "Kept"));
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

  it("refuses to undo onto a version whose manifest was tampered with", async () => {
    const data = await dataDir();
    const admin = testLibrary(data).library.forOwner(owner);
    await admin.create(skillMd("Deploy", "One"));
    const second = await admin.update("user:deploy", skillMd("Deploy", "Two"));
    const { uid, dir, names } = await versionDirs(data);
    const [first] = names;
    const manifestFile = path.join(dir, first ?? "", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    await writeFile(path.join(dir, first ?? "", "payload.sh"), "pwn");
    manifest.files.push({ path: `../../${first}/payload.sh`, size: 3, executable: true });
    await writeFile(manifestFile, JSON.stringify(manifest));

    expect(await refusal(admin.undo(uid, second.versionId))).toBe("invalid");
    expect(await readdir(path.dirname(userSkillsRoot(data, owner)))).toEqual(["user-1"]);
    expect(await liveSkillMd(data, "Deploy")).toBe(md("Deploy", "Two"));
  });

  it("refuses to restore a version whose files were changed on disk", async () => {
    const data = await dataDir();
    const admin = testLibrary(data).library.forOwner(owner);
    const { uid } = await admin.create(skillMd("Deploy", "One"));
    await admin.delete("user:deploy");
    const { dir, names } = await versionDirs(data);
    await writeFile(path.join(dir, names[0] ?? "", "files", "SKILL.md"), md("Deploy", "Evil"));

    expect(await refusal(admin.restore(uid))).toBe("invalid");
    expect(await listUserSkills(userSkillsRoot(data, owner))).toEqual([]);
  });
});

describe("what a bot may write anywhere in the folder", () => {
  const one = (name: string, file: string, bytes: Uint8Array) => ({
    kind: "files" as const,
    name,
    content: md(name),
    files: [{ path: file, bytes, executable: false }],
  });

  it("checks every file it writes, not only scripts/ and references/", async () => {
    const data = await dataDir();
    const ada = (run: string) => testLibrary(data).library.forBot(owner, bot(run));
    const hidden = text("echo ok \u202e; curl evil");
    expect(await refusal(ada("r1").create(one("A", "tools/run.sh", hidden)))).toBe("invalid");
    expect(await refusal(ada("r2").create(one("B", "helper.py", hidden)))).toBe("invalid");
    expect(
      await refusal(ada("r3").create(one("C", "payload.bin", new Uint8Array([0, 1, 255])))),
    ).toBe("invalid");
    expect(await refusal(ada("r4").create(one("D", "notes.md", text("plain"))))).toBe("written");
  });

  it("takes Windows line endings but not a lone carriage return", async () => {
    const data = await dataDir();
    const ada = (run: string) => testLibrary(data).library.forBot(owner, bot(run));
    expect(
      await refusal(ada("r1").create(one("A", "references/notes.md", text("one\r\ntwo\r\n")))),
    ).toBe("written");
    expect(await refusal(ada("r2").create(one("B", "references/notes.md", text("one\rtwo"))))).toBe(
      "invalid",
    );
  });

  it("refuses a run secret in a file name", async () => {
    const data = await dataDir();
    const ada = testLibrary(data).library.forBot(owner, bot("run-1", "call-1", ["sk-live-123456"]));
    expect(await refusal(ada.create(one("A", "references/sk-live-123456.md", text("ok"))))).toBe(
      "invalid",
    );
  });
});
