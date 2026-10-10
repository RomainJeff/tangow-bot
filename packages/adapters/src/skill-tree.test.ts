import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readdirOrEmpty, readHistoryJson, writeJsonAtomic } from "./skill-tree.js";

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
