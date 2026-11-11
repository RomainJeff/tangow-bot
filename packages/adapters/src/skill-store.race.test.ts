import type * as FsPromises from "node:fs/promises";
import { mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSkillMd } from "@tangow/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isExists,
  listUserSkills,
  renameUserSkill,
  replaceUserSkillFiles,
  writeUserSkill,
  writeUserSkillFiles,
} from "./skill-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
const renameMock = vi.mocked(rename);

const dirs: string[] = [];
afterEach(async () => {
  renameMock.mockImplementation(actual.rename);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmpRoot() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-skills-race-"));
  dirs.push(dir);
  return dir;
}

const md = (name: string, body: string) =>
  buildSkillMd({ name, description: `About ${name}`, body });
const file = (filePath: string, value: string) => ({
  path: filePath,
  bytes: new TextEncoder().encode(value),
  executable: false,
});
const resolve = async (skillMd: string) => ({
  name: /^name: (.*)$/m.exec(skillMd)?.[1] ?? "",
  content: skillMd,
});

/** Every folder under `dir` whose SKILL.md reads `content`. */
async function foldersHolding(dir: string, content: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    const skillMd = await readFile(path.join(child, "SKILL.md"), "utf8").catch(() => "");
    if (skillMd === content) found.push(child);
    found.push(...(await foldersHolding(child, content)));
  }
  return found;
}

describe("skill store under concurrent writers", () => {
  it("never removes the skill another write moved into the folder it claimed", async () => {
    const root = await tmpRoot();
    const dest = path.join(root, "deploy");
    await writeUserSkill(root, { name: "Notes", content: md("Notes", "Mine") }, "create");
    renameMock.mockImplementation(async (from, to) => {
      if (to === dest) {
        await actual.writeFile(path.join(dest, "SKILL.md"), md("Deploy", "Theirs"));
      }
      return actual.rename(from, to);
    });

    const error = await renameUserSkill(root, "Notes", {
      name: "Deploy",
      content: md("Deploy", "Mine"),
    }).catch((e: unknown) => e);

    expect(isExists(error)).toBe(true);
    expect((error as Error).message).toBe("A skill with that name already exists.");
    expect(await readFile(path.join(dest, "SKILL.md"), "utf8")).toBe(md("Deploy", "Theirs"));
    expect(await readFile(path.join(root, "notes", "SKILL.md"), "utf8")).toBe(md("Notes", "Mine"));
  });

  it("lets one of two writes of the same name win and refuses the other", async () => {
    const root = await tmpRoot();
    const dest = path.join(root, "deploy");
    const arrived: (() => void)[] = [];
    renameMock.mockImplementation(async (from, to) => {
      if (to === dest) {
        await new Promise<void>((go) => {
          arrived.push(go);
          if (arrived.length === 2) for (const release of arrived) release();
        });
      }
      return actual.rename(from, to);
    });

    const results = await Promise.allSettled([
      writeUserSkillFiles(root, [file("SKILL.md", md("Deploy", "A")), file("a.txt", "a")], resolve),
      writeUserSkillFiles(root, [file("SKILL.md", md("Deploy", "B")), file("b.txt", "b")], resolve),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const loser = results.find((r) => r.status === "rejected");
    expect(isExists(loser?.reason)).toBe(true);
    const winner = results[0]?.status === "fulfilled" ? "A" : "B";
    expect(await readFile(path.join(dest, "SKILL.md"), "utf8")).toBe(md("Deploy", winner));
    expect((await readdir(dest)).sort()).toEqual(["SKILL.md", `${winner.toLowerCase()}.txt`]);
    expect(await readdir(root)).toEqual(["deploy"]);
  });

  it("keeps the old version in the wrapper when it cannot be put back after a failed swap", async () => {
    const root = await tmpRoot();
    const dest = path.join(root, "deploy");
    await writeUserSkillFiles(
      root,
      [file("SKILL.md", md("Deploy", "Old")), file("scripts/old.sh", "old")],
      resolve,
    );
    renameMock.mockImplementation(async (from, to) => {
      if (to === dest && path.basename(String(from)) === "bundle") {
        await writeUserSkill(root, { name: "Deploy", content: md("Deploy", "Theirs") }, "create");
      }
      return actual.rename(from, to);
    });

    const error = await replaceUserSkillFiles(
      root,
      "Deploy",
      [file("SKILL.md", md("Deploy", "New"))],
      resolve,
    ).catch((e: unknown) => e);

    expect(isExists(error)).toBe(true);
    expect((error as Error).message).toBe("A skill with that name already exists.");
    expect((await listUserSkills(root)).map((skill) => skill.content)).toEqual([
      md("Deploy", "Theirs"),
    ]);
    const kept = await foldersHolding(root, md("Deploy", "Old"));
    expect(kept).toHaveLength(1);
    expect(await readFile(path.join(kept[0] ?? "", "scripts/old.sh"), "utf8")).toBe("old");
  });

  it("puts the old version back when the new folder cannot move in", async () => {
    const root = await tmpRoot();
    const dest = path.join(root, "deploy");
    await writeUserSkill(root, { name: "Deploy", content: md("Deploy", "Old") }, "create");
    renameMock.mockImplementation(async (from, to) => {
      if (to === dest && path.basename(String(from)) === "bundle") {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return actual.rename(from, to);
    });

    const error = await replaceUserSkillFiles(
      root,
      "Deploy",
      [file("SKILL.md", md("Deploy", "New"))],
      resolve,
    ).catch((e: unknown) => e);

    expect((error as Error).message).toBe("denied");
    expect(await readdir(root)).toEqual(["deploy"]);
    expect(await readFile(path.join(dest, "SKILL.md"), "utf8")).toBe(md("Deploy", "Old"));
  });
});
