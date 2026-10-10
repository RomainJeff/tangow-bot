import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SkillUid } from "@rakazo/adapters";
import {
  createInMemorySkillLock,
  createSkillLibrary,
  listUserSkills,
  marketplacesRoot,
  userSkillsRoot,
} from "@rakazo/adapters";
import { buildSkillMd } from "@rakazo/core";
import { IsolationError, type PrismaClient } from "@rakazo/db";
import { create as tarCreate } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";
import { createAgentSkillsService } from "./agent-skills.js";

type Row = Record<string, unknown>;
const matches = (row: Row, where: Row) =>
  Object.entries(where).every(([key, value]) => row[key] === value);

// ponytail: same in-memory table shape as packages/adapters/src/skill-tools.test.ts.
function table(store: Row[]) {
  return {
    findMany: vi.fn(async ({ where = {} }: { where?: Row } = {}) =>
      store.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hits = store.filter((row) => matches(row, where));
      for (const row of hits) Object.assign(row, data);
      return { count: hits.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      const kept = store.filter((row) => !matches(row, where));
      const count = store.length - kept.length;
      store.splice(0, store.length, ...kept);
      return { count };
    }),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: Record<string, Row>;
        create: Row;
        update: Row;
      }) => {
        const key = Object.values(where)[0] ?? {};
        const index = store.findIndex((row) => matches(row, key));
        if (index >= 0) {
          store[index] = { ...store[index], ...update };
          return store[index];
        }
        const row = { id: `row-${store.length + 1}`, ...create };
        store.push(row);
        return row;
      },
    ),
    _store: store,
  };
}

const actor = { spaceId: "ws-1", userId: "user-1" } as never;

