import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSkillMd, formatSkillsCatalogInstruction, parseSkillMd } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";
import { marketplacesRoot } from "./marketplace-store.js";
import { listUserSkills, userSkillsRoot, writeUserSkill } from "./skill-store.js";
import {
  listAgentSkillRecords,
  type SkillToolDeps,
  skillCreateFromTool,
  skillDeleteFromTool,
  skillReadFromTool,
  skillUpdateFromTool,
} from "./skill-tools.js";

type Row = Record<string, unknown>;

const matches = (row: Row, where: Row) =>
  Object.entries(where).every(([key, value]) => row[key] === value);

// ponytail: only findMany/upsert/updateMany/deleteMany, what the tools and tests use.
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
  };
}

function makePrisma() {
  const prisma = {
    // Array form only (what the tools use); ops are already-running promises.
    $transaction: vi.fn(async (ops: unknown) =>
      typeof ops === "function"
        ? (ops as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.all(ops as Promise<unknown>[]),
    ),
    skillSetting: table([]),
    botSkill: table([]),
  };
  return prisma;
}

const owner = { spaceId: "ws-1", userId: "user-1" };

describe("skill tools", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let dataDir: string;
  let deps: SkillToolDeps;

  beforeEach(async () => {
    prisma = makePrisma();
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-skill-tools-"));
    deps = { prisma: prisma as never, dataDir };
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Seed a skill file the way the API/panel would (no access rows = visible to all). */
  const seed = (name: string, description: string, body = "", scope = owner) =>
    writeUserSkill(
      userSkillsRoot(dataDir, scope),
      { name, content: buildSkillMd({ name, description, body }) },
      "create",
    );

  it("creates, reads, updates, and deletes user skills", async () => {
    const created = await skillCreateFromTool(deps, owner, {
      name: "Daily standup",
      description: "Prepare standup notes",
      body: "1. Summarize yesterday.\n2. List blockers.",
    });
    expect(created).toMatchObject({ ok: true, id: "user:daily standup", name: "Daily standup" });
    expect(String(created.hint)).toContain("/Daily standup");

    const read = await skillReadFromTool(deps, owner, { name: "Daily standup" });
    expect(read).toMatchObject({
      name: "Daily standup",
      description: "Prepare standup notes",
      readOnly: false,
    });
    expect(String(read.content)).toContain("Summarize yesterday");

    const updated = await skillUpdateFromTool(deps, owner, {
      name: "Daily standup",
      description: "Updated when-to-use",
    });
    expect(updated).toMatchObject({ ok: true, description: "Updated when-to-use" });
    expect(await listUserSkills(userSkillsRoot(dataDir, owner))).toMatchObject([
      { name: "Daily standup", description: "Updated when-to-use" },
    ]);

    const deleted = await skillDeleteFromTool(deps, owner, { name: "Daily standup" });
    expect(deleted).toEqual({ ok: true, name: "Daily standup" });
    expect(await skillReadFromTool(deps, owner, { name: "Daily standup" })).toEqual({
      error: "Skill not found.",
    });
    expect(await listUserSkills(userSkillsRoot(dataDir, owner))).toEqual([]);
  });

  it("preserves extra frontmatter keys on update", async () => {
    const content = buildSkillMd({
      name: "Review PR",
      description: "Review a pull request",
      body: "1. Read the diff.",
      frontmatter: { compatibility: "cursor", "allowed-tools": ["shell"] },
    });
    await skillCreateFromTool(deps, owner, { content });
    await skillUpdateFromTool(deps, owner, {
      name: "Review PR",
      body: "1. Read the diff.\n2. Leave comments.",
    });
    const read = await skillReadFromTool(deps, owner, { name: "Review PR" });
    expect(String(read.content)).toContain("compatibility: cursor");
    expect(String(read.content)).toContain("Leave comments");
  });

  it("renames only via newName, not the name lookup key", async () => {
    const created = await skillCreateFromTool(deps, owner, {
      name: "Original",
      description: "Keep name unless newName",
      body: "body",
    });
    const skillId = String(created.id);
    const mistyped = await skillUpdateFromTool(deps, owner, {
      skillId,
      name: "Should not apply",
      description: "still original name",
    });
    expect(mistyped).toMatchObject({ ok: true, id: "user:original", name: "Original" });

    const renamed = await skillUpdateFromTool(deps, owner, {
      skillId,
      newName: "Renamed",
    });
    expect(renamed).toMatchObject({ ok: true, id: "user:renamed", name: "Renamed" });
    expect(
      (await listUserSkills(userSkillsRoot(dataDir, owner))).map((skill) => skill.name),
    ).toEqual(["Renamed"]);
  });

  it("scopes list to the owner workspace and injects catalog lines", async () => {
    await seed("Other workspace skill", "not visible", "x", { spaceId: "ws-2", userId: "user-2" });
    await skillCreateFromTool(deps, owner, {
      name: "Daily standup",
      description: "Prepare standup notes",
      body: "steps",
    });
    const records = await listAgentSkillRecords(deps, owner);
    expect(records.map((row) => row.name)).toContain("Daily standup");
    expect(records.map((row) => row.name)).not.toContain("Other workspace skill");
    const catalog = formatSkillsCatalogInstruction(records);
    expect(catalog).toContain("- Daily standup: Prepare standup notes");
    expect(catalog).toContain("skill_read");
  });

  it("reports a conflict when two creators race on the same name", async () => {
    await seed("Alpha", "First");
    const result = await skillCreateFromTool(deps, owner, { name: "alpha", description: "Dup" });
    expect(result).toEqual({ error: 'A skill named "Alpha" already exists.' });
  });

  it("tolerates access rows whose skill file is gone", async () => {
    await prisma.skillSetting.upsert({
      where: { spaceId_userId_skillKey: { ...owner, skillKey: "user:ghost" } },
      create: { ...owner, skillKey: "user:ghost", availability: "selected" },
      update: {},
    });
    const records = await listAgentSkillRecords(deps, { ...owner, botId: "bot-1" });
    expect(records.map((r) => r.name)).toEqual(["Interrogate"]);
  });

  it("ships builtin skills as valid, readable, read-only SKILL.md records", async () => {
    expect(BUILTIN_AGENT_SKILLS.map((skill) => skill.name)).toContain("Interrogate");
    for (const skill of BUILTIN_AGENT_SKILLS) {
      const parsed = parseSkillMd(skill.content);
      expect(parsed).toMatchObject({ name: skill.name, description: skill.description });
      // / picker truncates at 72; keep descriptions short so "review only" stays visible.
      expect(skill.description.length).toBeLessThanOrEqual(72);
    }

    const records = await listAgentSkillRecords(deps, owner);
    const interrogate = records.find((row) => row.name === "Interrogate");
    expect(interrogate).toMatchObject({
      id: "builtin:Interrogate",
      source: "builtin",
      readOnly: true,
    });
    expect(formatSkillsCatalogInstruction(records)).toContain("- Interrogate:");
    expect(formatSkillsCatalogInstruction(records)).toContain("Review only");

    const read = await skillReadFromTool(deps, owner, { name: "interrogate" });
    expect(read).toMatchObject({ name: "Interrogate", source: "builtin", readOnly: true });
    expect(String(read.content)).toContain("Do not modify files");

    expect(
      await skillCreateFromTool(deps, owner, {
        name: "interrogate",
        description: "shadow the builtin",
        body: "steps",
      }),
    ).toEqual({ error: 'A skill named "Interrogate" already exists.' });
    expect(
      await skillUpdateFromTool(deps, owner, {
        name: "Interrogate",
        description: "hijack",
      }),
    ).toEqual({ error: "Builtin and plugin skills are read-only." });
    expect(await skillDeleteFromTool(deps, owner, { name: "Interrogate" })).toEqual({
      error: "Builtin and plugin skills are read-only.",
    });
  });

  it.each(["interrogate", " Interrogate "])("preserves a saved skill named %j", async (name) => {
    // A skill file whose name collides with a builtin still belongs to its owner.
    await writeUserSkill(
      userSkillsRoot(dataDir, owner),
      {
        name,
        content: buildSkillMd({
          name: name.trim(),
          description: "my review recipe",
          body: "my steps",
        }),
      },
      "create",
    );

    const records = await listAgentSkillRecords(deps, owner);
    const saved = records.filter((skill) => skill.name.trim().toLowerCase() === "interrogate");
    expect(saved).toEqual([expect.objectContaining({ source: "user", readOnly: false })]);
    expect(await skillReadFromTool(deps, owner, { name: "Interrogate" })).toMatchObject({
      name: name.trim(),
      source: "user",
      readOnly: false,
    });
    expect(await skillReadFromTool(deps, owner, { skillId: saved[0]!.id })).toMatchObject({
      name: name.trim(),
      source: "user",
    });
    expect(
      await skillUpdateFromTool(deps, owner, {
        name: "Interrogate",
        description: "still mine",
      }),
    ).toMatchObject({ ok: true });
    expect(await skillDeleteFromTool(deps, owner, { name: "Interrogate" })).toEqual({
      ok: true,
      name: name.trim(),
    });
  });

  it("rejects oversized skill content", async () => {
    const body = "x".repeat(100_001);
    const created = await skillCreateFromTool(deps, owner, {
      name: "Huge",
      description: "too big",
      body,
    });
    expect(created).toMatchObject({ error: expect.stringContaining("at most") });
  });

  it("rejects overlong skill names on structured create and rename", async () => {
    const longName = "N".repeat(81);
    expect(
      await skillCreateFromTool(deps, owner, {
        name: longName,
        description: "ok description",
        body: "steps",
      }),
    ).toEqual({ error: "Skill name must be at most 80 characters." });

    await skillCreateFromTool(deps, owner, {
      name: "Short",
      description: "ok description",
      body: "steps",
    });
    expect(
      await skillUpdateFromTool(deps, owner, {
        name: "Short",
        newName: longName,
      }),
    ).toEqual({ error: "Skill name must be at most 80 characters." });
  });

  it("filters the catalog by bot visibility when botId is given", async () => {
    const scope = { spaceId: "w1", userId: "u1" };
    await seed("Everyone", "d", "", scope);
    await seed("Only bot A", "d", "", scope);
    await seed("Not for A", "d", "", scope);
    await prisma.skillSetting.upsert({
      where: { spaceId_userId_skillKey: { ...scope, skillKey: "user:only bot a" } },
      create: { ...scope, skillKey: "user:only bot a", availability: "selected" },
      update: {},
    });
    await prisma.botSkill.upsert({
      where: { botId_skillKey: { botId: "botA", skillKey: "user:only bot a" } },
      create: { ...scope, botId: "botA", skillKey: "user:only bot a", enabled: true },
      update: {},
    });
    await prisma.botSkill.upsert({
      where: { botId_skillKey: { botId: "botA", skillKey: "user:not for a" } },
      create: { ...scope, botId: "botA", skillKey: "user:not for a", enabled: false },
      update: {},
    });

    // General builtins remain visible; the memory-management skill starts unassigned.
    const forA = await listAgentSkillRecords(deps, { ...scope, botId: "botA" });
    expect(forA.map((s) => s.name)).toEqual(["Interrogate", "Everyone", "Only bot A"]);
    const forB = await listAgentSkillRecords(deps, { ...scope, botId: "botB" });
    expect(forB.map((s) => s.name)).toEqual(["Interrogate", "Everyone", "Not for A"]);
    const all = await listAgentSkillRecords(deps, scope);
    expect(all).toHaveLength(5);
    // skill_read follows the same visibility.
    expect(
      await skillReadFromTool(deps, { ...scope, botId: "botB" }, { name: "Only bot A" }),
    ).toEqual({ error: "Skill not found." });
  });

  it("scopes a bot-created skill to its creator", async () => {
    const creator = { spaceId: "w1", userId: "u1", botId: "botA" };
    const created = await skillCreateFromTool(deps, creator, {
      name: "Mine",
      description: "d",
      body: "x",
    });
    expect(created.ok).toBe(true);
    expect(String(created.hint)).toContain("/Mine");
    expect(String(created.hint)).toContain("share it with other agents");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(await prisma.skillSetting.findMany({ where: { skillKey: "user:mine" } })).toMatchObject([
      { spaceId: "w1", userId: "u1", availability: "selected" },
    ]);
    expect(await prisma.botSkill.findMany({ where: { skillKey: "user:mine" } })).toMatchObject([
      { spaceId: "w1", userId: "u1", botId: "botA", enabled: true },
    ]);
    const names = async (owner: typeof creator | { spaceId: string; userId: string }) =>
      (await listAgentSkillRecords(deps, owner))
        .filter((s) => s.source === "user")
        .map((s) => s.name);
    expect(await names(creator)).toEqual(["Mine"]);
    expect(await names({ ...creator, botId: "botB" })).toEqual([]);
    expect(await names({ spaceId: "w1", userId: "u1" })).toEqual(["Mine"]);
    expect(await skillReadFromTool(deps, { ...creator, botId: "botB" }, { name: "Mine" })).toEqual({
      error: "Skill not found.",
    });

    // Creation without a bot (API/panel) stays "all agents": no access rows.
    const shared = await skillCreateFromTool(
      deps,
      { spaceId: "w1", userId: "u1" },
      { name: "Shared", description: "d", body: "x" },
    );
    expect(shared.ok).toBe(true);
    expect(await prisma.skillSetting.findMany({ where: { skillKey: "user:shared" } })).toEqual([]);
    expect(await prisma.botSkill.findMany({ where: { skillKey: "user:shared" } })).toEqual([]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(await names({ ...creator, botId: "botB" })).toEqual(["Shared"]);
  });

  it("renames access rows with the skill and removes them on delete", async () => {
    const scope = { spaceId: owner.spaceId, userId: owner.userId };
    await skillCreateFromTool(deps, owner, { name: "Old", description: "d", body: "x" });
    await prisma.skillSetting.upsert({
      where: { spaceId_userId_skillKey: { ...scope, skillKey: "user:old" } },
      create: { ...scope, skillKey: "user:old", availability: "selected" },
      update: {},
    });
    await prisma.botSkill.upsert({
      where: { botId_skillKey: { botId: "botA", skillKey: "user:old" } },
      create: { ...scope, botId: "botA", skillKey: "user:old", enabled: true },
      update: {},
    });

    // Case-only rename keeps the key: access rows untouched, same directory replaced.
    expect(await skillUpdateFromTool(deps, owner, { name: "Old", newName: "OLD" })).toMatchObject({
      ok: true,
      id: "user:old",
      name: "OLD",
    });
    expect(prisma.skillSetting.updateMany).not.toHaveBeenCalled();
    expect(prisma.botSkill.updateMany).not.toHaveBeenCalled();
    expect(await prisma.skillSetting.findMany({ where: { skillKey: "user:old" } })).toHaveLength(1);

    const renamed = await skillUpdateFromTool(deps, owner, { name: "OLD", newName: "New" });
    expect(renamed).toMatchObject({ ok: true, id: "user:new", name: "New" });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(await prisma.skillSetting.findMany({ where: { skillKey: "user:old" } })).toEqual([]);
    expect(await prisma.botSkill.findMany({ where: { skillKey: "user:old" } })).toEqual([]);
    expect(await prisma.skillSetting.findMany({ where: { skillKey: "user:new" } })).toMatchObject([
      { availability: "selected" },
    ]);
    expect(await prisma.botSkill.findMany({ where: { skillKey: "user:new" } })).toMatchObject([
      { botId: "botA", enabled: true },
    ]);
    // Old directory is gone, only the new one remains.
    expect((await listUserSkills(userSkillsRoot(dataDir, owner))).map((s) => s.name)).toEqual([
      "New",
    ]);
    // The exclusion semantics survive the rename: only botA sees it.
    expect(
      (await listAgentSkillRecords(deps, { ...owner, botId: "botA" })).map((s) => s.name),
    ).toEqual(["Interrogate", "New"]);
    expect(
      (await listAgentSkillRecords(deps, { ...owner, botId: "botB" })).map((s) => s.name),
    ).toEqual(["Interrogate"]);

    expect(await skillDeleteFromTool(deps, owner, { name: "New" })).toEqual({
      ok: true,
      name: "New",
    });
    expect(await prisma.skillSetting.findMany()).toEqual([]);
    expect(await prisma.botSkill.findMany()).toEqual([]);
    expect(await listUserSkills(userSkillsRoot(dataDir, owner))).toEqual([]);
  });

  it("exposes marketplace skills as read-only plugin skills hidden until a bot enables them", async () => {
    const dir = path.join(
      marketplacesRoot(dataDir, owner.spaceId),
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
    await seed("Mine", "d");
    const mktId = "mkt:acme/writer/blog";
    const ids = async (scope: typeof owner & { botId?: string }) =>
      (await listAgentSkillRecords(deps, scope))
        .map((r) => r.id)
        .filter((id) => !id.startsWith("builtin:"));

    // No SkillSetting: user skill defaults to "all", marketplace skill to "selected".
    expect(await ids({ ...owner, botId: "botA" })).toEqual(["user:mine"]);
    expect(await ids(owner)).toEqual(["user:mine", mktId]);

    await prisma.botSkill.upsert({
      where: { botId_skillKey: { botId: "botA", skillKey: mktId } },
      create: { ...owner, botId: "botA", skillKey: mktId, enabled: true },
      update: {},
    });
    const forA = await listAgentSkillRecords(deps, { ...owner, botId: "botA" });
    expect(forA.find((r) => r.id === mktId)).toMatchObject({
      name: "Blog",
      source: "plugin",
      readOnly: true,
    });
    expect(await ids({ ...owner, botId: "botB" })).toEqual(["user:mine"]);

    const read = await skillReadFromTool(deps, { ...owner, botId: "botA" }, { skillId: mktId });
    expect(read).toMatchObject({ name: "Blog", source: "plugin", readOnly: true });
    expect(String(read.content)).toContain("Outline first.");

    const readOnly = { error: expect.stringContaining("read-only") };
    expect(await skillUpdateFromTool(deps, owner, { skillId: mktId, body: "x" })).toEqual(readOnly);
    expect(await skillDeleteFromTool(deps, owner, { skillId: mktId })).toEqual(readOnly);
    expect(await ids(owner)).toEqual(["user:mine", mktId]);
  });
});
