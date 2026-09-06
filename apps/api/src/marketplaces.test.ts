import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listMarketplaceSkills, marketplacesRoot } from "@rakazo/adapters";
import { IsolationError, type PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMarketplacesService } from "./marketplaces.js";

// ponytail: `tar` is not resolvable from apps/api; fake the two network calls and materialise
// an in-memory repo tree instead of a tarball. The store/diff/manifest code runs for real.
type Tree = Record<string, string>;
const repos = new Map<string, Tree>();
let headSha = "";
vi.mock("@rakazo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/adapters")>();
  return {
    ...actual,
    resolveGithubCommit: vi.fn(async () => headSha),
    downloadGithubTarball: vi.fn(async (input: { commit: string }, destDir: string) => {
      const tree = repos.get(input.commit);
      if (!tree) throw new Error("GitHub tarball download failed (404).");
      for (const [rel, content] of Object.entries(tree)) {
        await mkdir(path.dirname(path.join(destDir, rel)), { recursive: true });
        await writeFile(path.join(destDir, rel), content);
      }
    }),
  };
});

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: d\n---\n${body}`;
const manifest = JSON.stringify({
  name: "Acme",
  plugins: [
    { name: "alpha", source: "./plugins/alpha", description: "A" },
    { name: "remote", source: { source: "github", repo: "x/y" } },
  ],
});
const v1: Tree = {
  ".claude-plugin/marketplace.json": manifest,
  "plugins/alpha/skills/one/SKILL.md": skill("one", "v1"),
  "plugins/alpha/skills/one/scripts/run.sh": "echo 1",
};
const v2: Tree = {
  ".claude-plugin/marketplace.json": manifest,
  "plugins/alpha/skills/one/SKILL.md": skill("one", "v2"),
  "plugins/alpha/skills/two/SKILL.md": skill("two", "new"),
};

type Row = Record<string, unknown>;
const matches = (row: Row, where: Row) =>
  Object.entries(where).every(([key, value]) =>
    value && typeof value === "object" && "startsWith" in value
      ? String(row[key]).startsWith(String((value as { startsWith: string }).startsWith))
      : row[key] === value,
  );

function table(store: Row[]) {
  return {
    findMany: vi.fn(async ({ where = {} }: { where?: Row } = {}) =>
      store.filter((row) => matches(row, where)),
    ),
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const key = (where.spaceId_name as Row | undefined) ?? where;
      return store.find((row) => matches(row, key)) ?? null;
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = {
        id: `mkt-${store.length + 1}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      store.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const row = store.find((r) => matches(r, where));
      if (!row) throw new Error("not found");
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }),
    delete: vi.fn(async ({ where }: { where: Row }) => {
      const index = store.findIndex((r) => matches(r, where));
      return store.splice(index, 1)[0];
    }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      const kept = store.filter((row) => !matches(row, where));
      const count = store.length - kept.length;
      store.splice(0, store.length, ...kept);
      return { count };
    }),
    _store: store,
  };
}

const actor = { spaceId: "ws-1", userId: "user-1" } as never;
const other = { spaceId: "ws-2", userId: "user-2" } as never;
const URL_ = "https://github.com/acme/skills";

