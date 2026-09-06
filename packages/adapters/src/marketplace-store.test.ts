import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSkillMd } from "@rakazo/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffPluginTrees,
  installPluginFromCheckout,
  listMarketplaceSkills,
  marketplacesRoot,
  readMarketplaceManifest,
  removeInstalledPlugin,
} from "./marketplace-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tmp() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-mkt-"));
  dirs.push(dir);
  return dir;
}

/** A fake extracted repo: manifest + one plugin with a skill, a script, and ignored dirs. */
async function checkout(skillBody = "Steps") {
  const dir = await tmp();
  await mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(dir, ".claude-plugin/marketplace.json"),
    JSON.stringify({
      name: "Acme",
      plugins: [
        { name: "Writer", source: "./plugins/writer", description: "Writing helpers" },
        { name: "remote", source: { source: "github", repo: "x/y" } },
        { name: "escape", source: "./../outside" },
      ],
    }),
  );
  const skill = path.join(dir, "plugins/writer/skills/Blog-Post");
  await mkdir(path.join(skill, "scripts"), { recursive: true });
  await writeFile(
    path.join(skill, "SKILL.md"),
    buildSkillMd({ name: "Blog post", description: "Write posts", body: skillBody }),
  );
  await writeFile(path.join(skill, "scripts/run.sh"), "echo hi");
  await mkdir(path.join(dir, "plugins/writer/commands"), { recursive: true });
  await writeFile(path.join(dir, "plugins/writer/commands/x.md"), "ignored");
  return dir;
}

async function install(root: string, src: string, plugin = "writer") {
  await installPluginFromCheckout(root, "acme", src, await readMarketplaceManifest(src), plugin);
}

