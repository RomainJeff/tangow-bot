import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
if [ "$1" = auth ]; then echo "\${FAKE_AUTH:-0 credentials}"; exit 0; fi
dir=""; prev=""
for a in "$@"; do [ "$prev" = --dir ] && dir=$a; prev=$a; done
prompt="\${@: -1}"
echo '{"type":"step_start","sessionID":"ses_fake"}'
case "$prompt" in *SLOW*) sleep 60 ;; esac
case "$prompt" in *FAIL*) echo "boom" >&2; exit 1 ;; esac
git -C "$dir" commit -q --allow-empty -m "fake change"
echo '{"type":"text","sessionID":"ses_fake","part":{"text":"all done"}}'
`;

describe.skipIf(missingTools.length > 0)("delegate-to-opencode oc script", () => {
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  const oc = (...args: string[]) => {
    const result = spawnSync("bash", [OC, ...args], { env, encoding: "utf8" });
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
    root = await mkdtemp(path.join(os.tmpdir(), "oc-test-"));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "opencode"), FAKE_OPENCODE);
    await chmod(path.join(bin, "opencode"), 0o755);
    env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
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
    const result = oc("result", id);
    expect(result).toContain(`branch=oc/${id}`);
    expect(result).toContain("all done");
    expect(result).toContain("fake change");
    expect(await readFile(path.join(root, "oc-jobs", id, "prompt.md"), "utf8")).toContain(
      "Do not push",
    );

    expect(oc("send", id, await brief("followup", "Fix criterion 2."))).toBe(`ok id=${id}`);
    await waitFor(id, "done");
    expect(await readFile(path.join(root, "calls"), "utf8")).toContain("-s ses_fake");

    expect(oc("review", id)).toBe(`id=${id}-review`);
    await waitFor(`${id}-review`, "done");
    expect(await readFile(path.join(root, "calls"), "utf8")).toContain("--agent readonly");

    expect(oc("clean", id)).toBe(`ok kept_branch=oc/${id}`);
    expect(
      execFileSync("git", ["branch", "--list", `oc/${id}`], { cwd: repo, env }).toString(),
    ).toContain(`oc/${id}`);
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
    await utimes(path.join(root, "oc-jobs", stalled, "log"), old, old);
    expect(oc("status", stalled)).toContain("state=stalled");

    expect(oc("clean", stopped)).toContain("is running");
    expect(oc("stop", stopped)).toBe("stopped");
    expect(oc("status", stopped)).toContain("state=stopped");
  });

  it("rejects job ids that are not plain names", () => {
    expect(oc("status", "../etc")).toContain("invalid job id");
  });
});
