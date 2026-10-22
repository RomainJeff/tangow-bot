import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Offline test of skills/agent/delegate-to-opencode/scripts/oc against a fake `opencode`.
const OC = path.resolve(
  import.meta.dirname,
  "../../../../skills/agent/delegate-to-opencode/scripts/oc",
);
const missingTools = ["bash", "git", "jq", "setsid"].filter(
  (tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status !== 0,
);

// Brief keywords drive the fake: SLOW keeps the job running, FAIL exits 1.
const FAKE_OPENCODE = `#!/usr/bin/env bash
echo "$*" >> "$HOME/calls"
if [ "$1" = auth ] && [ "$2" = login ]; then echo "https://example.test/device Enter code: FAKE-CODE"; exit 0; fi
if [ "$1" = auth ]; then echo "\${FAKE_AUTH:-0 credentials}"; exit 0; fi
dir=""; prev=""
for a in "$@"; do [ "$prev" = --dir ] && dir=$a; prev=$a; done
prompt="\${@: -1}"
echo '{"type":"step_start","sessionID":"ses_fake"}'
echo '{"type":"tool_use","part":{"tool":"todowrite","state":{"status":"completed","input":{"todos":[{"content":"Write the footer","status":"in_progress"}]}}}}'
echo '{"type":"tool_use","part":{"tool":"bash","state":{"status":"error","title":"Run the tests","input":{}}}}'
case "$prompt" in *SLOW*) sleep 60 ;; esac
case "$prompt" in *FAIL*) echo "boom" >&2; exit 1 ;; esac
git -C "$dir" commit -q --allow-empty -m "fake change"
echo '{"type":"text","sessionID":"ses_fake","part":{"text":"all done"}}'
echo '{"type":"step_finish","part":{"cost":0.25,"tokens":{"input":1000,"output":200}}}'
`;

describe.skipIf(missingTools.length > 0)("delegate-to-opencode oc script", () => {
  let root: string;
  let home: string;
  let repo: string;
  let jobs: string;
  let env: NodeJS.ProcessEnv;

  const oc = (...args: string[]) => {
    const result = spawnSync("bash", [OC, ...args], { cwd: root, env, encoding: "utf8" });
    return `${result.stdout}${result.stderr}`.trim();
  };
  const brief = async (name: string, body: string) => {
    const file = path.join(root, `${name}.md`);
    await writeFile(file, `# ${name}\n\n${body}\n`);
    return file;
  };
  const start = async (body: string) => {
    const out = oc("start", "--repo", repo, "--brief", await brief(`b${Date.now()}`, body));
    const id = /^id=(\S+)/.exec(out)?.[1];
    if (!id) throw new Error(out);
    return id;
  };
  const waitFor = async (id: string, state: string) => {
    for (let i = 0; i < 100; i++) {
      if (oc("status", id).includes(`state=${state} `)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`job ${id} never reached ${state}: ${oc("status", id)}`);
  };

  beforeAll(async () => {
    const fixtureParent = process.env.OC_TEST_VOLUMES === "1" ? "/workspace/bots" : os.tmpdir();
    await mkdir(fixtureParent, { recursive: true });
    root = await realpath(await mkdtemp(path.join(fixtureParent, "oc-test-")));
    home = path.join(root, "home");
    await mkdir(home);
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "opencode"), FAKE_OPENCODE);
    await chmod(path.join(bin, "opencode"), 0o755);
    env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      OC_BOT_ID: path.basename(root),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    jobs =
      process.env.OC_TEST_VOLUMES === "1" ? path.join(root, "oc-jobs") : path.join(home, "oc-jobs");
    if (process.env.OC_TEST_VOLUMES === "1") env.OC_JOBS_DIR = jobs;
    repo = path.join(root, "repo");
    await mkdir(repo);
    for (const args of [
      ["init", "-q"],
      ["commit", "-q", "--allow-empty", "-m", "init"],
    ]) {
      execFileSync("git", args, { cwd: repo, env });
    }
  });

  afterAll(async () => {
    for (const line of oc("status").split("\n")) {
      const id = /^id=(\S+) state=(running|stalled)/.exec(line)?.[1];
      if (id) oc("stop", id);
    }
    await rm(root, { recursive: true, force: true });
  });

  it("reports missing credentials, then ready", () => {
    expect(oc("doctor")).toContain("state=no_credentials");
    env.FAKE_AUTH = "1 environment variable";
    expect(oc("doctor")).toContain("state=ready");
  });

  it("runs a job on its own branch, reports, and continues the same session", async () => {
    const id = await start("Add a footer.");
    await waitFor(id, "done");
    expect(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: path.join(jobs, id, "repo"),
        env,
      })
        .toString()
        .trim(),
    ).toBe(path.join(jobs, id, "repo"));
    await writeFile(path.join(jobs, id, "REPORT.md"), "Volume-backed report");
    const result = oc("result", id);
    expect(result).toContain(`branch=oc/${id}`);
    expect(result).toContain("Volume-backed report");
    expect(result).toContain("fake change");
    const detail = oc("status", id, "--detail");
    expect(detail).toContain(
      "steps=1 tools=2 failed_tools=1 tokens_in=1000 tokens_out=200 cost=0.25",
    );
    expect(detail).toContain("[in_progress] Write the footer");
    expect(detail).toContain("bash (failed): Run the tests");
    expect(detail).toContain("text: all done");
    expect(await readFile(path.join(jobs, id, "prompt.md"), "utf8")).toContain("Do not push");

    expect(oc("send", id, await brief("followup", "Fix criterion 2."))).toBe(`ok id=${id}`);
    await waitFor(id, "done");
    expect(await readFile(path.join(home, "calls"), "utf8")).toContain("-s ses_fake");

    expect(oc("review", id)).toBe(`id=${id}-review`);
    await waitFor(`${id}-review`, "done");
    expect(await readFile(path.join(home, "calls"), "utf8")).toContain("--agent readonly");

    expect(oc("clean", id)).toBe(`ok kept_branch=oc/${id}`);
    expect(
      execFileSync("git", ["branch", "--list", `oc/${id}`], { cwd: repo, env }).toString(),
    ).toContain(`oc/${id}`);
  });

  it("rejects relative, traversing, other-bot and symlink paths before starting a job", async () => {
    const file = await brief("validation", "Do nothing.");
    await symlink("/tmp", path.join(root, "outside"));
    await symlink(repo, path.join(root, "repo-link"));
    const configured = env.OC_JOBS_DIR;
    const botRoot = process.env.OC_TEST_VOLUMES === "1" ? root : "/workspace/bots/oc-test";
    const configuredBot = env.OC_BOT_ID;
    env.OC_BOT_ID = path.basename(botRoot);
    env.OC_JOBS_DIR = `${botRoot}/oc-jobs`;
    try {
      for (const invalid of [
        "repo",
        `${root}/../repo`,
        "/home/rakazo/repo",
        "/workspace/bots/other/repo",
        `${root}/outside/repo`,
      ]) {
        expect(oc("start", "--repo", invalid, "--brief", file)).toContain("error: --repo");
      }
      for (const invalid of [
        "brief.md",
        `${root}/../brief.md`,
        "/workspace/bots/other/brief.md",
        `${root}/outside/brief.md`,
      ]) {
        expect(oc("start", "--repo", `${botRoot}/repo`, "--brief", invalid)).toContain(
          "error: --brief",
        );
      }
      for (const invalid of [
        "jobs",
        `${root}/../oc-jobs`,
        "/tmp/oc-jobs",
        "/workspace/shared/oc-jobs",
        "/workspace/bots/other/oc-jobs",
        `${root}/outside/oc-jobs`,
      ]) {
        env.OC_JOBS_DIR = invalid;
        expect(oc("status")).toContain("error: OC_JOBS_DIR");
      }
    } finally {
      env.OC_BOT_ID = configuredBot;
      if (configured === undefined) delete env.OC_JOBS_DIR;
      else env.OC_JOBS_DIR = configured;
    }
  });

  it.skipIf(process.env.OC_TEST_VOLUMES !== "1")(
    "resolves volume symlinks and accepts a shared repository",
    async () => {
      const file = await brief("symlink", "Do nothing.");
      expect(oc("start", "--repo", path.join(root, "outside/repo"), "--brief", file)).toContain(
        "error: --repo",
      );
      const out = oc("start", "--repo", path.join(root, "repo-link"), "--brief", file);
      const id = /^id=(\S+)/.exec(out)?.[1];
      if (!id) throw new Error(out);
      await waitFor(id, "done");
      expect(oc("clean", id)).toBe(`ok kept_branch=oc/${id}`);
      await mkdir("/workspace/shared", { recursive: true });
      const shared = await mkdtemp("/workspace/shared/oc-test-");
      try {
        execFileSync("git", ["clone", "-q", repo, shared], { env });
        const sharedOut = oc("start", "--repo", shared, "--brief", file);
        const sharedId = /^id=(\S+)/.exec(sharedOut)?.[1];
        if (!sharedId) throw new Error(sharedOut);
        await waitFor(sharedId, "done");
        expect(oc("clean", sharedId)).toBe(`ok kept_branch=oc/${sharedId}`);
      } finally {
        await rm(shared, { recursive: true, force: true });
      }
    },
  );

  it("keeps device login scratch in the computer home", async () => {
    expect(oc("login", "openai")).toContain("code=FAKE-CODE");
    expect(await readFile(path.join(home, ".local/state/rakazo/oc-login/log"), "utf8")).toContain(
      "FAKE-CODE",
    );
    await expect(readFile(path.join(jobs, ".login/log"))).rejects.toThrow();
  });

  it("marks failures, stalls, and refuses a fourth running job", async () => {
    const failed = await start("FAIL please");
    await waitFor(failed, "failed");
    expect(oc("result", failed)).toContain("boom");

    const stalled = await start("SLOW 1");
    const stopped = await start("SLOW 2");
    await start("SLOW 3");
    expect(oc("start", "--repo", repo, "--brief", await brief("extra", "x"))).toBe(
      "state=busy running=3 max=3",
    );

    const old = new Date(Date.now() - 20 * 60_000);
    await utimes(path.join(jobs, stalled, "log"), old, old);
    expect(oc("status", stalled)).toContain("state=stalled");

    expect(oc("clean", stopped)).toContain("is running");
    expect(oc("stop", stopped)).toBe("stopped");
    expect(oc("status", stopped)).toContain("state=stopped");
  });

  it("keeps the legacy home location and rejects relative job roots", async () => {
    const configured = env.OC_JOBS_DIR;
    delete env.OC_JOBS_DIR;
    try {
      const id = await start("Legacy home job");
      await waitFor(id, "done");
      expect(oc("result", id)).toContain("all done");
      expect(await readFile(path.join(home, "oc-jobs", id, "root"), "utf8")).toBe(`${repo}\n`);
      expect(oc("clean", id)).toBe(`ok kept_branch=oc/${id}`);
      env.OC_JOBS_DIR = "relative/jobs";
      expect(oc("status")).toContain("OC_JOBS_DIR must be absolute");
    } finally {
      if (configured === undefined) delete env.OC_JOBS_DIR;
      else env.OC_JOBS_DIR = configured;
    }
  });

  it("rejects job ids that are not plain names", () => {
    expect(oc("status", "../etc")).toContain("invalid job id");
  });
});