describe("marketplace store", () => {
  it("scopes the root per space", () => {
    expect(marketplacesRoot("/data", "space1")).toBe(
      path.join("/data", "skills", "marketplaces", "space1"),
    );
  });

  it("parses the manifest, lowercases names and flags unsupported sources", async () => {
    const manifest = await readMarketplaceManifest(await checkout());
    expect(manifest.name).toBe("acme");
    expect(manifest.plugins).toEqual([
      {
        name: "writer",
        source: "./plugins/writer",
        description: "Writing helpers",
        supported: true,
      },
      { name: "remote", source: null, description: undefined, supported: false },
      { name: "escape", source: null, description: undefined, supported: false },
    ]);
  });

  it("rejects a missing or malformed manifest", async () => {
    await expect(readMarketplaceManifest(await tmp())).rejects.toThrow(/marketplace\.json/);
    const dir = await tmp();
    await mkdir(path.join(dir, ".claude-plugin"));
    await writeFile(path.join(dir, ".claude-plugin/marketplace.json"), '{"plugins":[]}');
    await expect(readMarketplaceManifest(dir)).rejects.toThrow(/invalid/i);
    await writeFile(
      path.join(dir, ".claude-plugin/marketplace.json"),
      '{"name":"bad name!","plugins":[]}',
    );
    await expect(readMarketplaceManifest(dir)).rejects.toThrow(/name/);
  });

  it("installs only skills/ and lists them with mkt: keys", async () => {
    const root = marketplacesRoot(await tmp(), "space1");
    await install(root, await checkout());
    const skills = await listMarketplaceSkills(root);
    expect(skills.map((s) => [s.id, s.name, s.source, s.readOnly])).toEqual([
      ["mkt:acme/writer/blog-post", "Blog post", "plugin", true],
    ]);
    expect(skills[0]).toMatchObject({
      marketplace: "acme",
      plugin: "writer",
      slug: "blog-post",
      description: "Write posts",
    });
    expect(skills[0]?.updatedAt).toBeInstanceOf(Date);
    await expect(
      readFile(path.join(root, "acme/plugins/writer/skills/blog-post/scripts/run.sh"), "utf8"),
    ).resolves.toBe("echo hi");
    await expect(readFile(path.join(root, "acme/plugins/writer/commands/x.md"))).rejects.toThrow();
  });

  it("installs a plugin whose source is the repository root", async () => {
    const dir = await tmp();
    await mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(dir, ".claude-plugin/marketplace.json"),
      JSON.stringify({ name: "solo", plugins: [{ name: "solo-skills", source: "./" }] }),
    );
    const skill = path.join(dir, "skills/tdd");
    await mkdir(skill, { recursive: true });
    await writeFile(
      path.join(skill, "SKILL.md"),
      buildSkillMd({ name: "TDD", description: "Red green refactor", body: "Steps" }),
    );
    const root = marketplacesRoot(await tmp(), "space1");
    await installPluginFromCheckout(
      root,
      "solo",
      dir,
      await readMarketplaceManifest(dir),
      "solo-skills",
    );
    expect((await listMarketplaceSkills(root)).map((s) => s.id)).toEqual([
      "mkt:solo/solo-skills/tdd",
    ]);
  });

  it("flattens skills declared in plugin.json under category directories", async () => {
    const dir = await tmp();
    await mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(dir, ".claude-plugin/marketplace.json"),
      JSON.stringify({ name: "nested", plugins: [{ name: "pack", source: "./" }] }),
    );
    await writeFile(
      path.join(dir, ".claude-plugin/plugin.json"),
      JSON.stringify({ skills: ["./skills/engineering/tdd", "./skills/productivity/Grilling"] }),
    );
    for (const rel of ["engineering/tdd", "productivity/Grilling", "deprecated/old"]) {
      await mkdir(path.join(dir, "skills", rel), { recursive: true });
      await writeFile(
        path.join(dir, "skills", rel, "SKILL.md"),
        buildSkillMd({ name: rel, description: `desc ${rel}`, body: "Steps" }),
      );
    }
    const root = marketplacesRoot(await tmp(), "space1");
    await installPluginFromCheckout(
      root,
      "nested",
      dir,
      await readMarketplaceManifest(dir),
      "pack",
    );
    // Declared skills only, flattened and lowercased: deprecated/ is not in plugin.json.
    expect((await listMarketplaceSkills(root)).map((s) => s.id)).toEqual([
      "mkt:nested/pack/grilling",
      "mkt:nested/pack/tdd",
    ]);
  });

  it("descends one level into category directories when plugin.json declares nothing", async () => {
    const dir = await tmp();
    await mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(dir, ".claude-plugin/marketplace.json"),
      JSON.stringify({ name: "scan", plugins: [{ name: "pack", source: "./" }] }),
    );
    for (const rel of ["flat", "engineering/tdd"]) {
      await mkdir(path.join(dir, "skills", rel), { recursive: true });
      await writeFile(
        path.join(dir, "skills", rel, "SKILL.md"),
        buildSkillMd({ name: rel, description: `desc ${rel}`, body: "Steps" }),
      );
    }
    const root = marketplacesRoot(await tmp(), "space1");
    await installPluginFromCheckout(root, "scan", dir, await readMarketplaceManifest(dir), "pack");
    expect((await listMarketplaceSkills(root)).map((s) => s.id)).toEqual([
      "mkt:scan/pack/flat",
      "mkt:scan/pack/tdd",
    ]);
  });

  it("refuses a plugin.json skill path that escapes the plugin", async () => {
    const dir = await tmp();
    await mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(dir, ".claude-plugin/marketplace.json"),
      JSON.stringify({ name: "evil", plugins: [{ name: "pack", source: "./" }] }),
    );
    await writeFile(
      path.join(dir, ".claude-plugin/plugin.json"),
      JSON.stringify({ skills: ["../outside/secrets"] }),
    );
    const root = marketplacesRoot(await tmp(), "space1");
    await expect(
      installPluginFromCheckout(root, "evil", dir, await readMarketplaceManifest(dir), "pack"),
    ).rejects.toThrow(/escapes the plugin/);
  });

  it("refuses two skills that would install under the same slug", async () => {
    const dir = await tmp();
    await mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(dir, ".claude-plugin/marketplace.json"),
      JSON.stringify({ name: "clash", plugins: [{ name: "pack", source: "./" }] }),
    );
    for (const rel of ["engineering/tdd", "productivity/TDD"]) {
      await mkdir(path.join(dir, "skills", rel), { recursive: true });
      await writeFile(
        path.join(dir, "skills", rel, "SKILL.md"),
        buildSkillMd({ name: rel, description: `desc ${rel}`, body: "Steps" }),
      );
    }
    const root = marketplacesRoot(await tmp(), "space1");
    await expect(
      installPluginFromCheckout(root, "clash", dir, await readMarketplaceManifest(dir), "pack"),
    ).rejects.toThrow(/both install as "tdd"/);
  });

  it("returns an empty list when the root does not exist", async () => {
    expect(await listMarketplaceSkills(path.join(await tmp(), "missing"))).toEqual([]);
  });

  it("refuses unknown and unsupported plugins", async () => {
    const root = marketplacesRoot(await tmp(), "space1");
    const src = await checkout();
    await expect(install(root, src, "nope")).rejects.toThrow(/not in the marketplace/);
    await expect(install(root, src, "remote")).rejects.toThrow(/unsupported source/);
    await expect(install(root, src, "escape")).rejects.toThrow(/unsupported source/);
  });

  it("rejects the whole plugin when a SKILL.md exceeds 100k", async () => {
    const root = marketplacesRoot(await tmp(), "space1");
    await expect(install(root, await checkout("x".repeat(100_001)))).rejects.toThrow(/100/);
    expect(await listMarketplaceSkills(root)).toEqual([]);
  });

  it("removes an installed plugin", async () => {
    const root = marketplacesRoot(await tmp(), "space1");
    await install(root, await checkout());
    await removeInstalledPlugin(root, "acme", "writer");
    expect(await listMarketplaceSkills(root)).toEqual([]);
  });

  it("diffs installed vs candidate plugin trees", async () => {
    const before = await checkout("v1");
    const after = await checkout("v2");
    const skill = path.join(after, "plugins/writer/skills/Blog-Post");
    await rm(path.join(skill, "scripts/run.sh"));
    await mkdir(path.join(skill, "references"));
    await writeFile(path.join(skill, "references/notes.md"), "n");
    await writeFile(path.join(skill, "references/blob.bin"), Buffer.from([1, 0, 2]));

    // The service compares two installed roots so slugs are normalised on both sides.
    const beforeRoot = marketplacesRoot(await tmp(), "s");
    const afterRoot = marketplacesRoot(await tmp(), "s");
    await install(beforeRoot, before);
    await install(afterRoot, after);
    const changes = await diffPluginTrees(
      path.join(beforeRoot, "acme/plugins/writer/skills"),
      path.join(afterRoot, "acme/plugins/writer/skills"),
    );
    expect(changes.map((c) => [c.path, c.status])).toEqual([
      ["blog-post/SKILL.md", "modified"],
      ["blog-post/references/blob.bin", "added"],
      ["blog-post/references/notes.md", "added"],
      ["blog-post/scripts/run.sh", "removed"],
    ]);
    expect(changes[0]?.before).toContain("v1");
    expect(changes[0]?.after).toContain("v2");
    expect(changes[0]?.sizeBefore).toBeGreaterThan(0);
    expect(changes[1]).toMatchObject({ sizeBefore: undefined, sizeAfter: 3, after: undefined });
    expect(changes[3]).toMatchObject({ sizeBefore: 7, sizeAfter: undefined, before: "echo hi" });
  });

  it("reports no changes for identical trees", async () => {
    const root = marketplacesRoot(await tmp(), "s");
    await install(root, await checkout());
    const skills = path.join(root, "acme/plugins/writer/skills");
    expect(await diffPluginTrees(skills, skills)).toEqual([]);
  });
});
