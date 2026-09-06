import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSkillMd } from "@rakazo/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffPluginTrees,
  discoverSkills,
  installPluginFromCheckout,
  installPluginTree,
  listMarketplaceSkills,
  loadOrSynthesizeManifest,
  marketplacesRoot,
  pluginDirIn,
  pluginSource,
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
        { name: "remote-url", source: { source: "url", url: "https://github.com/x/y.git" } },
        { name: "gitlab", source: { source: "url", url: "https://gitlab.com/x/y.git" } },
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

/** A skills.sh-style repository: no manifest, SKILL.md files under conventional roots. */
async function skillsRepo(files: Record<string, string>) {
  const dir = await tmp();
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  return dir;
}
const md = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: About ${name}\n${extra}---\nBody`;

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
        source: { kind: "local", path: "./plugins/writer" },
        description: "Writing helpers",
        supported: true,
      },
      {
        name: "remote",
        source: { kind: "github", url: "https://github.com/x/y", ref: undefined },
        description: undefined,
        supported: true,
      },
      {
        name: "remote-url",
        source: { kind: "github", url: "https://github.com/x/y.git", ref: undefined },
        description: undefined,
        supported: true,
      },
      // Only github.com is allowlisted, so a GitLab remote stays unsupported.
      { name: "gitlab", source: null, description: undefined, supported: false },
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

  it("installs a plugin whose directory is itself a skill under the plugin name", async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, "SKILL.md"),
      buildSkillMd({ name: "TDD", description: "Red green refactor", body: "Steps" }),
    );
    const root = marketplacesRoot(await tmp(), "space1");
    await installPluginTree(root, "solo", "tdd", dir);
    expect((await listMarketplaceSkills(root)).map((s) => s.id)).toEqual(["mkt:solo/tdd/tdd"]);
  });

  it("rejects a plugin tree over the byte budget without leaving files behind", async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, "SKILL.md"),
      buildSkillMd({ name: "TDD", description: "Red green refactor", body: "Steps" }),
    );
    await writeFile(path.join(dir, "fixtures.bin"), "x".repeat(2_000));
    const root = marketplacesRoot(await tmp(), "space1");
    await expect(installPluginTree(root, "solo", "tdd", dir, { maxBytes: 1_000 })).rejects.toThrow(
      /exceeds 1000 bytes; plugin rejected/,
    );
    expect(
      await stat(path.join(root, "solo", "plugins", "tdd")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("prefers plugin.json skills over a root SKILL.md", async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, "SKILL.md"),
      buildSkillMd({ name: "Root", description: "The whole plugin", body: "Steps" }),
    );
    await mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(dir, ".claude-plugin/plugin.json"),
      JSON.stringify({ skills: ["./bundled/alpha"] }),
    );
    await mkdir(path.join(dir, "bundled/alpha"), { recursive: true });
    await writeFile(
      path.join(dir, "bundled/alpha/SKILL.md"),
      buildSkillMd({ name: "Alpha", description: "A declared skill", body: "Steps" }),
    );
    const root = marketplacesRoot(await tmp(), "space1");
    await installPluginTree(root, "solo", "pack", dir);
    expect((await listMarketplaceSkills(root)).map((s) => s.id)).toEqual(["mkt:solo/pack/alpha"]);
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

  it("installs a github-sourced plugin from its own checkout", async () => {
    // The external repo is the plugin: no marketplace.json, skills sit at its root.
    const external = await tmp();
    await mkdir(path.join(external, "skills/brainstorming"), { recursive: true });
    await writeFile(
      path.join(external, "skills/brainstorming/SKILL.md"),
      buildSkillMd({ name: "Brainstorming", description: "Ideas first", body: "Steps" }),
    );
    const manifest = await readMarketplaceManifest(await checkout());
    const source = pluginSource(manifest, "remote");
    expect(source).toEqual({ kind: "github", url: "https://github.com/x/y", ref: undefined });
    const root = marketplacesRoot(await tmp(), "space1");
    await installPluginTree(root, "acme", "remote", pluginDirIn(external, source));
    expect((await listMarketplaceSkills(root)).map((s) => s.id)).toEqual([
      "mkt:acme/remote/brainstorming",
    ]);
  });

  it("returns an empty list when the root does not exist", async () => {
    expect(await listMarketplaceSkills(path.join(await tmp(), "missing"))).toEqual([]);
  });

  it("refuses unknown and unsupported plugins", async () => {
    const root = marketplacesRoot(await tmp(), "space1");
    const src = await checkout();
    await expect(install(root, src, "nope")).rejects.toThrow(/not in the marketplace/);
    await expect(install(root, src, "gitlab")).rejects.toThrow(/unsupported source/);
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

describe("discoverSkills", () => {
  it("finds skills under skills/, .claude/skills/, .agents/skills/ and one category level", async () => {
    const dir = await skillsRepo({
      "skills/tdd/SKILL.md": md("TDD"),
      "skills/writing/Blog-Post/SKILL.md": md("Blog"),
      ".claude/skills/review/SKILL.md": md("Review"),
      ".agents/skills/deploy/SKILL.md": md("Deploy"),
      "README.md": "not a skill",
    });
    expect(await discoverSkills(dir, "repo")).toEqual([
      { slug: "blog-post", relPath: "./skills/writing/Blog-Post", description: "About Blog" },
      { slug: "deploy", relPath: "./.agents/skills/deploy", description: "About Deploy" },
      { slug: "review", relPath: "./.claude/skills/review", description: "About Review" },
      { slug: "tdd", relPath: "./skills/tdd", description: "About TDD" },
    ]);
  });

  it("a root SKILL.md makes the repository a single skill named after it", async () => {
    const dir = await skillsRepo({ "SKILL.md": md("Solo"), "skills/x/SKILL.md": md("X") });
    expect(await discoverSkills(dir, "my-repo")).toEqual([
      { slug: "my-repo", relPath: "./", description: "About Solo" },
    ]);
  });

  it("skips a directory named SKILL.md instead of failing", async () => {
    const dir = await skillsRepo({
      "skills/tdd/SKILL.md": md("TDD"),
      "skills/deploy/SKILL.md": md("Deploy"),
    });
    await mkdir(path.join(dir, "skills/weird/SKILL.md"), { recursive: true });
    expect((await discoverSkills(dir, "repo")).map((s) => s.slug)).toEqual(["deploy", "tdd"]);
  });

  it("skips internal and invalid skills; the first root wins on a slug clash", async () => {
    const dir = await skillsRepo({
      "skills/tdd/SKILL.md": md("TDD"),
      ".claude/skills/tdd/SKILL.md": md("Shadowed"),
      "skills/hidden/SKILL.md": md("Hidden", "metadata:\n  internal: true\n"),
      "skills/broken/SKILL.md": "no frontmatter",
      // Never reaches discoverSkills: listDirs drops directory names that fail SAFE_NAME.
      "skills/Bad Name/SKILL.md": md("Bad"),
    });
    expect((await discoverSkills(dir, "repo")).map((s) => [s.slug, s.description])).toEqual([
      ["tdd", "About TDD"],
    ]);
  });
});

describe("loadOrSynthesizeManifest", () => {
  const repo = { owner: "Vercel-Labs", repo: "Agent-Skills" };

  it("returns the real manifest when present, even if loose SKILL.md files exist", async () => {
    const dir = await checkout();
    await mkdir(path.join(dir, "skills/loose"), { recursive: true });
    await writeFile(path.join(dir, "skills/loose/SKILL.md"), md("Loose"));
    const loaded = await loadOrSynthesizeManifest(dir, repo);
    expect(loaded.kind).toBe("marketplace");
    expect(loaded.manifest.name).toBe("acme");
    expect(loaded.raw).toBe(
      await readFile(path.join(dir, ".claude-plugin/marketplace.json"), "utf8"),
    );
  });

  it("synthesizes one plugin per discovered skill, named <owner>-<repo>", async () => {
    const dir = await skillsRepo({
      "skills/tdd/SKILL.md": md("TDD"),
      "skills/b/SKILL.md": md("B"),
    });
    const loaded = await loadOrSynthesizeManifest(dir, repo);
    expect(loaded.kind).toBe("skills");
    expect(loaded.manifest.name).toBe("vercel-labs-agent-skills");
    expect(loaded.manifest.plugins).toEqual([
      {
        name: "b",
        source: { kind: "local", path: "./skills/b" },
        description: "About B",
        supported: true,
      },
      {
        name: "tdd",
        source: { kind: "local", path: "./skills/tdd" },
        description: "About TDD",
        supported: true,
      },
    ]);
    // The raw JSON round-trips through the real reader: what add() writes is what plugins() reads.
    await mkdir(path.join(dir, ".claude-plugin"));
    await writeFile(path.join(dir, ".claude-plugin/marketplace.json"), loaded.raw);
    expect(await readMarketplaceManifest(dir)).toEqual(loaded.manifest);
  });

  it("rejects a repository with neither manifest nor skills", async () => {
    const dir = await skillsRepo({ "README.md": "nothing" });
    await expect(loadOrSynthesizeManifest(dir, repo)).rejects.toThrow(
      "Repository has neither .claude-plugin/marketplace.json nor any SKILL.md.",
    );
  });
});
