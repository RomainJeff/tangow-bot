import { execFileSync } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillTreeFile } from "./skill-store.js";
import {
  captureTree,
  fingerprint,
  materialize,
  normalizeTree,
  readdirOrEmpty,
  readHistoryJson,
  withSkillMd,
  writeJsonAtomic,
} from "./skill-tree.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-skill-tree-"));
  dirs.push(dir);
  return dir;
}

const isName = (value: unknown): value is { name: string } =>
  typeof value === "object" && value !== null && "name" in value;

describe("history files", () => {
  it("reads a JSON file back, and reports a torn or malformed one instead of throwing", async () => {
    const dir = await scratch();
    const file = path.join(dir, "skill.json");
    await writeJsonAtomic(file, { name: "Deploy" });
    expect(await readHistoryJson(file, isName)).toEqual({ state: "ok", value: { name: "Deploy" } });
    await writeFile(file, '{"name":');
    expect(await readHistoryJson(file, isName)).toEqual({ state: "unreadable" });
    await writeFile(file, '{"other":1}');
    expect(await readHistoryJson(file, isName)).toEqual({ state: "unreadable" });
  });

  it("treats a stray file where a folder belongs as nothing there", async () => {
    const dir = await scratch();
    const stray = path.join(dir, "0".repeat(32));
    await writeFile(stray, "stray");
    expect(await readHistoryJson(path.join(stray, "skill.json"), isName)).toEqual({
      state: "missing",
    });
    expect(await readdirOrEmpty(path.join(stray, "versions"))).toEqual([]);
    expect(await readdirOrEmpty(path.join(dir, "absent"))).toEqual([]);
  });
});

async function put(root: string, relative: string, content = relative, mode = 0o644) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, { mode });
  return file;
}

const file = (relative: string, content = relative, executable = false): SkillTreeFile => ({
  path: relative,
  bytes: new TextEncoder().encode(content),
  executable,
});

const readable = (tree: SkillTreeFile[]) =>
  tree.map((entry) => [entry.path, new TextDecoder().decode(entry.bytes), entry.executable]);

/** Every entry under `root`: a folder or link by its kind, a file by its mode and text. */
async function listing(root: string) {
  const names = (await readdir(root, { recursive: true })).sort();
  return Promise.all(
    names.map(async (name) => {
      const info = await lstat(path.join(root, name));
      if (info.isDirectory()) return [name, "dir"];
      if (info.isSymbolicLink()) return [name, "link"];
      return [name, (info.mode & 0o777).toString(8), await readFile(path.join(root, name), "utf8")];
    }),
  );
}

const refusal = (relative: string, what: string) =>
  `${relative} ${what}, and a skill keeps only plain files. Remove it and try again.`;

