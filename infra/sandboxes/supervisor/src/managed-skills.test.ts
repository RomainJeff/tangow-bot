import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncManagedSkills } from "./managed-skills.js";

const logger = { warn: vi.fn() } as unknown as Parameters<typeof syncManagedSkills>[2];

describe("syncManagedSkills", () => {
  let root: string;
  let repo: string;
  let data: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "managed-skills-"));
    repo = path.join(root, "repo");
    data = path.join(root, "data");
    await mkdir(path.join(repo, "skills", "agent", "alpha"), { recursive: true });
    await writeFile(
      path.join(repo, "skills", "agent", "alpha", "SKILL.md"),
      "---\nname: Alpha\n---\n",
    );
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  it("copies skills, drops stale slugs and leftover tmp dirs", async () => {
    const agent = path.join(data, "managed-skills", "agent");
    await mkdir(path.join(agent, "removed"), { recursive: true });
    await mkdir(path.join(agent, ".tmp-alpha"), { recursive: true });
    await writeFile(path.join(agent, ".tmp-alpha", "junk"), "x");

    await syncManagedSkills(repo, data, logger);

    expect(await readdir(agent)).toEqual(["alpha"]);
    expect(await readFile(path.join(agent, "alpha", "SKILL.md"), "utf8")).toContain("name: Alpha");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("tolerates a family missing from the repo", async () => {
    await syncManagedSkills(repo, data, logger);
    expect(await readdir(path.join(data, "managed-skills", "computer"))).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
