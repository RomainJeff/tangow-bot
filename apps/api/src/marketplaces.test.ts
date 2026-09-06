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
/** Keyed by commit sha, or by `owner/repo@sha` for a plugin with its own repository. */
const repos = new Map<string, Tree>();
/** Per-repo HEAD, falling back to `headSha` (the marketplace index). */
const heads = new Map<string, string>();
let headSha = "";
const repoKey = (input: { owner: string; repo: string }) => `${input.owner}/${input.repo}`;
vi.mock("@rakazo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/adapters")>();
  return {
    ...actual,
    resolveGithubCommit: vi.fn(
      async (input: { owner: string; repo: string }) => heads.get(repoKey(input)) ?? headSha,
    ),
    downloadGithubTarball: vi.fn(
      async (input: { owner: string; repo: string; commit: string }, destDir: string) => {
        const tree = repos.get(`${repoKey(input)}@${input.commit}`) ?? repos.get(input.commit);
        if (!tree) throw new Error("GitHub tarball download failed (404).");
        for (const [rel, content] of Object.entries(tree)) {
          await mkdir(path.dirname(path.join(destDir, rel)), { recursive: true });
          await writeFile(path.join(destDir, rel), content);
        }
      },
    ),
  };
});

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const EXT1 = "a".repeat(40);
const EXT2 = "b".repeat(40);
const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: d\n---\n${body}`;
const manifest = JSON.stringify({
  name: "Acme",
  plugins: [
    { name: "alpha", source: "./plugins/alpha", description: "A" },
    { name: "remote", source: { source: "github", repo: "x/y" } },
    { name: "gitlab", source: { source: "url", url: "https://gitlab.com/x/y.git" } },
  ],
});
/** The external repo is the plugin: no manifest, skills at its root. */
const ext = (body: string): Tree => ({ "skills/solo/SKILL.md": skill("solo", body) });
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

const SKILLS_URL = "https://github.com/vercel-labs/agent-skills";
const SK1 = "3".repeat(40);
const SK2 = "4".repeat(40);
const SK3 = "5".repeat(40);
/** skills.sh layout: no manifest. `.claude/skills/tdd` is shadowed by `skills/tdd`. */
const skillsV1: Tree = {
  "skills/tdd/SKILL.md": skill("tdd", "red green"),
  "skills/review/SKILL.md": skill("review", "look twice"),
  ".claude/skills/tdd/SKILL.md": skill("tdd", "shadowed"),
  "README.md": "docs",
};
/** `review` vanished upstream. */
const skillsV2: Tree = { "skills/tdd/SKILL.md": skill("tdd", "red green refactor") };

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
        kind: "marketplace",
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
    heads.clear();
    repos.set(SHA1, v1);
    repos.set(SHA2, v2);
    repos.set(SK1, skillsV1);
    repos.set(SK2, skillsV2);
    repos.set(`x/y@${EXT1}`, ext("ext-v1"));
    repos.set(`x/y@${EXT2}`, ext("ext-v2"));
    heads.set("x/y", EXT1);
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
      kind: "marketplace",
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
      { name: "remote", description: undefined, supported: true, installed: false },
      { name: "gitlab", description: undefined, supported: false, installed: false },
    ]);

    await expect(m.installPlugin(actor, id, "gitlab")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const installed = await m.installPlugin(actor, id, "alpha");
    expect(installed.installedPlugins).toEqual(["alpha"]);
    expect((await m.plugins(actor, id))[0]?.installed).toBe(true);
    expect((await listMarketplaceSkills(root())).map((s) => s.id)).toEqual(["mkt:acme/alpha/one"]);

    await expect(m.plugins(other, id)).rejects.toBeInstanceOf(IsolationError);
  });

  it("installs a plugin from its own repository and pins that repository's commit", async () => {
    const m = service();
    const { id } = await m.add(actor, { url: URL_ });
    const row = await m.installPlugin(actor, id, "remote");
    // The DTO stays a list of names; the pin lives in the JSON column.
    expect(row.installedPlugins).toEqual(["remote"]);
    expect(prisma.spaceMarketplace._store[0]?.installedPlugins).toEqual([
      { name: "remote", commit: EXT1 },
    ]);
    expect((await listMarketplaceSkills(root())).map((s) => s.id)).toEqual([
      "mkt:acme/remote/solo",
    ]);

    // The index is unchanged, but the plugin's own repo moved: that is still an update.
    heads.set("x/y", EXT2);
    const check = await m.checkUpdate(actor, id);
    expect(check).toMatchObject({ commit: SHA1, upToDate: false });
    expect(check.changes).toEqual([
      expect.objectContaining({
        path: "remote/solo/SKILL.md",
        status: "modified",
        before: skill("solo", "ext-v1"),
        after: skill("solo", "ext-v2"),
      }),
    ]);

    await m.applyUpdate(actor, id, SHA1);
    expect(prisma.spaceMarketplace._store[0]?.installedPlugins).toEqual([
      { name: "remote", commit: EXT2 },
    ]);
    expect(
      await readFile(path.join(root(), "acme/plugins/remote/skills/solo/SKILL.md"), "utf8"),
    ).toBe(skill("solo", "ext-v2"));
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

  describe("skills repositories (phase 4)", () => {
    it("adds a repository without a manifest as a `skills` marketplace named <owner>-<repo>", async () => {
      headSha = SK1;
      const m = service();
      const added = await m.add(actor, { url: SKILLS_URL });
      expect(added).toMatchObject({
        name: "vercel-labs-agent-skills",
        kind: "skills",
        commit: SK1,
      });
      expect(prisma.spaceMarketplace._store[0]?.kind).toBe("skills");
      const written = JSON.parse(
        await readFile(
          path.join(root(), "vercel-labs-agent-skills/.claude-plugin/marketplace.json"),
          "utf8",
        ),
      );
      expect(written.plugins).toEqual([
        { name: "review", source: "./skills/review", description: "d" },
        { name: "tdd", source: "./skills/tdd", description: "d" },
      ]);
      expect(await m.plugins(actor, added.id)).toEqual([
        { name: "review", description: "d", supported: true, installed: false },
        { name: "tdd", description: "d", supported: true, installed: false },
      ]);
    });

    it("installPlugins installs several skills from one checkout and keeps earlier installs", async () => {
      headSha = SK1;
      const m = service();
      const { id } = await m.add(actor, { url: SKILLS_URL });
      await m.installPlugin(actor, id, "tdd");
      const row = await m.installPlugins(actor, id, ["review", "tdd", "tdd"]);
      expect(row.installedPlugins).toEqual(["review", "tdd"]);
      expect((await listMarketplaceSkills(root())).map((s) => s.id)).toEqual([
        "mkt:vercel-labs-agent-skills/review/review",
        "mkt:vercel-labs-agent-skills/tdd/tdd",
      ]);
      expect(
        await readFile(
          path.join(root(), "vercel-labs-agent-skills/plugins/tdd/skills/tdd/SKILL.md"),
          "utf8",
        ),
      ).toBe(skill("tdd", "red green"));
      // The synthesized manifest must be byte-stable, or every check would report a diff.
      expect(await m.checkUpdate(actor, id)).toEqual({ commit: SK1, upToDate: true, changes: [] });
    });

    it("installPlugins persists the plugins that succeeded before a failing one", async () => {
      headSha = SK1;
      const m = service();
      const { id } = await m.add(actor, { url: SKILLS_URL });
      await expect(m.installPlugins(actor, id, ["tdd", "nope"])).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(prisma.spaceMarketplace._store[0]?.installedPlugins).toEqual([{ name: "tdd" }]);
    });

    it("applyUpdate drops a plugin that vanished upstream instead of failing", async () => {
      headSha = SK1;
      const m = service();
      const { id } = await m.add(actor, { url: SKILLS_URL });
      await m.installPlugins(actor, id, ["tdd", "review"]);
      prisma.skillSetting._store.push({
        spaceId: "ws-1",
        skillKey: "mkt:vercel-labs-agent-skills/review/review",
      });
      headSha = SK2;
      const check = await m.checkUpdate(actor, id);
      expect(check.upToDate).toBe(false);
      expect(check.changes.map((c) => [c.path, c.status])).toEqual([
        ["review/review/SKILL.md", "removed"],
        ["tdd/tdd/SKILL.md", "modified"],
      ]);
      const row = await m.applyUpdate(actor, id, SK2);
      expect(row.installedPlugins).toEqual(["tdd"]);
      expect(row.kind).toBe("skills");
      expect(await exists(path.join(root(), "vercel-labs-agent-skills/plugins/review"))).toBe(
        false,
      );
      expect(prisma.skillSetting._store).toEqual([]);
      expect((await m.plugins(actor, id)).map((p) => p.name)).toEqual(["tdd"]);
    });

    it("applyUpdate leaves the on-disk manifest alone when an install fails", async () => {
      headSha = SK1;
      const m = service();
      const { id } = await m.add(actor, { url: SKILLS_URL });
      await m.installPlugin(actor, id, "tdd");
      const manifestPath = path.join(
        root(),
        "vercel-labs-agent-skills/.claude-plugin/marketplace.json",
      );
      const before = await readFile(manifestPath, "utf8");
      // A manifest whose plugin has no files at all: installOne throws mid-update.
      repos.set(SK3, {
        ".claude-plugin/marketplace.json": JSON.stringify({
          name: "vercel-labs-agent-skills",
          plugins: [{ name: "tdd", source: "./plugins/tdd" }],
        }),
      });
      await expect(m.applyUpdate(actor, id, SK3)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await readFile(manifestPath, "utf8")).toBe(before);
      expect(prisma.spaceMarketplace._store[0]?.commit).toBe(SK1);
    });

    it("removePlugin cannot delete anything outside the marketplace's plugins dir", async () => {
      headSha = SK1;
      const m = service();
      const { id } = await m.add(actor, { url: SKILLS_URL });
      const victim = path.join(root(), "victim");
      await mkdir(victim, { recursive: true });
      await writeFile(path.join(victim, "keep.txt"), "keep");
      await m.removePlugin(actor, id, "../../victim").catch(() => undefined);
      expect(await exists(path.join(victim, "keep.txt"))).toBe(true);
    });

    it("refuses a repository with neither manifest nor SKILL.md", async () => {
      headSha = SK1;
      repos.set(SK1, { "README.md": "nothing" });
      await expect(service().add(actor, { url: SKILLS_URL })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Repository has neither .claude-plugin/marketplace.json nor any SKILL.md.",
      });
    });
  });
});