const hasMkfifo = (() => {
  try {
    execFileSync("sh", ["-c", "command -v mkfifo"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const MB = 1024 * 1024;

describe("captureTree", () => {
  it("reads plain files sorted, keeping the executable bit only under scripts/", async () => {
    const dir = await scratch();
    await put(dir, "SKILL.md", "# Deploy");
    await put(dir, "scripts/run.sh", "echo hi", 0o755);
    await put(dir, "notes/tool.sh", "echo no", 0o755);
    expect(readable(await captureTree(dir))).toEqual([
      ["SKILL.md", "# Deploy", false],
      ["notes/tool.sh", "echo no", false],
      ["scripts/run.sh", "echo hi", true],
    ]);
  });

  it("refuses a link", async () => {
    const dir = await scratch();
    await put(dir, "SKILL.md");
    await symlink(path.join(dir, "SKILL.md"), path.join(dir, "link.md"));
    await expect(captureTree(dir)).rejects.toThrow(refusal("link.md", "is a link"));
  });

  it.skipIf(!hasMkfifo)("refuses a FIFO", async () => {
    const dir = await scratch();
    execFileSync("mkfifo", [path.join(dir, "pipe")]);
    await expect(captureTree(dir)).rejects.toThrow(refusal("pipe", "is not a regular file"));
  });

  it("refuses a hard link unless the caller admits them", async () => {
    const dir = await scratch();
    await put(dir, "a.md", "same");
    await link(path.join(dir, "a.md"), path.join(dir, "b.md"));
    await expect(captureTree(dir)).rejects.toThrow(refusal("a.md", "is a hard link"));
    expect(readable(await captureTree(dir, { hardLinks: true }))).toEqual([
      ["a.md", "same", false],
      ["b.md", "same", false],
    ]);
  });

  it.skipIf(process.platform === "win32")("refuses a name with a backslash", async () => {
    const dir = await scratch();
    await put(dir, "a\\b.md");
    await expect(captureTree(dir)).rejects.toThrow(
      refusal("a\\b.md", "has a backslash in its name"),
    );
  });

  it("refuses a file over 10 MB, and files that only add up past it", async () => {
    const dir = await scratch();
    await truncate(await put(dir, "big.bin", ""), 10 * MB + 1);
    await expect(captureTree(dir)).rejects.toThrow(refusal("big.bin", "is larger than 10 MB"));
    await rm(path.join(dir, "big.bin"));
    await truncate(await put(dir, "a.bin", ""), 6 * MB);
    await truncate(await put(dir, "b.bin", ""), 6 * MB);
    await expect(captureTree(dir)).rejects.toThrow("Skill too large (> 10485760 bytes).");
  });

  it("counts folders toward the entry cap", async () => {
    const flat = await scratch();
    const nested = await scratch();
    for (let index = 0; index < 101; index += 1) {
      await put(flat, `f${index}.md`);
      await put(nested, `d${index}/f.md`);
    }
    expect(await captureTree(flat)).toHaveLength(101);
    await expect(captureTree(nested)).rejects.toThrow(
      "Skill has too many files and folders (> 200).",
    );
  });
});

describe("normalizeTree", () => {
  it("cleans paths, sorts, and keeps the executable bit only under scripts/", () => {
    expect(
      readable(
        normalizeTree([
          file("scripts//run.sh", "a", true),
          file("./tool.sh", "b", true),
          file("notes/a.md", "c"),
        ]),
      ),
    ).toEqual([
      ["notes/a.md", "c", false],
      ["scripts/run.sh", "a", true],
      ["tool.sh", "b", false],
    ]);
  });

  it("refuses a path that leaves the skill folder", () => {
    expect(() => normalizeTree([file("notes/../../x")])).toThrow(
      "Skill file escapes the skill folder: notes/../../x.",
    );
    expect(() => normalizeTree([file("/etc/passwd")])).toThrow(
      "Skill file escapes the skill folder: /etc/passwd.",
    );
  });

  it("refuses a file that is also a folder of another", () => {
    expect(() => normalizeTree([file("a"), file("a/b")])).toThrow(
      "Skill has conflicting entries: a/b.",
    );
  });
});

describe("fingerprint", () => {
  it("ignores order and changes with the executable bit", () => {
    const tree = [file("SKILL.md"), file("scripts/run.sh", "x", true)];
    const sum = fingerprint(tree);
    expect(sum).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint([...tree].reverse())).toBe(sum);
    expect(fingerprint([file("SKILL.md"), file("scripts/run.sh", "x", false)])).not.toBe(sum);
  });
});

describe("withSkillMd", () => {
  it("replaces SKILL.md and keeps the rest", () => {
    expect(readable(withSkillMd([file("SKILL.md", "old"), file("notes.md")], "new"))).toEqual([
      ["SKILL.md", "new", false],
      ["notes.md", "notes.md", false],
    ]);
  });
});

describe("materialize", () => {
  it("brings a folder to exactly the tree, pruning stale files and folders", async () => {
    const root = await scratch();
    const dir = path.join(root, "skill");
    const staging = path.join(root, "staging");
    await put(dir, "SKILL.md", "old");
    await put(dir, "stale.md");
    await put(dir, "old/deep/x.txt");
    await put(dir, "scripts/keep.sh", "old", 0o755);
    await materialize(
      [file("SKILL.md", "new"), file("scripts/run.sh", "echo", true), file("a/b.md", "b")],
      dir,
      staging,
    );
    expect(await listing(dir)).toEqual([
      ["SKILL.md", "644", "new"],
      ["a", "dir"],
      ["a/b.md", "644", "b"],
      ["scripts", "dir"],
      ["scripts/run.sh", "755", "echo"],
    ]);
    expect(await readdir(staging)).toEqual([]);
  });

  it("refuses a planted link before deleting anything", async () => {
    const root = await scratch();
    const dir = path.join(root, "skill");
    for (const name of ["SKILL.md", "a.md", "m/x.md", "z.md", "zz/y.md"]) await put(dir, name);
    await symlink(path.join(root, "elsewhere"), path.join(dir, "m/link"));
    const before = await listing(dir);
    await expect(
      materialize([file("SKILL.md", "new")], dir, path.join(root, "staging")),
    ).rejects.toThrow(refusal("m/link", "is a link"));
    expect(await listing(dir)).toEqual(before);
    expect(before.map(([name]) => name)).toEqual([
      "SKILL.md",
      "a.md",
      "m",
      "m/link",
      "m/x.md",
      "z.md",
      "zz",
      "zz/y.md",
    ]);
  });
});
