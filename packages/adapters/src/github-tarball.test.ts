import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { create as tarCreate } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  downloadGithubTarball,
  parseGithubRepoUrl,
  resolveGithubCommit,
} from "./github-tarball.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tmp() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-tarball-"));
  dirs.push(dir);
  return dir;
}

/** Builds `<repo>-<sha>/…` like codeload does, with a symlink to make sure we drop it. */
async function fixtureTarball(): Promise<Buffer> {
  const src = await tmp();
  const top = path.join(src, "repo-abc123");
  await mkdir(path.join(top, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(top, ".claude-plugin/marketplace.json"),
    '{"name":"acme","plugins":[]}',
  );
  await mkdir(path.join(top, "plugins/p/skills/s"), { recursive: true });
  await writeFile(
    path.join(top, "plugins/p/skills/s/SKILL.md"),
    "---\nname: s\ndescription: d\n---\nbody",
  );
  await symlink("/etc/passwd", path.join(top, "plugins/p/skills/s/link"));
  const out = path.join(src, "out.tgz");
  await tarCreate({ gzip: true, cwd: src, file: out }, ["repo-abc123"]);
  return readFile(out);
}

const fetchWith = (body: Buffer | string, status = 200) =>
  (async () =>
    new Response(new Uint8Array(Buffer.from(body)), { status })) as unknown as typeof fetch;

describe("parseGithubRepoUrl", () => {
  it("accepts https github urls with or without .git", () => {
    expect(parseGithubRepoUrl("https://github.com/acme/skills")).toEqual({
      owner: "acme",
      repo: "skills",
    });
    expect(parseGithubRepoUrl("https://github.com/acme/skills.git/")).toEqual({
      owner: "acme",
      repo: "skills",
    });
  });
  it("rejects anything else", () => {
    expect(() => parseGithubRepoUrl("https://gitlab.com/a/b")).toThrow(/github/i);
    expect(() => parseGithubRepoUrl("http://github.com/a/b")).toThrow(/github/i);
    expect(() => parseGithubRepoUrl("https://github.com/acme")).toThrow();
    expect(() => parseGithubRepoUrl("https://github.com/acme/skills/tree/main")).toThrow();
    expect(() => parseGithubRepoUrl("not a url")).toThrow();
  });
});

describe("resolveGithubCommit", () => {
  it("asks the commits API for the sha", async () => {
    const calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push(`${url} ${new Headers(init?.headers).get("accept")}`);
      return new Response("0123456789abcdef0123456789abcdef01234567");
    }) as unknown as typeof fetch;
    await expect(
      resolveGithubCommit({ owner: "acme", repo: "skills", ref: "main" }, f),
    ).resolves.toBe("0123456789abcdef0123456789abcdef01234567");
    expect(calls[0]).toBe(
      "https://api.github.com/repos/acme/skills/commits/main application/vnd.github.sha",
    );
  });
  it("rejects non-2xx, non-sha bodies and bad refs", async () => {
    await expect(
      resolveGithubCommit({ owner: "a", repo: "b", ref: "x" }, fetchWith("nope", 404)),
    ).rejects.toThrow(/404/);
    await expect(
      resolveGithubCommit({ owner: "a", repo: "b", ref: "x" }, fetchWith("<html>")),
    ).rejects.toThrow(/sha/i);
    await expect(
      resolveGithubCommit({ owner: "a", repo: "b", ref: "../x" }, fetchWith("")),
    ).rejects.toThrow(/ref/i);
  });
});

describe("downloadGithubTarball", () => {
  it("extracts files, strips the top dir and drops symlinks", async () => {
    const dest = await tmp();
    await downloadGithubTarball({ owner: "acme", repo: "repo", commit: "abc123" }, dest, {
      fetch: fetchWith(await fixtureTarball()),
    });
    expect(await readFile(path.join(dest, ".claude-plugin/marketplace.json"), "utf8")).toContain(
      '"acme"',
    );
    expect(await readdir(path.join(dest, "plugins/p/skills/s"))).toEqual(["SKILL.md"]);
    await expect(lstat(path.join(dest, "plugins/p/skills/s/link"))).rejects.toThrow();
  });
  it("aborts past maxBytes", async () => {
    const dest = await tmp();
    await expect(
      downloadGithubTarball({ owner: "a", repo: "r", commit: "c" }, dest, {
        fetch: fetchWith(await fixtureTarball()),
        maxBytes: 64,
      }),
    ).rejects.toThrow(/too large/i);
  });
  it("fails on non-2xx", async () => {
    const dest = await tmp();
    await expect(
      downloadGithubTarball({ owner: "a", repo: "r", commit: "c" }, dest, {
        fetch: fetchWith("", 404),
      }),
    ).rejects.toThrow(/404/);
  });
});
