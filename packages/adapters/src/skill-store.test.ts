import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SKILL_BUNDLE_MAX_BYTES, SKILL_BUNDLE_MAX_ENTRIES } from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import { create as tarCreate } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  isExists,
  listUserSkills,
  removeUserSkill,
  removeUserSkillDirs,
  skillDirName,
  userSkillsRoot,
  writeUserSkill,
  writeUserSkillBundle,
} from "./skill-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmpRoot() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-skills-"));
  dirs.push(dir);
  return dir;
}

const md = (name: string, body = "Steps") =>
  buildSkillMd({ name, description: `About ${name}`, body });

describe("skill store", () => {
  it("scopes the root per space and user", () => {
    expect(userSkillsRoot("/data", { spaceId: "ws-1", userId: "user-1" })).toBe(
      path.join("/data", "skills", "user", "ws-1", "user-1"),
    );
  });

  it("derives a filesystem-safe directory name from the skill key", () => {
    expect(skillDirName("Daily Standup")).toBe("daily%20standup");
    expect(skillDirName("  Daily Standup ")).toBe(skillDirName("daily standup"));
    expect(skillDirName("a/b")).toBe("a%2Fb");
    expect(skillDirName(".")).toBe("%2E");
    expect(skillDirName("..")).toBe("%2E.");
  });

  it("returns an empty list when the root does not exist", async () => {
    const root = path.join(await tmpRoot(), "missing");
    expect(await listUserSkills(root)).toEqual([]);
  });

  it("writes, lists, replaces and removes skills", async () => {
    const root = await tmpRoot();
    await writeUserSkill(root, { name: "Daily Standup", content: md("Daily Standup") }, "create");
    await writeUserSkill(root, { name: "Alpha", content: md("Alpha") }, "create");

    const listed = await listUserSkills(root);
    expect(listed.map((s) => s.name)).toEqual(["Alpha", "Daily Standup"]);
    expect(listed[1]).toMatchObject({
      id: "user:daily standup",
      description: "About Daily Standup",
      source: "user",
      readOnly: false,
    });
    expect(listed[1]?.content).toBe(md("Daily Standup"));
    expect(listed[1]?.updatedAt).toBeInstanceOf(Date);

    await writeUserSkill(root, { name: "Alpha", content: md("Alpha", "New") }, "replace");
    expect((await listUserSkills(root)).find((s) => s.name === "Alpha")?.content).toBe(
      md("Alpha", "New"),
    );
    expect(await readFile(path.join(root, "alpha", "SKILL.md"), "utf8")).toBe(md("Alpha", "New"));

    await removeUserSkill(root, "alpha");
    expect((await listUserSkills(root)).map((s) => s.name)).toEqual(["Daily Standup"]);
  });

  it("refuses to create over an existing skill, case-insensitively", async () => {
    const root = await tmpRoot();
    await writeUserSkill(root, { name: "Alpha", content: md("Alpha") }, "create");
    const error = await writeUserSkill(
      root,
      { name: "ALPHA", content: md("ALPHA") },
      "create",
    ).catch((e: unknown) => e);
    expect(isExists(error)).toBe(true);
    expect(isExists(new Error("nope"))).toBe(false);
  });

  it("skips directories without a valid SKILL.md", async () => {
    const root = await tmpRoot();
    await writeUserSkill(root, { name: "Good", content: md("Good") }, "create");
    await mkdir(path.join(root, "empty"));
    await mkdir(path.join(root, "broken"));
    await writeFile(path.join(root, "broken", "SKILL.md"), "no frontmatter", "utf8");
    await writeFile(path.join(root, "stray.txt"), "x", "utf8");
    expect((await listUserSkills(root)).map((s) => s.name)).toEqual(["Good"]);
  });

  it("removes a user's skills across every space on account deletion", async () => {
    const dataDir = await tmpRoot();
    const a = userSkillsRoot(dataDir, { spaceId: "ws-1", userId: "user-1" });
    const b = userSkillsRoot(dataDir, { spaceId: "ws-2", userId: "user-1" });
    const other = userSkillsRoot(dataDir, { spaceId: "ws-1", userId: "user-2" });
    for (const root of [a, b, other]) {
      await writeUserSkill(root, { name: "Alpha", content: md("Alpha") }, "create");
    }
    await removeUserSkillDirs(dataDir, "user-1");
    expect(await listUserSkills(a)).toEqual([]);
    expect(await listUserSkills(b)).toEqual([]);
    expect((await listUserSkills(other)).map((s) => s.name)).toEqual(["Alpha"]);
    await expect(
      removeUserSkillDirs(path.join(dataDir, "nope"), "user-1"),
    ).resolves.toBeUndefined();
  });

  describe("bundles", () => {
    const resolve = async (skillMd: string) => {
      const name = /^name: (.*)$/m.exec(skillMd)?.[1] ?? "";
      return { name, content: `${skillMd}\n<!-- normalized -->\n` };
    };

    /** Writes `files` under a source dir and tars the given top-level entries (gzip). */
    async function bundle(
      files: Record<string, string>,
      top: string[],
      extra?: (src: string) => Promise<void>,
    ) {
      const src = await tmpRoot();
      for (const [file, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(src, file)), { recursive: true });
        await writeFile(path.join(src, file), content, "utf8");
      }
      await extra?.(src);
      const out = path.join(src, "out.skill");
      await tarCreate({ gzip: true, cwd: src, file: out }, top);
      return readFile(out);
    }

    it("extracts SKILL.md with its extra files next to it, dropping symlinks", async () => {
      const root = await tmpRoot();
      const archive = await bundle(
        { "SKILL.md": md("Deploy"), "scripts/run.sh": "echo hi", "references/notes.md": "n" },
        ["SKILL.md", "scripts", "references", "link"],
        (src) => symlink("/etc/passwd", path.join(src, "link")),
      );
      await writeUserSkillBundle(root, archive, resolve);
      const dir = path.join(root, "deploy");
      expect((await readdir(dir)).sort()).toEqual(["SKILL.md", "references", "scripts"]);
      expect(await readFile(path.join(dir, "SKILL.md"), "utf8")).toContain("normalized");
      expect(await readFile(path.join(dir, "scripts/run.sh"), "utf8")).toBe("echo hi");
      expect((await listUserSkills(root)).map((s) => s.name)).toEqual(["Deploy"]);
      expect(await readdir(root)).toEqual(["deploy"]);
    });

    it("accepts a single top-level directory wrapping the skill", async () => {
      const root = await tmpRoot();
      const archive = await bundle({ "deploy/SKILL.md": md("Deploy"), "deploy/x.txt": "x" }, [
        "deploy",
      ]);
      await writeUserSkillBundle(root, archive, resolve);
      expect(await readFile(path.join(root, "deploy", "x.txt"), "utf8")).toBe("x");
    });

    it("rejects bundles without SKILL.md at the root and cleans up", async () => {
      const root = await tmpRoot();
      const archive = await bundle({ "a/SKILL.md": md("A"), "b/SKILL.md": md("B") }, ["a", "b"]);
      await expect(writeUserSkillBundle(root, archive, resolve)).rejects.toThrow(/SKILL\.md/);
      expect(await readdir(root)).toEqual([]);
    });

    it("fails with EEXIST on a name clash without touching the existing skill", async () => {
      const root = await tmpRoot();
      await writeUserSkill(root, { name: "Deploy", content: md("Deploy", "Old") }, "create");
      const archive = await bundle({ "SKILL.md": md("Deploy"), "x.txt": "x" }, [
        "SKILL.md",
        "x.txt",
      ]);
      const error = await writeUserSkillBundle(root, archive, resolve).catch((e: unknown) => e);
      expect(isExists(error)).toBe(true);
      expect(await readdir(path.join(root, "deploy"))).toEqual(["SKILL.md"]);
      expect(await readFile(path.join(root, "deploy", "SKILL.md"), "utf8")).toBe(
        md("Deploy", "Old"),
      );
      expect(await readdir(root)).toEqual(["deploy"]);
    });

    it("propagates resolve failures and leaves nothing behind", async () => {
      const root = await tmpRoot();
      const archive = await bundle({ "SKILL.md": "junk" }, ["SKILL.md"]);
      await expect(
        writeUserSkillBundle(root, archive, async () => {
          throw new Error("bad frontmatter");
        }),
      ).rejects.toThrow("bad frontmatter");
      expect(await readdir(root)).toEqual([]);
    });

    it("rejects oversize bundles and too many entries", async () => {
      const root = await tmpRoot();
      const big = await bundle(
        { "SKILL.md": md("Big"), "blob.bin": "a".repeat(SKILL_BUNDLE_MAX_BYTES + 1) },
        ["SKILL.md", "blob.bin"],
      );
      await expect(writeUserSkillBundle(root, big, resolve)).rejects.toThrow(/too large/);
      const many = await bundle(
        Object.fromEntries([
          ["SKILL.md", md("Many")],
          ...Array.from({ length: SKILL_BUNDLE_MAX_ENTRIES }, (_, i) => [`f/${i}.txt`, "x"]),
        ]),
        ["SKILL.md", "f"],
      );
      await expect(writeUserSkillBundle(root, many, resolve)).rejects.toThrow(/too many/);
      expect(await readdir(root)).toEqual([]);
    });

    it("rejects data that is not a gzip tar", async () => {
      const root = await tmpRoot();
      await expect(
        writeUserSkillBundle(root, Buffer.from("plain text"), resolve),
      ).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    });
  });
});
