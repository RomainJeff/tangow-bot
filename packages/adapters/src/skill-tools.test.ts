import { buildSkillMd, formatSkillsCatalogInstruction } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listAgentSkillRecords,
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

function makePrisma(rows: Array<Record<string, unknown>> = []) {
  const store = [...rows];
  const prisma = {
    // Array form only (what the tools use); ops are already-running promises.
    $transaction: vi.fn(async (ops: unknown) =>
      typeof ops === "function"
        ? (ops as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.all(ops as Promise<unknown>[]),
    ),
    skillSetting: table([]),
    botSkill: table([]),
    agentSkill: {
      findMany: vi.fn(async ({ where }: { where?: Record<string, string> } = {}) =>
        store
          .filter((row) => {
            if (!where) return true;
            if (where.spaceId && row.spaceId !== where.spaceId) return false;
            if (where.userId && row.userId !== where.userId) return false;
            return true;
          })
          .map((row) => ({ ...row })),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `skill-${store.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          source: "user",
          ...data,
        };
        store.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const index = store.findIndex((row) => row.id === where.id);
          if (index < 0) throw new Error("missing");
          store[index] = { ...store[index], ...data, updatedAt: new Date() };
          return store[index];
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, string>;
          data: Record<string, unknown>;
        }) => {
          const index = store.findIndex(
            (row) =>
              row.id === where.id &&
              row.spaceId === where.spaceId &&
              row.userId === where.userId &&
              row.source === where.source,
          );
          if (index < 0) return { count: 0 };
          store[index] = { ...store[index], ...data, updatedAt: new Date() };
          return { count: 1 };
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = store.findIndex((row) => row.id === where.id);
        if (index < 0) throw new Error("missing");
        const [removed] = store.splice(index, 1);
        return removed;
      }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, string> }) => {
        const index = store.findIndex(
          (row) =>
            row.id === where.id &&
            row.spaceId === where.spaceId &&
            row.userId === where.userId &&
            row.source === where.source,
        );
        if (index < 0) return { count: 0 };
        store.splice(index, 1);
        return { count: 1 };
      }),
    },
    _store: store,
  };
  return prisma;
}

const owner = { spaceId: "ws-1", userId: "user-1" };

describe("skill tools", () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it("creates, reads, updates, and deletes user skills", async () => {
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Daily standup",
      description: "Prepare standup notes",
      body: "1. Summarize yesterday.\n2. List blockers.",
    });
    expect(created).toMatchObject({ ok: true, name: "Daily standup" });
    expect(String(created.hint)).toContain("/Daily standup");

    const read = await skillReadFromTool(prisma as never, owner, { name: "Daily standup" });
    expect(read).toMatchObject({
      name: "Daily standup",
      description: "Prepare standup notes",
      readOnly: false,
    });
    expect(String(read.content)).toContain("Summarize yesterday");

    const updated = await skillUpdateFromTool(prisma as never, owner, {
      name: "Daily standup",
      description: "Updated when-to-use",
    });
    expect(updated).toMatchObject({ ok: true, description: "Updated when-to-use" });

    const deleted = await skillDeleteFromTool(prisma as never, owner, { name: "Daily standup" });
    expect(deleted).toEqual({ ok: true, name: "Daily standup" });
    expect(await skillReadFromTool(prisma as never, owner, { name: "Daily standup" })).toEqual({
      error: "Skill not found.",
    });
  });

  it("preserves extra frontmatter keys on update", async () => {
    const content = buildSkillMd({
      name: "Review PR",
      description: "Review a pull request",
      body: "1. Read the diff.",
      frontmatter: { compatibility: "cursor", "allowed-tools": ["shell"] },
    });
    await skillCreateFromTool(prisma as never, owner, { content });
    await skillUpdateFromTool(prisma as never, owner, {
      name: "Review PR",
      body: "1. Read the diff.\n2. Leave comments.",
    });
    const read = await skillReadFromTool(prisma as never, owner, { name: "Review PR" });
    expect(String(read.content)).toContain("compatibility: cursor");
    expect(String(read.content)).toContain("Leave comments");
  });

  it("renames only via newName, not the name lookup key", async () => {
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Original",
      description: "Keep name unless newName",
      body: "body",
    });
    const skillId = String(created.id);
    const mistyped = await skillUpdateFromTool(prisma as never, owner, {
      skillId,
      name: "Should not apply",
      description: "still original name",
    });
    expect(mistyped).toMatchObject({ ok: true, name: "Original" });

    const renamed = await skillUpdateFromTool(prisma as never, owner, {
      skillId,
      newName: "Renamed",
    });
    expect(renamed).toMatchObject({ ok: true, name: "Renamed" });
  });

  it("scopes list to the owner workspace and injects catalog lines", async () => {
    prisma = makePrisma([
      {
        id: "other-1",
        spaceId: "ws-2",
        userId: "user-2",
        name: "Other workspace skill",
        description: "not visible",
        content: buildSkillMd({
          name: "Other workspace skill",
          description: "not visible",
          body: "x",
        }),
        source: "user",
      },
    ]);
    await skillCreateFromTool(prisma as never, owner, {
      name: "Daily standup",
      description: "Prepare standup notes",
      body: "steps",
    });
    const records = await listAgentSkillRecords(prisma as never, owner);
    expect(records.map((row) => row.name)).toContain("Daily standup");
    expect(records.map((row) => row.name)).not.toContain("Other workspace skill");
    const catalog = formatSkillsCatalogInstruction(records);
    expect(catalog).toContain("- Daily standup: Prepare standup notes");
    expect(catalog).toContain("skill_read");
  });

  it("rejects update/delete for plugin and builtin skills", async () => {
    prisma = makePrisma([
      {
        id: "plugin-1",
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Plugin recipe",
        description: "From a plugin",
        content: buildSkillMd({
          name: "Plugin recipe",
          description: "From a plugin",
          body: "do not edit",
        }),
        source: "plugin",
      },
    ]);
    expect(
      await skillUpdateFromTool(prisma as never, owner, {
        name: "Plugin recipe",
        description: "hijack",
      }),
    ).toEqual({ error: "Builtin and plugin skills are read-only." });
    expect(await skillDeleteFromTool(prisma as never, owner, { name: "Plugin recipe" })).toEqual({
      error: "Builtin and plugin skills are read-only.",
    });
  });

  it("rejects oversized skill content", async () => {
    const body = "x".repeat(100_001);
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Huge",
      description: "too big",
      body,
    });
    expect(created).toMatchObject({ error: expect.stringContaining("at most") });
  });

  it("rejects overlong skill names on structured create and rename", async () => {
    const longName = "N".repeat(81);
    expect(
      await skillCreateFromTool(prisma as never, owner, {
        name: longName,
        description: "ok description",
        body: "steps",
      }),
    ).toEqual({ error: "Skill name must be at most 80 characters." });

    await skillCreateFromTool(prisma as never, owner, {
      name: "Short",
      description: "ok description",
      body: "steps",
    });
    expect(
      await skillUpdateFromTool(prisma as never, owner, {
        name: "Short",
        newName: longName,
      }),
    ).toEqual({ error: "Skill name must be at most 80 characters." });
  });

  it("filters the catalog by bot visibility when botId is given", async () => {
    const row = (id: string, name: string) => ({
      id,
      spaceId: "w1",
      userId: "u1",
      name,
      description: "d",
      content: buildSkillMd({ name, description: "d", body: "" }),
      source: "user",
    });
    prisma = makePrisma([row("s1", "Everyone"), row("s2", "Only bot A"), row("s3", "Not for A")]);
    await prisma.skillSetting.upsert({
      where: {
        spaceId_userId_skillKey: { spaceId: "w1", userId: "u1", skillKey: "user:only bot a" },
      },
      create: {
        spaceId: "w1",
        userId: "u1",
        skillKey: "user:only bot a",
        availability: "selected",
      },
      update: {},
    });
    await prisma.botSkill.upsert({
      where: { botId_skillKey: { botId: "botA", skillKey: "user:only bot a" } },
      create: {
        spaceId: "w1",
        userId: "u1",
        botId: "botA",
        skillKey: "user:only bot a",
        enabled: true,
      },
      update: {},
    });
    await prisma.botSkill.upsert({
      where: { botId_skillKey: { botId: "botA", skillKey: "user:not for a" } },
      create: {
        spaceId: "w1",
        userId: "u1",
        botId: "botA",
        skillKey: "user:not for a",
        enabled: false,
      },
      update: {},
    });

    const forA = await listAgentSkillRecords(prisma as never, {
      spaceId: "w1",
      userId: "u1",
      botId: "botA",
    });
    expect(forA.map((s) => s.name)).toEqual(["Everyone", "Only bot A"]);
    const forB = await listAgentSkillRecords(prisma as never, {
      spaceId: "w1",
      userId: "u1",
      botId: "botB",
    });
    expect(forB.map((s) => s.name)).toEqual(["Everyone", "Not for A"]);
    const all = await listAgentSkillRecords(prisma as never, { spaceId: "w1", userId: "u1" });
    expect(all).toHaveLength(3);
    // skill_read follows the same visibility.
    expect(
      await skillReadFromTool(
        prisma as never,
        { spaceId: "w1", userId: "u1", botId: "botB" },
        { name: "Only bot A" },
      ),
    ).toEqual({ error: "Skill not found." });
  });

  it("renames access rows with the skill and removes them on delete", async () => {
    const scope = { spaceId: owner.spaceId, userId: owner.userId };
    await skillCreateFromTool(prisma as never, owner, { name: "Old", description: "d", body: "x" });
    // Fixture rows set directly: creator scoping (skill_create + botId) is a separate ticket.
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

    // Case-only rename keeps the key: access rows untouched.
    expect(
      await skillUpdateFromTool(prisma as never, owner, { name: "Old", newName: "OLD" }),
    ).toMatchObject({ ok: true, name: "OLD" });
    expect(prisma.skillSetting.updateMany).not.toHaveBeenCalled();
    expect(prisma.botSkill.updateMany).not.toHaveBeenCalled();
    expect(await prisma.skillSetting.findMany({ where: { skillKey: "user:old" } })).toHaveLength(1);

    const renamed = await skillUpdateFromTool(prisma as never, owner, {
      name: "OLD",
      newName: "New",
    });
    expect(renamed).toMatchObject({ ok: true, name: "New" });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(await prisma.skillSetting.findMany({ where: { skillKey: "user:old" } })).toEqual([]);
    expect(await prisma.botSkill.findMany({ where: { skillKey: "user:old" } })).toEqual([]);
    expect(await prisma.skillSetting.findMany({ where: { skillKey: "user:new" } })).toMatchObject([
      { availability: "selected" },
    ]);
    expect(await prisma.botSkill.findMany({ where: { skillKey: "user:new" } })).toMatchObject([
      { botId: "botA", enabled: true },
    ]);
    // The exclusion semantics survive the rename: only botA sees it.
    expect(
      (await listAgentSkillRecords(prisma as never, { ...owner, botId: "botA" })).map(
        (s) => s.name,
      ),
    ).toEqual(["New"]);
    expect(
      (await listAgentSkillRecords(prisma as never, { ...owner, botId: "botB" })).map(
        (s) => s.name,
      ),
    ).toEqual([]);

    expect(await skillDeleteFromTool(prisma as never, owner, { name: "New" })).toEqual({
      ok: true,
      name: "New",
    });
    expect(await prisma.skillSetting.findMany()).toEqual([]);
    expect(await prisma.botSkill.findMany()).toEqual([]);
  });
});
