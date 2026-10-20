import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, PortableFile, VolumeFiles } from "@rakazo/adapter-kit";
import { buildSkillMd } from "@rakazo/core";
import { afterEach, expect, it } from "vitest";
import { migrateUserSkillsToShared } from "./skill-volume-migration.js";
import type { SkillRoot } from "./volume-skills.js";
import { convergeSkills, discoverVolumeSkills, reportVolumeSkill } from "./volume-skills.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "volume-skills-"));
  dirs.push(dir);
  return dir;
}
async function skill(root: string, dir: string, name = dir) {
  await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(
    path.join(root, dir, "SKILL.md"),
    buildSkillMd({ name, description: `Use ${name}`, body: `Follow ${dir}` }),
  );
}

it("creates one link per skill with managed, bot, shared precedence and reports every collision", async () => {
  const root = await fixture();
  const sources: SkillRoot["source"][] = ["shared", "bot", "managed"];
  const roots = sources.map((source) => ({ source, path: path.join(root, source) }));
  await skill(roots[0]!.path, "shared-only");
  await skill(roots[0]!.path, "shared-copy", "Review");
  await skill(roots[0]!.path, "bot-copy", "Notes");
  await skill(roots[1]!.path, "bot-only");
  await skill(roots[1]!.path, "bot-copy", "Review");
  await skill(roots[1]!.path, "notes", "Notes");
  await skill(roots[2]!.path, "review", "Review");
  await symlink(path.join(roots[1]!.path, "bot-only"), path.join(roots[0]!.path, "escape"));
  const home = path.join(root, "home");
  const converged = await convergeSkills(home, roots);
  expect(converged.skills.map(({ name, source }) => [name, source])).toEqual([
    ["Review", "managed"],
    ["bot-only", "bot"],
    ["Notes", "bot"],
    ["shared-only", "shared"],
  ]);
  expect(converged.collisions).toEqual([
    { name: "Review", kept: "managed", ignored: "bot" },
    { name: "Notes", kept: "bot", ignored: "shared" },
    { name: "Review", kept: "managed", ignored: "shared" },
  ]);
  expect(await readlink(path.join(converged.skillsDir, "review"))).toBe(
    path.join(root, "managed", "review"),
  );
  expect((await lstat(path.join(converged.skillsDir, "notes"))).isSymbolicLink()).toBe(true);
  expect(await readFile(path.join(converged.skillsDir, "notes", "SKILL.md"), "utf8")).toContain(
    "Follow notes",
  );
});

it("refuses every pre-existing skill entry, including a later user symlink", async () => {
  const home = await fixture();
  const custom = path.join(home, ".agents", "skills", "custom");
  await mkdir(custom, { recursive: true });
  await writeFile(path.join(custom, "SKILL.md"), "user's original skill");
  await expect(convergeSkills(home, [])).rejects.toThrow(/unowned entry|must be empty/);
  expect(await readFile(path.join(custom, "SKILL.md"), "utf8")).toBe("user's original skill");
  const vm = await fixture();
  const managed = path.join(vm, "managed");
  await skill(managed, "guide");
  const result = await convergeSkills(vm, [{ source: "managed", path: managed }]);
  await rm(path.join(result.skillsDir, "guide"));
  const userTarget = path.join(vm, "user-skill");
  await mkdir(userTarget);
  await writeFile(path.join(userTarget, "keep"), "user edit");
  await symlink(userTarget, path.join(result.skillsDir, "guide"));
  await expect(convergeSkills(vm, [])).rejects.toThrow("must be empty");
  expect(await readlink(path.join(result.skillsDir, "guide"))).toBe(userTarget);
  expect(await readFile(path.join(userTarget, "keep"), "utf8")).toBe("user edit");
});

it("skips a shared skill removed by another writer during indexing", async () => {
  const root = await fixture();
  await skill(root, "shared-guide");
  const { skills } = await discoverVolumeSkills([{ source: "shared", path: root }]);
  await rm(path.join(root, "shared-guide"), { recursive: true });
  expect(await reportVolumeSkill(skills[0]!)).toBeUndefined();
});

