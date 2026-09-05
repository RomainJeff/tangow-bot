import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSkillMd } from "@rakazo/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  isExists,
  listUserSkills,
  removeUserSkill,
  removeUserSkillDirs,
  skillDirName,
  userSkillsRoot,
  writeUserSkill,
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
});
