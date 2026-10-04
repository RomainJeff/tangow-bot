import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

  it("tolerates a computer family missing from the repo", async () => {
    await syncManagedSkills(repo, data, logger);
    expect(await readdir(path.join(data, "managed-skills", "computer"))).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns when the agent family is missing from the repo", async () => {
    await rm(path.join(repo, "skills", "agent"), { recursive: true });
    await syncManagedSkills(repo, data, logger);
    expect(await readdir(path.join(data, "managed-skills", "agent"))).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "managed skills source missing",
      expect.objectContaining({ family: "agent" }),
    );
  });

  it("copies symlinks verbatim instead of dereferencing them", async () => {
    const alpha = path.join(repo, "skills", "agent", "alpha");
    await writeFile(path.join(alpha, "REF.md"), "ref");
    await symlink("REF.md", path.join(alpha, "LINK.md"));
    await syncManagedSkills(repo, data, logger);
    const copied = path.join(data, "managed-skills", "agent", "alpha", "LINK.md");
    expect(await readlink(copied)).toBe("REF.md");
    expect(await readFile(copied, "utf8")).toBe("ref");
  });
});
