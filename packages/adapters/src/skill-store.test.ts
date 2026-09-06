import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SKILL_BUNDLE_MAX_BYTES, SKILL_BUNDLE_MAX_ENTRIES } from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import { create as tarCreate } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import {
  isExists,
  listUserSkills,
  removeUserSkill,
  removeUserSkillDirs,
  renameUserSkill,
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

  it("renaming moves the whole directory, keeping bundle extras", async () => {
    const root = await tmpRoot();
    await writeUserSkill(root, { name: "Alpha", content: md("Alpha") }, "create");
    await mkdir(path.join(root, "alpha", "scripts"), { recursive: true });
    await writeFile(path.join(root, "alpha", "scripts", "run.sh"), "echo hi");

    await renameUserSkill(root, "Alpha", { name: "Beta", content: md("Beta") });

    expect((await listUserSkills(root)).map((s) => s.name)).toEqual(["Beta"]);
    expect(await readFile(path.join(root, "beta", "scripts", "run.sh"), "utf8")).toBe("echo hi");
    expect(await readFile(path.join(root, "beta", "SKILL.md"), "utf8")).toBe(md("Beta"));
    await expect(stat(path.join(root, "alpha"))).rejects.toThrow();
  });

  it("refuses to rename onto an existing skill name", async () => {
    const root = await tmpRoot();
    await writeUserSkill(root, { name: "Alpha", content: md("Alpha") }, "create");
    await writeUserSkill(root, { name: "Beta", content: md("Beta") }, "create");
    const error = await renameUserSkill(root, "Alpha", {
      name: "Beta",
      content: md("Beta"),
    }).catch((e: unknown) => e);
    expect(isExists(error)).toBe(true);
    expect((await listUserSkills(root)).map((s) => s.name)).toEqual(["Alpha", "Beta"]);
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

    it("rejects data that is neither a gzip tar nor a zip", async () => {
      const root = await tmpRoot();
      await expect(
        writeUserSkillBundle(root, Buffer.from("plain text"), resolve),
      ).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    });
  });

  describe("zip bundles", () => {
    const resolve = async (skillMd: string) => {
      const name = /^name: (.*)$/m.exec(skillMd)?.[1] ?? "";
      return { name, content: `${skillMd}\n<!-- normalized -->\n` };
    };

    type ZipEntry = { name: string; content?: string; mode?: number; compress?: boolean };

    async function zip(entries: ZipEntry[]): Promise<Buffer> {
      const file = new ZipFile();
      for (const entry of entries) {
        if (entry.name.endsWith("/")) {
          file.addEmptyDirectory(entry.name);
          continue;
        }
        const options: { mode?: number; compress?: boolean } = {};
        if (entry.mode !== undefined) options.mode = entry.mode;
        if (entry.compress !== undefined) options.compress = entry.compress;
        file.addBuffer(Buffer.from(entry.content ?? ""), entry.name, options);
      }
      file.end();
      const chunks: Buffer[] = [];
      await new Promise<void>((done, fail) => {
        file.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
        file.outputStream.on("end", () => done());
        file.outputStream.on("error", fail);
      });
      return Buffer.concat(chunks);
    }

    /**
     * Rewrites zip headers in place; yazl refuses to author these on its own. `only` restricts the
     * edit to one entry's headers, read from the name that follows each header (local +30, central
     * +46, each preceded by its own name length), so patching a bomb never also corrupts SKILL.md.
     */
    function patchHeaders(
      archive: Buffer,
      edit: (out: Buffer, local: number, central: number) => void,
      only?: string,
    ): Buffer {
      const out = Buffer.from(archive);
      const named = (at: number, lengthAt: number, nameAt: number) =>
        only === undefined ||
        out.toString("utf8", at + nameAt, at + nameAt + out.readUInt16LE(at + lengthAt)) === only;
      for (let i = 0; i + 30 <= out.length; i++) {
        const signature = out.readUInt32LE(i);
        if (signature === 0x04034b50 && named(i, 26, 30)) edit(out, i, -1);
        else if (signature === 0x02014b50 && named(i, 28, 46)) edit(out, -1, i);
      }
      return out;
    }

    const declareSize = (archive: Buffer, name: string, size: number) =>
      patchHeaders(
        archive,
        (out, local, central) => {
          if (local >= 0) out.writeUInt32LE(size, local + 22);
          else out.writeUInt32LE(size, central + 24);
        },
        name,
      );

    const markEncrypted = (archive: Buffer) =>
      patchHeaders(archive, (out, local, central) => {
        const at = local >= 0 ? local + 6 : central + 8;
        out.writeUInt16LE(out.readUInt16LE(at) | 0x1, at);
      });

    it("extracts SKILL.md with its extra files next to it, dropping symlinks", async () => {
      const root = await tmpRoot();
      const archive = await zip([
        { name: "SKILL.md", content: md("Deploy") },
        { name: "scripts/run.sh", content: "echo hi" },
        { name: "references/notes.md", content: "n" },
        { name: "link", content: "/etc/passwd", mode: 0o120777 },
      ]);
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
      const archive = await zip([
        { name: "deploy/SKILL.md", content: md("Deploy") },
        { name: "deploy/x.txt", content: "x" },
      ]);
      await writeUserSkillBundle(root, archive, resolve);
      expect(await readFile(path.join(root, "deploy", "x.txt"), "utf8")).toBe("x");
    });

    it("accepts a Finder-compressed archive, ignoring its __MACOSX sibling", async () => {
      const root = await tmpRoot();
      // What `ditto -c -k --sequesterRsrc --keepParent` writes for a directory with xattrs.
      const archive = await zip([
        { name: "deploy/" },
        { name: "deploy/SKILL.md", content: md("Deploy") },
        { name: "deploy/run.sh", content: "echo hi" },
        { name: "__MACOSX/" },
        { name: "__MACOSX/deploy/" },
        { name: "__MACOSX/deploy/._run.sh", content: "\u0000\u0005\u0016\u0007" },
      ]);
      await writeUserSkillBundle(root, archive, resolve);
      expect(await readdir(root)).toEqual(["deploy"]);
      const dir = path.join(root, "deploy");
      expect((await readdir(dir)).sort()).toEqual(["SKILL.md", "run.sh"]);
      expect(await readFile(path.join(dir, "run.sh"), "utf8")).toBe("echo hi");
    });

    it("rejects bundles without SKILL.md at the root and cleans up", async () => {
      const root = await tmpRoot();
      const archive = await zip([
        { name: "a/SKILL.md", content: md("A") },
        { name: "b/SKILL.md", content: md("B") },
      ]);
      await expect(writeUserSkillBundle(root, archive, resolve)).rejects.toThrow(/SKILL\.md/);
      expect(await readdir(root)).toEqual([]);
    });

    it("fails with EEXIST on a name clash without touching the existing skill", async () => {
      const root = await tmpRoot();
      await writeUserSkill(root, { name: "Deploy", content: md("Deploy", "Old") }, "create");
      const archive = await zip([
        { name: "SKILL.md", content: md("Deploy") },
        { name: "x.txt", content: "x" },
      ]);
      const error = await writeUserSkillBundle(root, archive, resolve).catch((e: unknown) => e);
      expect(isExists(error)).toBe(true);
      expect(await readFile(path.join(root, "deploy", "SKILL.md"), "utf8")).toBe(
        md("Deploy", "Old"),
      );
      expect(await readdir(root)).toEqual(["deploy"]);
    });

    it("caps the bytes it observes, not the size the archive declares", async () => {
      const root = await tmpRoot();
      // Deflates to a few KB, so only the running counter over the inflated stream catches it.
      // Twice the cap, so the counter trips with megabytes still in flight: at cap + 1 byte the
      // stream ends in the same tick and yauzl's own end-of-entry error can win the race.
      const bomb = await zip([
        { name: "SKILL.md", content: md("Bomb") },
        { name: "blob.bin", content: "a".repeat(SKILL_BUNDLE_MAX_BYTES * 2) },
      ]);
      await expect(writeUserSkillBundle(root, bomb, resolve)).rejects.toThrow(/too large/);
      expect(await readdir(root)).toEqual([]);

      // Same bytes, blob.bin alone now claiming to be 1 KB: the inflated stream is cut short,
      // by yauzl's size assertion or by our counter, whichever trips first. Never written.
      await expect(
        writeUserSkillBundle(root, declareSize(bomb, "blob.bin", 1024), resolve),
      ).rejects.toThrow(/too many bytes|too large/);
      expect(await readdir(root)).toEqual([]);

      // 0xffffffff declares more than yauzl will ever assert, so only our own counter stops it.
      await expect(
        writeUserSkillBundle(root, declareSize(bomb, "blob.bin", 0xffffffff), resolve),
      ).rejects.toThrow(/too large/);
      expect(await readdir(root)).toEqual([]);

      // Stored entries get no size assertion from yauzl at all: the counter is the only bound.
      const stored = await zip([
        { name: "SKILL.md", content: md("Stored") },
        {
          name: "blob.bin",
          content: "a".repeat(SKILL_BUNDLE_MAX_BYTES + 1),
          compress: false,
        },
      ]);
      await expect(writeUserSkillBundle(root, stored, resolve)).rejects.toThrow(/too large/);
      expect(await readdir(root)).toEqual([]);

      // One counter for the whole bundle: two entries under the cap that together exceed it.
      const half = "b".repeat(Math.ceil(SKILL_BUNDLE_MAX_BYTES * 0.6));
      const split = await zip([
        { name: "SKILL.md", content: md("Split") },
        { name: "one.bin", content: half },
        { name: "two.bin", content: half },
      ]);
      await expect(writeUserSkillBundle(root, split, resolve)).rejects.toThrow(/too large/);
      expect(await readdir(root)).toEqual([]);
    });

    it("rejects bundles with too many entries", async () => {
      const root = await tmpRoot();
      const archive = await zip([
        { name: "SKILL.md", content: md("Many") },
        ...Array.from({ length: SKILL_BUNDLE_MAX_ENTRIES }, (_, i) => ({
          name: `f/${i}.txt`,
          content: "x",
        })),
      ]);
      await expect(writeUserSkillBundle(root, archive, resolve)).rejects.toThrow(/too many/);
      expect(await readdir(root)).toEqual([]);
    });

    it("rejects truncated zip bytes", async () => {
      const root = await tmpRoot();
      const archive = await zip([{ name: "SKILL.md", content: md("Cut") }]);
      await expect(
        writeUserSkillBundle(root, archive.subarray(0, archive.length - 20), resolve),
      ).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    });

    it("rejects entries that escape the bundle root", async () => {
      const root = await tmpRoot();
      // yazl refuses to author "..", so swap in a same-length placeholder after the fact.
      const archive = await zip([
        { name: "SKILL.md", content: md("Escape") },
        { name: "zz/escape.txt", content: "pwned" },
      ]);
      const traversal = Buffer.from(
        archive.toString("latin1").replaceAll("zz/escape.txt", "../escape.txt"),
        "latin1",
      );
      await expect(writeUserSkillBundle(root, traversal, resolve)).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
      await expect(stat(path.join(root, "..", "escape.txt"))).rejects.toThrow();
    });

    it("reports entries that collide with each other, without leaking the temp path", async () => {
      const root = await tmpRoot();
      const archive = await zip([
        { name: "SKILL.md", content: md("Clash") },
        { name: "scripts", content: "not a directory" },
        { name: "scripts/run.sh", content: "echo hi" },
      ]);
      const error = await writeUserSkillBundle(root, archive, resolve).catch((e: unknown) => e);
      // Not EEXIST: that signal is reserved for a name clash with an existing skill.
      expect(isExists(error)).toBe(false);
      expect((error as Error).message).toMatch(/conflicting entries: scripts\/run\.sh/);
      expect((error as Error).message).not.toContain(root);
      expect(await readdir(root)).toEqual([]);

      // An entry named "." resolves onto the bundle directory itself: same treatment.
      const dot = await zip([
        { name: "SKILL.md", content: md("Dot") },
        { name: ".", content: "x" },
      ]);
      const dotError = await writeUserSkillBundle(root, dot, resolve).catch((e: unknown) => e);
      expect((dotError as Error).message).toMatch(/^Skill bundle /);
      expect((dotError as Error).message).not.toContain(root);
      expect(await readdir(root)).toEqual([]);
    });

    it("rejects encrypted entries by name", async () => {
      const root = await tmpRoot();
      const archive = await zip([
        { name: "SKILL.md", content: md("Secret") },
        { name: "payload.txt", content: "z".repeat(2048) },
      ]);
      await expect(writeUserSkillBundle(root, markEncrypted(archive), resolve)).rejects.toThrow(
        /encryption/,
      );
      expect(await readdir(root)).toEqual([]);
    });
  });
});