describe("agent skills service (filesystem)", () => {
  let dataDir: string;
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    bot: { findMany: ReturnType<typeof vi.fn> };
    skillSetting: ReturnType<typeof table>;
    botSkill: ReturnType<typeof table>;
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-api-skills-"));
    prisma = {
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
      bot: {
        findMany: vi.fn(async ({ where }: { where?: { id?: { in: string[] } } } = {}) =>
          [{ id: "bot-1" }, { id: "bot-2" }].filter(
            (bot) => !where?.id || where.id.in.includes(bot.id),
          ),
        ),
      },
      skillSetting: table([]),
      botSkill: table([]),
    };
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const service = () =>
    createAgentSkillsService(prisma as unknown as PrismaClient, dataDir, createInMemorySkillLock());

  it("creates, lists, renames (cascading access rows) and removes a skill", async () => {
    const skills = service();
    const created = await skills.create(actor, {
      content: buildSkillMd({ name: "Daily Standup", description: "Notes", body: "Steps" }),
    });
    expect(created.id).toBe("user:daily standup");
    expect(created.readOnly).toBe(false);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await skills.setAccess(actor, {
      skillId: created.id,
      availability: "selected",
      bots: [{ botId: "bot-1", enabled: true }],
    });
    const listed = await skills.list(actor);
    expect(listed.find((s) => s.id === created.id)).toMatchObject({
      availability: "selected",
      visibleBotIds: ["bot-1"],
    });
    expect((await skills.list(actor, { botId: "bot-2" })).map((s) => s.id)).not.toContain(
      created.id,
    );

    const renamed = await skills.update(actor, { skillId: created.id, name: "Standup" });
    expect(renamed.id).toBe("user:standup");
    expect(prisma.skillSetting._store).toEqual([
      expect.objectContaining({ skillKey: "user:standup", availability: "selected" }),
    ]);
    expect(prisma.botSkill._store).toEqual([
      expect.objectContaining({ skillKey: "user:standup", botId: "bot-1", enabled: true }),
    ]);
    const files = await listUserSkills(userSkillsRoot(dataDir, actor));
    expect(files.map((f) => f.name)).toEqual(["Standup"]);

    const replaced = await skills.update(actor, { skillId: renamed.id, description: "Better" });
    expect(replaced.id).toBe("user:standup");
    expect(replaced.description).toBe("Better");

    await skills.remove(actor, renamed.id);
    expect(await listUserSkills(userSkillsRoot(dataDir, actor))).toEqual([]);
    expect(prisma.skillSetting._store).toEqual([]);
    expect(prisma.botSkill._store).toEqual([]);

    // Removed, not gone: the skill waits in the trash with its access, ready to come back.
    const admin = createSkillLibrary({
      prisma: prisma as unknown as PrismaClient,
      dataDir,
      lock: createInMemorySkillLock(),
    }).forOwner(actor);
    const [trashed] = await admin.trash();
    expect(trashed?.name).toBe("Standup");
    await admin.restore(trashed?.uid as SkillUid);
    expect((await skills.list(actor)).find((s) => s.id === "user:standup")).toMatchObject({
      description: "Better",
      availability: "selected",
      visibleBotIds: ["bot-1"],
    });
  });

  it("never loses an access change made while a rename moves the rows", async () => {
    const lock = createInMemorySkillLock();
    const skills = createAgentSkillsService(prisma as unknown as PrismaClient, dataDir, lock);
    const created = await skills.create(actor, {
      content: buildSkillMd({ name: "Daily Standup", description: "Notes", body: "Steps" }),
    });
    const rename = createSkillLibrary({
      prisma: prisma as unknown as PrismaClient,
      dataDir,
      lock,
    })
      .forOwner(actor)
      .update(created.id, {
        kind: "skill-md",
        name: "Standup",
        content: buildSkillMd({ name: "Standup", description: "Notes", body: "Steps" }),
      });
    const findBots = prisma.bot.findMany.getMockImplementation();
    prisma.bot.findMany.mockImplementationOnce(async (args) => {
      await rename.catch(() => undefined);
      return findBots?.(args);
    });
    const narrowed = await skills
      .setAccess(actor, {
        skillId: created.id,
        availability: "selected",
        bots: [{ botId: "bot-1", enabled: true }],
      })
      .then(
        () => "applied",
        (error: unknown) => (error instanceof IsolationError ? "gone" : error),
      );
    await rename;

    const rows = prisma.skillSetting._store.map((row) => [row.skillKey, row.availability]);
    expect({ narrowed, rows }).toEqual({ narrowed: "gone", rows: [] });
  });

  describe("history", () => {
    const stranger = { spaceId: "ws-2", userId: "user-2" } as never;
    const body = (text: string) =>
      buildSkillMd({ name: "Standup", description: "Notes", body: text });

    it("lists versions newest first, reads one, undoes it and keeps the undone one readable", async () => {
      const skills = service();
      const created = await skills.create(actor, { content: body("One") });
      await skills.update(actor, { skillId: created.id, content: body("Two") });

      const [second, first] = await skills.versions(actor, { skillId: created.id });
      expect([second, first]).toEqual([
        expect.objectContaining({
          author: { kind: "user" },
          nature: "modified",
          current: true,
          undone: false,
        }),
        expect.objectContaining({
          author: { kind: "user" },
          nature: "created",
          current: false,
          undone: false,
        }),
      ]);
      const detail = await skills.version(actor, {
        skillId: created.id,
        versionId: first?.versionId as string,
      });
      expect(detail.content).toContain("One");
      expect(detail.files).toEqual([{ path: "SKILL.md", size: Buffer.byteLength(detail.content) }]);

      expect(
        await skills.undo(actor, {
          skillId: created.id,
          expectedVersionId: second?.versionId as string,
        }),
      ).toEqual({ kind: "restored", skillId: "user:standup", name: "Standup" });
      expect((await skills.get(actor, { skillId: created.id })).content).toContain("One");
      expect(
        (await skills.versions(actor, { skillId: created.id })).map((v) => [v.current, v.undone]),
      ).toEqual([
        [false, true],
        [true, false],
      ]);
    });

    it("lists no version for a skill that has no history yet, and none for an unknown one", async () => {
      const skills = service();
      const folder = path.join(userSkillsRoot(dataDir, actor), "standup");
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "SKILL.md"), body("Written before the history"));

      expect(await skills.versions(actor, { skillId: "user:standup" })).toEqual([]);
      await expect(skills.versions(actor, { skillId: "user:unknown" })).rejects.toBeInstanceOf(
        IsolationError,
      );
    });

    it("gives a user skill a uid that survives a rename, and none to a built-in", async () => {
      const skills = service();
      const created = await skills.create(actor, { content: body("One") });
      await skills.update(actor, {
        skillId: created.id,
        content: buildSkillMd({ name: "Daily", description: "Notes", body: "One" }),
      });
      const entries = await skills.list(actor);
      const daily = entries.find((entry) => entry.id === "user:daily");
      const fetched = await skills.get(actor, { skillId: "user:daily" });
      await skills.remove(actor, "user:daily");
      const [trashed] = await skills.trash(actor);

      expect({
        created: created.uid,
        listed: daily?.uid,
        fetched: fetched.uid,
        builtin: entries.find((entry) => entry.id === "builtin:Routines")?.uid,
      }).toEqual({
        created: trashed?.uid,
        listed: trashed?.uid,
        fetched: trashed?.uid,
        builtin: undefined,
      });
      expect(trashed?.uid).toMatch(/^[0-9a-f]{32}$/);
    });

    it("refuses an undo whose expected version is no longer current", async () => {
      const skills = service();
      const created = await skills.create(actor, { content: body("One") });
      await skills.update(actor, { skillId: created.id, content: body("Two") });
      const [, first] = await skills.versions(actor, { skillId: created.id });

      await expect(
        skills.undo(actor, { skillId: created.id, expectedVersionId: first?.versionId as string }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "This skill changed. Reload and try again.",
      });
      expect((await skills.get(actor, { skillId: created.id })).content).toContain("Two");
    });

    it("answers service unavailable when the skill folder cannot be used", async () => {
      const broken = createAgentSkillsService(prisma as unknown as PrismaClient, dataDir, {
        run: async () => {
          throw Object.assign(new Error("EACCES: permission denied"), { syscall: "mkdir" });
        },
      });

      const skills = service();
      const created = await skills.create(actor, { content: body("One") });
      const [current] = await skills.versions(actor, { skillId: created.id });
      const gone = await skills.create(actor, {
        content: buildSkillMd({ name: "Retro", description: "Notes", body: "Two" }),
      });
      await skills.remove(actor, gone.id);
      const [trashed] = await skills.trash(actor);
      const skillId = created.id;
      const versionId = current?.versionId as string;
      const uid = trashed?.uid as string;

      for (const call of [
        () =>
          broken.create(actor, {
            content: buildSkillMd({ name: "Planning", description: "Notes", body: "One" }),
          }),
        () => broken.versions(actor, { skillId }),
        () => broken.version(actor, { skillId, versionId }),
        () => broken.undo(actor, { skillId, expectedVersionId: versionId }),
        () => broken.deleteVersion(actor, { skillId, versionId }),
        () => broken.trash(actor),
        () => broken.restore(actor, { uid }),
        () => broken.purge(actor, { uid }),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      }
    });

    it("deletes an old version but never the current one", async () => {
      const skills = service();
      const created = await skills.create(actor, { content: body("One") });
      await skills.update(actor, { skillId: created.id, content: body("Two") });
      const [second, first] = await skills.versions(actor, { skillId: created.id });

      await expect(
        skills.deleteVersion(actor, {
          skillId: created.id,
          versionId: second?.versionId as string,
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "The current version cannot be deleted.",
      });
      expect(
        await skills.deleteVersion(actor, {
          skillId: created.id,
          versionId: first?.versionId as string,
        }),
      ).toEqual({ ok: true });
      expect((await skills.versions(actor, { skillId: created.id })).length).toBe(1);
    });

    it("trashes, restores and purges, refusing a restore onto a name taken since", async () => {
      const skills = service();
      const created = await skills.create(actor, { content: body("One") });
      await skills.remove(actor, created.id);
      const [trashed] = await skills.trash(actor);
      expect(trashed).toMatchObject({ name: "Standup" });

      await skills.create(actor, { content: body("Other") });
      await expect(skills.restore(actor, { uid: trashed?.uid as string })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(await skills.trash(actor)).toHaveLength(1);

      await skills.remove(actor, created.id);
      expect(await skills.trash(actor)).toHaveLength(2);
      const [older] = (await skills.trash(actor)).filter((t) => t.uid === trashed?.uid);
      expect(await skills.purge(actor, { uid: older?.uid as string })).toEqual({ ok: true });
      expect((await skills.trash(actor)).map((t) => t.uid)).not.toContain(trashed?.uid);
    });

    it("restores a skill reserved to a bot that is gone and says no bot can use it", async () => {
      const skills = service();
      const lock = createInMemorySkillLock();
      const library = createSkillLibrary({
        prisma: prisma as unknown as PrismaClient,
        dataDir,
        lock,
      });
      const botSkills = createAgentSkillsService(prisma as unknown as PrismaClient, dataDir, lock);
      await library
        .forBot(actor, {
          botId: "bot-1",
          botName: "Ada",
          runId: "run-1",
          toolCallId: "call-1",
          secrets: [],
        })
        .create({ kind: "skill-md", name: "Standup", content: body("One") });
      await botSkills.remove(actor, "user:standup");

      prisma.bot.findMany.mockResolvedValue([]);
      const [trashed] = await skills.trash(actor);
      expect(await botSkills.restore(actor, { uid: trashed?.uid as string })).toEqual({
        skillId: "user:standup",
        name: "Standup",
        botGone: true,
      });
    });

    it("answers another owner's skill, version and trash ids as unknown", async () => {
      const skills = service();
      const created = await skills.create(actor, { content: body("One") });
      await skills.update(actor, { skillId: created.id, content: body("Two") });
      const [second, first] = await skills.versions(actor, { skillId: created.id });
      await skills.create(actor, { name: "Gone", description: "G" });
      await skills.remove(actor, "user:gone");
      const [trashed] = await skills.trash(actor);

      const attempts = [
        skills.versions(stranger, { skillId: created.id }),
        skills.version(stranger, { skillId: created.id, versionId: first?.versionId as string }),
        skills.undo(stranger, {
          skillId: created.id,
          expectedVersionId: second?.versionId as string,
        }),
        skills.deleteVersion(stranger, {
          skillId: created.id,
          versionId: first?.versionId as string,
        }),
        skills.restore(stranger, { uid: trashed?.uid as string }),
        skills.purge(stranger, { uid: trashed?.uid as string }),
      ];
      for (const attempt of attempts) await expect(attempt).rejects.toBeInstanceOf(IsolationError);
      expect(await skills.trash(stranger)).toEqual([]);
      expect(await skills.trash(actor)).toHaveLength(1);
    });
  });

  it("rejects duplicate names with CONFLICT and unknown ids with IsolationError", async () => {
    const skills = service();
    await skills.create(actor, { name: "Alpha", description: "A" });
    await expect(skills.create(actor, { name: "alpha", description: "B" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(skills.get(actor, { skillId: "user:ghost" })).rejects.toBeInstanceOf(
      IsolationError,
    );
    await expect(skills.update(actor, { skillId: "builtin:x", name: "Y" })).rejects.toBeInstanceOf(
      IsolationError,
    );
    await expect(skills.remove(actor, "builtin:x")).rejects.toBeInstanceOf(IsolationError);
  });

  it("imports a plain-text .skill through the create path", async () => {
    const skills = service();
    const content = buildSkillMd({ name: "Plain", description: "P", body: "Body" });
    const imported = await skills.import(actor, { data: Buffer.from(content).toString("base64") });
    expect(imported).toMatchObject({ id: "user:plain", name: "Plain", description: "P" });
    await expect(
      skills.import(actor, { data: Buffer.from(content).toString("base64") }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      skills.import(actor, { data: Buffer.from("no frontmatter").toString("base64") }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Zip magic goes to the bundle path now, so the text path never gets to refuse it.
    await expect(
      skills.import(actor, {
        data: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]).toString("base64"),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.not.stringMatching(/Not a \.skill file/),
    });
  });

  it("imports a tar.gz bundle with its extra files, rejecting bad frontmatter and duplicates", async () => {
    const skills = service();
    async function bundle(skillMd: string): Promise<string> {
      const src = await mkdtemp(path.join(tmpdir(), "rakazo-bundle-"));
      try {
        await mkdir(path.join(src, "scripts"));
        await writeFile(path.join(src, "SKILL.md"), skillMd, "utf8");
        await writeFile(path.join(src, "scripts", "run.sh"), "echo hi", "utf8");
        await tarCreate({ gzip: true, cwd: src, file: path.join(src, "out.skill") }, [
          "SKILL.md",
          "scripts",
        ]);
        return (await readFile(path.join(src, "out.skill"))).toString("base64");
      } finally {
        await rm(src, { recursive: true, force: true });
      }
    }
    const imported = await skills.import(actor, {
      data: await bundle(buildSkillMd({ name: "Deploy", description: "D", body: "Steps" })),
    });
    expect(imported).toMatchObject({ id: "user:deploy", name: "Deploy", source: "user" });
    const dir = path.join(userSkillsRoot(dataDir, actor), "deploy");
    expect(await readFile(path.join(dir, "scripts", "run.sh"), "utf8")).toBe("echo hi");
    expect(
      (await skills.list(actor)).map((s) => s.id).filter((id) => !id.startsWith("builtin:")),
    ).toEqual(["user:deploy"]);

    await expect(
      skills.import(actor, { data: await bundle("no frontmatter") }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/frontmatter/) });
    await expect(
      skills.import(actor, {
        data: await bundle(buildSkillMd({ name: "deploy", description: "Again", body: "" })),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await skills.get(actor, { skillId: "user:deploy" })).description).toBe("D");
  });

  it("imports a zip bundle with its extra files, rejecting duplicates", async () => {
    const skills = service();
    async function bundle(skillMd: string): Promise<string> {
      const file = new ZipFile();
      file.addBuffer(Buffer.from(skillMd), "SKILL.md");
      file.addBuffer(Buffer.from("echo hi"), "scripts/run.sh");
      file.end();
      const chunks: Buffer[] = [];
      await new Promise<void>((done, fail) => {
        file.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
        file.outputStream.on("end", () => done());
        file.outputStream.on("error", fail);
      });
      return Buffer.concat(chunks).toString("base64");
    }
    const imported = await skills.import(actor, {
      data: await bundle(buildSkillMd({ name: "Deploy", description: "D", body: "Steps" })),
    });
    expect(imported).toMatchObject({ id: "user:deploy", name: "Deploy", source: "user" });
    const dir = path.join(userSkillsRoot(dataDir, actor), "deploy");
    expect(await readFile(path.join(dir, "scripts", "run.sh"), "utf8")).toBe("echo hi");

    await expect(
      skills.import(actor, {
        data: await bundle(buildSkillMd({ name: "deploy", description: "Again", body: "" })),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await skills.get(actor, { skillId: "user:deploy" })).description).toBe("D");
  });

  it("reports a zip whose own entries collide as a bad request, not a name clash", async () => {
    const skills = service();
    const file = new ZipFile();
    file.addBuffer(
      Buffer.from(buildSkillMd({ name: "Clash", description: "C", body: "Steps" })),
      "SKILL.md",
    );
    // "scripts" arrives as a file, then as the parent of another entry.
    file.addBuffer(Buffer.from("not a directory"), "scripts");
    file.addBuffer(Buffer.from("echo hi"), "scripts/run.sh");
    file.end();
    const chunks: Buffer[] = [];
    await new Promise<void>((done, fail) => {
      file.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
      file.outputStream.on("end", () => done());
      file.outputStream.on("error", fail);
    });
    const error = await skills
      .import(actor, { data: Buffer.concat(chunks).toString("base64") })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/conflicting entries/),
    });
    expect((error as Error).message).not.toContain(dataDir);
  });

  it("writes a batch of bot overrides with the availability in one transaction", async () => {
    const skills = service();
    const created = await skills.create(actor, { name: "Batch", description: "B" });
    // bot-2 was excluded while the skill was global; switching to "selected" seeds the
    // include list from the bots that could see it, so bot-2 stays hidden.
    await skills.setAccess(actor, {
      skillId: created.id,
      bots: [{ botId: "bot-2", enabled: false }],
    });
    const entry = await skills.setAccess(actor, {
      skillId: created.id,
      availability: "selected",
      bots: [{ botId: "bot-1", enabled: true }],
    });
    expect(entry).toMatchObject({ availability: "selected", visibleBotIds: ["bot-1"] });
    expect(prisma.$transaction).toHaveBeenLastCalledWith([expect.anything(), expect.anything()]);
    expect(prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ["bot-1"] } }) }),
    );

    await expect(
      skills.setAccess(actor, {
        skillId: created.id,
        bots: [
          { botId: "bot-1", enabled: true },
          { botId: "bot-9", enabled: true },
        ],
      }),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("disabled hides the skill from every bot, explicit includes notwithstanding", async () => {
    const skills = service();
    const created = await skills.create(actor, { name: "Off", description: "O" });
    const disabled = await skills.setAccess(actor, {
      skillId: created.id,
      availability: "disabled",
      bots: [{ botId: "bot-1", enabled: true }],
    });
    expect(disabled).toMatchObject({ availability: "disabled", visibleBotIds: [] });
    for (const botId of ["bot-1", "bot-2"]) {
      expect((await skills.list(actor, { botId })).map((s) => s.id)).not.toContain(created.id);
    }
    expect((await skills.list(actor)).map((s) => s.id)).toContain(created.id);

    // Re-enabling to "all" restores everyone; the stale include row is harmless.
    const restored = await skills.setAccess(actor, { skillId: created.id, availability: "all" });
    expect(restored.visibleBotIds).toEqual(["bot-1", "bot-2"]);
  });

  it("lists, reads and scopes marketplace skills but refuses to edit them", async () => {
    const dir = path.join(
      marketplacesRoot(dataDir, "ws-1"),
      "acme",
      "plugins",
      "writer",
      "skills",
      "blog",
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      buildSkillMd({ name: "Blog", description: "Write posts", body: "Outline first." }),
    );
    const skills = service();
    const mktId = "mkt:acme/writer/blog";

    expect((await skills.list(actor)).find((s) => s.id === mktId)).toMatchObject({
      name: "Blog",
      source: "plugin",
      readOnly: true,
      availability: "selected",
      visibleBotIds: [],
    });

    const access = await skills.setAccess(actor, {
      skillId: mktId,
      bots: [{ botId: "bot-1", enabled: true }],
    });
    expect(access.visibleBotIds).toEqual(["bot-1"]);
    expect((await skills.list(actor, { botId: "bot-1" })).map((s) => s.id)).toContain(mktId);
    expect((await skills.list(actor, { botId: "bot-2" })).map((s) => s.id)).not.toContain(mktId);

    const got = await skills.get(actor, { skillId: mktId });
    expect(got.content).toContain("Outline first.");
    expect(await skills.get(actor, { name: "blog" })).toMatchObject({ id: mktId });

    await expect(skills.update(actor, { skillId: mktId, body: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(skills.remove(actor, mktId)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const otherSpace = { spaceId: "ws-2", userId: "user-1" } as never;
    await expect(skills.get(otherSpace, { skillId: mktId })).rejects.toBeInstanceOf(IsolationError);
  });
});
