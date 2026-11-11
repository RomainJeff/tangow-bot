import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SkillOwnerLock } from "@tangow/adapters";
import {
  createInMemorySkillLock,
  listUserSkills,
  skillCreateFromTool,
  userSkillsRoot,
} from "@tangow/adapters";
import { buildSkillMd } from "@tangow/core";
import type { PrismaClient } from "@tangow/db";
import { IsolationError } from "@tangow/db";
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

const owner = { spaceId: "ws-1", userId: "user-1" };
const actor = owner as never;

describe("agent skills service (filesystem)", () => {
  let dataDir: string;
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    bot: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    volumeSkill: { findMany: ReturnType<typeof vi.fn> };
    skillSetting: ReturnType<typeof table>;
    botSkill: ReturnType<typeof table>;
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-api-skills-"));
    prisma = {
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
      bot: {
        findMany: vi.fn(async ({ where }: { where?: { id?: { in: string[] } } } = {}) =>
          [
            { id: "bot-1", visibility: "private" },
            { id: "bot-2", visibility: "private" },
          ].filter((bot) => !where?.id || where.id.in.includes(bot.id)),
        ),
        findFirst: vi.fn(async () => ({ visibility: "private" })),
      },
      volumeSkill: { findMany: vi.fn(async () => []) },
      skillSetting: table([]),
      botSkill: table([]),
    };
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const service = (lock: SkillOwnerLock = createInMemorySkillLock()) =>
    createAgentSkillsService(prisma as unknown as PrismaClient, dataDir, lock);
  const userSkills = async (skills: ReturnType<typeof service>) =>
    (await skills.list(actor))
      .filter((skill) => skill.source === "user")
      .map((skill) => [skill.name, skill.description, skill.availability, skill.visibleBotIds]);

  it.each(["bot", "shared"])(
    "keeps a legacy skill editable beside a same-name %s observation",
    async (source) => {
      const skills = service();
      const legacy = await skills.create(actor, {
        name: "Weekly",
        description: "Original",
        body: "Editable",
      });
      prisma.volumeSkill.findMany.mockResolvedValue([
        {
          id: "observation",
          botId: "bot-1",
          source,
          name: "Weekly",
          description: "Volume",
          content: "Different content",
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ]);
      expect(await skills.list(actor)).toContainEqual(
        expect.objectContaining({ id: legacy.id, readOnly: false }),
      );
      await skills.update(actor, { skillId: legacy.id, body: "Updated" });
      expect(await skills.get(actor, { skillId: legacy.id })).toMatchObject({
        content: expect.stringContaining("Updated"),
      });
    },
  );

  it("waits for the owner's earlier skill write before any write of its own", async () => {
    const lock = createInMemorySkillLock();
    const skills = service(lock);
    const kept = await skills.create(actor, { name: "Kept", description: "K" });
    const gone = await skills.create(actor, { name: "Gone", description: "G" });
    let release = () => {};
    const held = lock.run(
      owner,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const imported = buildSkillMd({ name: "Imported", description: "I", body: "Body" });
    const writes = Promise.all([
      skills.create(actor, { name: "New", description: "N" }),
      skills.import(actor, { data: Buffer.from(imported).toString("base64") }),
      skills.update(actor, { skillId: kept.id, description: "Better" }),
      skills.setAccess(actor, { skillId: kept.id, availability: "disabled" }),
      skills.remove(actor, gone.id),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await userSkills(skills)).toEqual([
      ["Gone", "G", "all", ["bot-1", "bot-2"]],
      ["Kept", "K", "all", ["bot-1", "bot-2"]],
    ]);

    release();
    await held;
    await writes;
    expect(await userSkills(skills)).toEqual([
      ["Imported", "I", "all", ["bot-1", "bot-2"]],
      ["Kept", "Better", "disabled", []],
      ["New", "N", "all", ["bot-1", "bot-2"]],
    ]);
  });

  it("renames a skill onto a name a bot is creating only once that create is done", async () => {
    const lock = createInMemorySkillLock();
    const skills = service(lock);
    const old = await skills.create(actor, { name: "Old", description: "O" });
    await skills.setAccess(actor, {
      skillId: old.id,
      availability: "selected",
      bots: [{ botId: "bot-2", enabled: true }],
    });
    let release = () => {};
    const upsert = prisma.skillSetting.upsert.getMockImplementation();
    const rowsLanding = new Promise<void>((entered) => {
      prisma.skillSetting.upsert.mockImplementationOnce(async (args) => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return upsert?.(args);
      });
    });

    const created = skillCreateFromTool(
      { prisma: prisma as unknown as PrismaClient, dataDir, lock },
      { ...owner, botId: "bot-1" },
      [],
      { name: "Deploy", description: "D", body: "x" },
    );
    await rowsLanding;
    const renamed = skills.update(actor, { skillId: old.id, name: "Deploy" }).catch((e) => e);
    await Promise.race([renamed, new Promise((resolve) => setTimeout(resolve, 100))]);
    release();

    expect(await created).toMatchObject({ ok: true });
    expect(await renamed).toMatchObject({ code: "CONFLICT" });
    expect(await userSkills(skills)).toEqual([
      ["Deploy", "D", "selected", ["bot-1"]],
      ["Old", "O", "selected", ["bot-2"]],
    ]);
  });

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
});
