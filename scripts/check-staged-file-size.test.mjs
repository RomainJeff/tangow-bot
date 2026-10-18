import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const checker = new URL("./check-staged-file-size.mjs", import.meta.url);

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), "staged-size-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  const write = (path, contents) => writeFileSync(join(cwd, path), contents);
  const check = () => spawnSync(process.execPath, [checker.pathname], { cwd, encoding: "utf8" });
  return { cwd, git, write, check };
}

test("accepts 20,000 staged bytes and ignores oversized unstaged contents", (t) => {
  const { git, write, check } = repository(t);
  write("source.js", "x".repeat(20_000));
  git("add", "source.js");
  write("source.js", "x".repeat(24_000));
  write("untracked.js", "x".repeat(24_000));
  assert.equal(check().status, 0);
});

test("rejects staged UTF-8 bytes even when the working copy is small, with splitting instructions", (t) => {
  const { git, write, check } = repository(t);
  const path = "odd\tname\nsource.js";
  write(path, "é".repeat(10_001));
  git("add", "--", path);
  write(path, "small");
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /5,000 tokens/);
  assert.match(result.stderr, /20,002 bytes/);
  assert.ok(result.stderr.includes(JSON.stringify(path)));
  assert.match(result.stderr, /Split/);
  assert.match(result.stderr, /git add/);
});

test("uses staged generated and vendored attributes and skips binary files", (t) => {
  const { cwd, git, write, check } = repository(t);
  write("pnpm-lock.yaml", "x".repeat(24_000));
  mkdirSync(join(cwd, "generated"));
  write("generated/client.js", "x".repeat(24_000));
  write("vendor.js", "x".repeat(24_000));
  write(
    ".gitattributes",
    `${readFileSync(new URL("../.gitattributes", import.meta.url), "utf8")}\nvendor.js linguist-vendored\n`,
  );
  write("image.bin", Buffer.alloc(24_000));
  git("add", ".");
  write(".gitattributes", "");
  assert.equal(check().status, 0);
});

test("ignores unchanged oversized files and deletions, but checks renamed destinations", (t) => {
  const { git, write, check } = repository(t);
  write("old.js", "x".repeat(20_001));
  write("deleted.js", "x".repeat(20_001));
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
  write("small.js", "small");
  git("add", "small.js");
  git("rm", "deleted.js");
  assert.equal(check().status, 0);
  git("mv", "old.js", "renamed.js");
  assert.equal(check().status, 1);
});

test("the pre-commit hook blocks a real commit", (t) => {
  const { cwd, git, write } = repository(t);
  mkdirSync(join(cwd, "scripts"));
  mkdirSync(join(cwd, ".githooks"));
  copyFileSync(checker, join(cwd, "scripts/check-staged-file-size.mjs"));
  copyFileSync(
    new URL("../.githooks/pre-commit", import.meta.url),
    join(cwd, ".githooks/pre-commit"),
  );
  git("config", "core.hooksPath", ".githooks");
  write("source.js", "x".repeat(20_001));
  git("add", "source.js");
  const result = spawnSync("git", ["commit", "-qm", "blocked"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source.js/);
});