describe("marketplaces service", () => {
  let dataDir: string;
  let prisma: {
    spaceMarketplace: ReturnType<typeof table>;
    skillSetting: ReturnType<typeof table>;
    botSkill: ReturnType<typeof table>;
  };
  const service = () =>
    createMarketplacesService({
      prisma: prisma as unknown as PrismaClient,
      dataDir,
      fetch: globalThis.fetch,
    });
  const root = () => marketplacesRoot(dataDir, "ws-1");
  const exists = (p: string) =>
    stat(p).then(
      () => true,
      () => false,
    );

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-api-mkt-"));
    repos.clear();
    repos.set(SHA1, v1);
    repos.set(SHA2, v2);
    headSha = SHA1;
    prisma = { spaceMarketplace: table([]), skillSetting: table([]), botSkill: table([]) };
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("adds a marketplace: pins HEAD, copies the manifest, creates the row; refuses duplicates", async () => {
    const m = service();
    const added = await m.add(actor, { url: URL_ });
    expect(added).toMatchObject({
      name: "acme",
      url: URL_,
      ref: "HEAD",
      commit: SHA1,
      installedPlugins: [],
    });
    expect(added.createdAt).toMatch(/^\d{4}-/);
    expect(
      JSON.parse(await readFile(path.join(root(), "acme/.claude-plugin/marketplace.json"), "utf8"))
        .name,
    ).toBe("Acme");
    expect(await m.list(actor)).toHaveLength(1);
    expect(await m.list(other)).toEqual([]);

    await expect(m.add(actor, { url: URL_ })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(prisma.spaceMarketplace._store).toHaveLength(1);
  });

  it("rejects non-GitHub urls without creating a row", async () => {
    await expect(service().add(actor, { url: "https://gitlab.com/a/b" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/github/i),
    });
    expect(prisma.spaceMarketplace._store).toEqual([]);
  });

  it("lists plugins with supported/installed flags and installs supported ones only", async () => {
    const m = service();
    const { id } = await m.add(actor, { url: URL_ });
    expect(await m.plugins(actor, id)).toEqual([
      { name: "alpha", description: "A", supported: true, installed: false },
      { name: "remote", description: undefined, supported: false, installed: false },
    ]);

    await expect(m.installPlugin(actor, id, "remote")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const installed = await m.installPlugin(actor, id, "alpha");
    expect(installed.installedPlugins).toEqual(["alpha"]);
    expect((await m.plugins(actor, id))[0]?.installed).toBe(true);
    expect((await listMarketplaceSkills(root())).map((s) => s.id)).toEqual(["mkt:acme/alpha/one"]);

    await expect(m.plugins(other, id)).rejects.toBeInstanceOf(IsolationError);
  });

  it("removePlugin deletes the folder and purges mkt:<m>/<p>/ access rows", async () => {
    const m = service();
    const { id } = await m.add(actor, { url: URL_ });
    await m.installPlugin(actor, id, "alpha");
    prisma.skillSetting._store.push(
      { spaceId: "ws-1", skillKey: "mkt:acme/alpha/one", availability: "all" },
      { spaceId: "ws-1", skillKey: "mkt:acme/alphabet/x", availability: "all" },
      { spaceId: "ws-2", skillKey: "mkt:acme/alpha/one", availability: "all" },
    );
    prisma.botSkill._store.push({ spaceId: "ws-1", skillKey: "mkt:acme/alpha/one", enabled: true });

    const row = await m.removePlugin(actor, id, "alpha");
    expect(row.installedPlugins).toEqual([]);
    expect(await exists(path.join(root(), "acme/plugins/alpha"))).toBe(false);
    expect(prisma.skillSetting._store.map((r) => `${r.spaceId} ${r.skillKey}`)).toEqual([
      "ws-1 mkt:acme/alphabet/x",
      "ws-2 mkt:acme/alpha/one",
    ]);
    expect(prisma.botSkill._store).toEqual([]);
  });

  it("checkUpdate reports upToDate or a per-plugin diff, applyUpdate reinstalls at the commit", async () => {
    const m = service();
    const { id } = await m.add(actor, { url: URL_ });
    await m.installPlugin(actor, id, "alpha");
    expect(await m.checkUpdate(actor, id)).toEqual({ commit: SHA1, upToDate: true, changes: [] });

    headSha = SHA2;
    const check = await m.checkUpdate(actor, id);
    expect(check.commit).toBe(SHA2);
    expect(check.upToDate).toBe(false);
    expect(check.changes).toEqual([
      expect.objectContaining({
        path: "alpha/one/SKILL.md",
        status: "modified",
        before: skill("one", "v1"),
        after: skill("one", "v2"),
      }),
      expect.objectContaining({
        path: "alpha/one/scripts/run.sh",
        status: "removed",
        sizeBefore: 6,
      }),
      expect.objectContaining({
        path: "alpha/two/SKILL.md",
        status: "added",
        sizeAfter: skill("two", "new").length,
      }),
    ]);
    // checkUpdate is read-only.
    expect(await exists(path.join(root(), "acme/plugins/alpha/skills/two"))).toBe(false);

    const updated = await m.applyUpdate(actor, id, SHA2);
    expect(updated.commit).toBe(SHA2);
    expect(updated.installedPlugins).toEqual(["alpha"]);
    expect((await listMarketplaceSkills(root())).map((s) => s.id)).toEqual([
      "mkt:acme/alpha/one",
      "mkt:acme/alpha/two",
    ]);
    expect(await exists(path.join(root(), "acme/plugins/alpha/skills/one/scripts/run.sh"))).toBe(
      false,
    );
    expect(await m.checkUpdate(actor, id)).toMatchObject({ upToDate: true });
  });

  it("remove wipes the folder, the row and every mkt:<m>/ access row of the space", async () => {
    const m = service();
    const { id } = await m.add(actor, { url: URL_ });
    await m.installPlugin(actor, id, "alpha");
    prisma.skillSetting._store.push({ spaceId: "ws-1", skillKey: "mkt:acme/alpha/one" });
    prisma.botSkill._store.push({ spaceId: "ws-1", skillKey: "mkt:acme/alpha/one" });
    prisma.botSkill._store.push({ spaceId: "ws-1", skillKey: "user:keep" });

    await expect(m.remove(other, id)).rejects.toBeInstanceOf(IsolationError);
    expect(await m.remove(actor, id)).toEqual({ ok: true });
    expect(await exists(path.join(root(), "acme"))).toBe(false);
    expect(prisma.spaceMarketplace._store).toEqual([]);
    expect(prisma.skillSetting._store).toEqual([]);
    expect(prisma.botSkill._store.map((r) => r.skillKey)).toEqual(["user:keep"]);
  });
});
