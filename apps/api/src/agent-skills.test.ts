import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listUserSkills, marketplacesRoot, userSkillsRoot } from "@rakazo/adapters";
import { buildSkillMd } from "@rakazo/core";
import { IsolationError, type PrismaClient } from "@rakazo/db";
import { create as tarCreate } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  const service = () => createAgentSkillsService(prisma as unknown as PrismaClient, dataDir);

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
    await expect(
      skills.import(actor, {
        data: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]).toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/\.skill/) });
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
    expect((await skills.list(actor)).map((s) => s.id)).toEqual(["user:deploy"]);

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