it("copies legacy owners' bundles to shared skills once, preserves originals and reports changed targets", async () => {
  const root = await fixture();
  const source = path.join(root, "source");
  await skill(path.join(source, "owner-a"), "weekly");
  await mkdir(path.join(source, "owner-a", "weekly", "scripts"));
  const script = path.join(source, "owner-a", "weekly", "scripts", "run.sh");
  await writeFile(script, "echo weekly\n");
  await chmod(script, 0o755);
  await skill(path.join(source, "owner-b"), "weekly");
  await mkdir(path.join(source, "owner-b", "weekly", "scripts"));
  await writeFile(path.join(source, "owner-b", "weekly", "scripts", "run.sh"), "echo weekly\n");
  await chmod(path.join(source, "owner-b", "weekly", "scripts", "run.sh"), 0o755);
  await skill(path.join(source, "owner-a"), "unicode");
  const unicode = buildSkillMd({
    name: "unicode",
    description: "A legacy Unicode skill",
    body: "あ".repeat(40_000),
  });
  await writeFile(path.join(source, "owner-a", "unicode", "SKILL.md"), unicode);
  const stored = new Map<string, PortableFile>();
  let writes = 0;
  const files: VolumeFiles = {
    list: async () =>
      [...stored.values()].map((file) => ({
        path: file.path,
        kind: "file",
        mode: file.mode ?? 0o644,
      })),
    read: async (_volume, file) => stored.get(file)!.content,
    write: async (_volume, file) => {
      writes++;
      stored.set(file.path, file);
    },
  };
  const context: AdapterContext = {
    operationId: "migration",
    traceId: "migration",
    spaceId: "space",
    userId: "operator",
    signal: new AbortController().signal,
  };
  const options = { source, volumeRef: "shared", files };
  expect(await migrateUserSkillsToShared({ ...options, dryRun: true }, context)).toMatchObject({
    planned: 3,
    copied: 0,
    unchanged: 0,
  });
  expect(writes).toBe(0);
  expect(await migrateUserSkillsToShared(options, context)).toMatchObject({
    planned: 3,
    copied: 3,
    unchanged: 0,
  });
  expect(await migrateUserSkillsToShared(options, context)).toMatchObject({
    planned: 3,
    copied: 0,
    unchanged: 3,
  });
  expect(writes).toBe(3);
  expect(Buffer.from(stored.get("skills/unicode/SKILL.md")!.content).toString()).toBe(unicode);
  expect(stored.get("skills/weekly/scripts/run.sh")?.mode).toBe(0o755);
  expect(await readFile(script, "utf8")).toBe("echo weekly\n");
  const target = stored.get("skills/weekly/SKILL.md")!;
  stored.set(target.path, { ...target, content: Buffer.from("changed on the volume") });
  expect(await migrateUserSkillsToShared(options, context)).toMatchObject({
    copied: 0,
    events: expect.arrayContaining([
      expect.objectContaining({ kind: "conflict", skill: "weekly" }),
    ]),
  });
  expect(Buffer.from(stored.get(target.path)!.content).toString()).toBe("changed on the volume");
  expect(writes).toBe(3);
});

it("reports invalid, hidden and conflicting bundles while copying independent skills", async () => {
  const root = await fixture();
  const source = path.join(root, "source");
  for (const owner of ["a", "b"]) await skill(path.join(source, owner), "collision");
  await writeFile(path.join(source, "a", "collision", "extra.txt"), "a");
  await writeFile(path.join(source, "b", "collision", "extra.txt"), "b");
  for (const owner of ["a", "b"]) await skill(path.join(source, owner), "inventory");
  await writeFile(path.join(source, "a", "inventory", "extra.txt"), "extra");
  await skill(path.join(source, "a"), "good");
  await skill(path.join(source, "a"), "duplicate", "good");
  // Both names and bodies match, so the duplicate bundle can merge exactly.
  await writeFile(
    path.join(source, "a", "duplicate", "SKILL.md"),
    await readFile(path.join(source, "a", "good", "SKILL.md")),
  );
  await skill(path.join(source, "a"), ".hidden");
  await mkdir(path.join(source, "a", "broken"));
  await writeFile(path.join(source, "a", "broken", "SKILL.md"), "not a skill");
  const stored = new Map<string, PortableFile>();
  const files: VolumeFiles = {
    list: async () =>
      [...stored.values()].map((file) => ({
        path: file.path,
        kind: "file",
        mode: file.mode ?? 0o644,
      })),
    read: async (_volume, file) => stored.get(file)!.content,
    write: async (_volume, file) => {
      stored.set(file.path, file);
    },
  };
  const report = await migrateUserSkillsToShared(
    { source, volumeRef: "shared", files },
    {
      operationId: "migration",
      traceId: "migration",
      spaceId: "space",
      userId: "operator",
      signal: new AbortController().signal,
    },
  );
  expect([...stored.keys()]).toEqual(["skills/good/SKILL.md"]);
  expect(report).toMatchObject({
    events: expect.arrayContaining([
      expect.objectContaining({ kind: "conflict", skill: "collision" }),
      expect.objectContaining({ kind: "conflict", skill: "inventory" }),
      expect.objectContaining({ kind: "merged", skill: "good" }),
      expect.objectContaining({ kind: "skipped", reason: "hidden directory" }),
      expect.objectContaining({ kind: "skipped", reason: "invalid SKILL.md" }),
    ]),
  });
});
