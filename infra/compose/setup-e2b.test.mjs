import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("./setup-e2b.mjs", import.meta.url));
const sha = "a".repeat(40);
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "rakazo-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "infra/compose"), { recursive: true });
  mkdirSync(path.join(root, "bin"));
  copyFileSync(source, path.join(root, "infra/compose/setup-e2b.mjs"));
  copyFileSync(
    fileURLToPath(new URL("../../.gitignore", import.meta.url)),
    path.join(root, ".gitignore"),
  );
  writeFileSync(
    path.join(root, ".env"),
    'POSTGRES_PASSWORD=fake-db\nSANDBOX_SUPERVISOR_TOKEN=fake-supervisor\nSCREEN_PROXY_SECRET=fake-screen\nUNRELATED="$(touch should-not-exist)"\nE2B_DOMAIN=e2b.example.com\nE2B_API_KEY=fake-test-secret\n',
  );
  writeFileSync(path.join(root, "infra/compose/docker-compose.yml"), "services: {}\n");
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const name = require('node:path').basename(process.argv[1]);
fs.appendFileSync(process.env.CALLS, JSON.stringify([name,...args])+'\\n');
if (name === 'git') {
 if (args.includes('rev-parse')) console.log('${sha}');
} else if (name === 'docker') {
 if (args[0] === 'compose' && args.includes('ps')) console.log('container-id');
 if (args[0] === 'inspect') console.log(args.includes('{{.State.Running}}') ? (process.env.WORKER_STOPPED ? 'false' : 'true') : process.env.MISMATCH ? 'b'.repeat(40) : '${sha}');
 if (args[0] === 'image') console.log('registry.example.com/computer@sha256:'+'c'.repeat(64));
 if (args.includes('up') && process.env.FAIL_START && fs.existsSync('.env.e2b.compose.json')) process.exit(1);
 if (args.includes('logs')) console.log('worker ready');
 if (args.includes('exec') && !args.includes('ps')) {
   global.fetch = async () => ({ ok: true, json: async () => ({ok:true,sandbox:process.env.FAIL_HEALTH?'docker':'e2b',revision:'${sha}'}) });
   eval('(async () => {' + args.at(-1) + '})()').catch(() => process.exit(1));
 }
} else if (name === 'pnpm' && process.env.FAIL_BUILD && args.includes('template:build')) process.exit(1);
`;
  for (const name of ["git", "docker", "pnpm"])
    writeFileSync(path.join(root, "bin", name), fake, { mode: 0o755 });
  const calls = path.join(root, "calls");
  const baseEnv = { ...process.env };
  for (const name of Object.keys(baseEnv))
    if (name.startsWith("E2B_") || name === "WORKER_TEMPLATE") delete baseEnv[name];
  const invoke = (args = [], env = {}) =>
    spawnSync(
      process.execPath,
      [
        path.join(root, "infra/compose/setup-e2b.mjs"),
        "--computer-image",
        "registry.example.com/computer:local",
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...baseEnv,
          PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
          CALLS: calls,
          ...env,
        },
      },
    );
  return {
    root,
    invoke,
    calls: () =>
      existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse) : [],
  };
}

test("dry-run leaves files untouched and runs no external commands", (t) => {
  const f = fixture(t);
  const result = f.invoke(["--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(path.join(f.root, ".env.e2b.compose.json")), false);
  assert.doesNotMatch(result.stdout + result.stderr, /fake-test-secret/);
});

test("refuses a mismatched running revision before probing or publishing", (t) => {
  const f = fixture(t);
  const result = f.invoke([], { MISMATCH: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(
    f
      .calls()
      .some(
        (c) =>
          (c[0] === "pnpm" && c.includes("exec")) ||
          c.includes("template:build") ||
          c.includes("push"),
      ),
    false,
  );
  assert.equal(existsSync(path.join(f.root, ".env.e2b.compose.json")), false);
});

test("builds independent templates and writes a private ignored idempotent override", (t) => {
  const f = fixture(t);
  const before = readFileSync(path.join(f.root, ".env"), "utf8");
  const result = f.invoke();
  assert.equal(result.status, 0, result.stderr);
  const filename = path.join(f.root, ".env.e2b.compose.json");
  const override = JSON.parse(readFileSync(filename, "utf8"));
  for (const service of ["api", "worker"]) {
    assert.equal(override.services[service].environment.SANDBOX_PROVIDER, "e2b");
    assert.equal(override.services[service].environment.E2B_API_KEY, "fake-test-secret");
  }
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  assert.equal(readFileSync(path.join(f.root, ".env"), "utf8"), before);
  assert.equal(existsSync(path.join(f.root, "should-not-exist")), false);
  assert.doesNotMatch(result.stdout + result.stderr, /fake-test-secret/);
  assert.equal(JSON.stringify(f.calls()).includes("fake-test-secret"), false);
  assert.ok(
    f.calls().some((c) => c.includes("@rakazo/agent-run-worker") && c.includes("template:build")),
  );
  assert.ok(
    f
      .calls()
      .some(
        (c) =>
          c.includes("@rakazo/computer-e2b-template") &&
          c.includes("--image") &&
          c.some((v) => v.includes("@sha256:")),
      ),
  );
  const again = f.invoke();
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(readFileSync(filename, "utf8")), override);
  const realGit = spawnSync("git", ["init", "-q", f.root], { encoding: "utf8" });
  assert.equal(realGit.status, 0, realGit.stderr);
  const ignored = spawnSync("git", ["-C", f.root, "check-ignore", ".env.e2b.compose.json"], {
    encoding: "utf8",
  });
  assert.equal(ignored.status, 0, ignored.stderr);
});

test("failed template build never changes configuration or starts services", (t) => {
  const f = fixture(t);
  const result = f.invoke([], { FAIL_BUILD: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(path.join(f.root, ".env.e2b.compose.json")), false);
  assert.equal(
    f.calls().some((c) => c.includes("up")),
    false,
  );
});

test("failed switch restores prior configuration and restarts with the original compose command", (t) => {
  const f = fixture(t);
  const result = f.invoke([], { FAIL_START: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(path.join(f.root, ".env.e2b.compose.json")), false);
  const starts = f.calls().filter((c) => c.includes("up"));
  assert.equal(starts.length, 2);
  assert.ok(starts[0].some((v) => v.endsWith(".env.e2b.compose.json")));
  assert.equal(
    starts[1].some((v) => v.endsWith(".env.e2b.compose.json")),
    false,
  );
});

test("interactive domain and secret are requested with terminal echo disabled for the key", (t) => {
  const f = fixture(t);
  const program = String.raw`
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.chdir(sys.argv[1])
    os.environ['PATH'] = os.path.join(sys.argv[1], 'bin') + os.pathsep + os.environ['PATH']
    os.environ['CALLS'] = os.path.join(sys.argv[1], 'calls')
    for key in list(os.environ):
        if key.startswith('E2B_') or key == 'WORKER_TEMPLATE': del os.environ[key]
    os.execv(sys.argv[2], [sys.argv[2], 'infra/compose/setup-e2b.mjs', '--computer-image', 'registry.example.com/computer:local'])
output = b''
domain_sent = key_sent = False
deadline = time.monotonic() + 15
try:
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.1)[0]:
            try: chunk = os.read(fd, 4096)
            except OSError: break
            if not chunk: break
            output += chunk
            if not domain_sent and b'E2B domain' in output:
                os.write(fd, b'other.example.com\n'); domain_sent = True
            if not key_sent and b'E2B API key' in output:
                os.write(fd, b'fake-interactive-secret\n'); key_sent = True
    else:
        os.kill(pid, 9)
        raise RuntimeError('Interactive setup timed out')
    _, status = os.waitpid(pid, 0)
    sys.stdout.buffer.write(output)
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    os.close(fd)
`;
  const result = spawnSync("python3", ["-c", program, f.root, process.execPath], {
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /E2B domain/);
  assert.match(result.stdout, /E2B API key/);
  assert.doesNotMatch(result.stdout + result.stderr, /fake-interactive-secret|fake-test-secret/);
  const saved = JSON.parse(readFileSync(path.join(f.root, ".env.e2b.compose.json"), "utf8"));
  assert.equal(saved.services.api.environment.E2B_API_KEY, "fake-interactive-secret");
  assert.equal(saved.services.api.environment.E2B_DOMAIN, "other.example.com");
});

const composeAvailable =
  spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
test("real Compose merges the generated override over the forced Docker provider without a daemon", {
  skip: !composeAvailable,
}, (t) => {
  const f = fixture(t);
  assert.equal(f.invoke().status, 0);
  copyFileSync(
    fileURLToPath(new URL("./docker-compose.yml", import.meta.url)),
    path.join(f.root, "infra/compose/docker-compose.yml"),
  );
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      path.join(f.root, ".env"),
      "-f",
      path.join(f.root, "infra/compose/docker-compose.yml"),
      "-f",
      path.join(f.root, ".env.e2b.compose.json"),
      "config",
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.services.api.environment.SANDBOX_PROVIDER, "e2b");
  assert.equal(config.services.worker.environment.SANDBOX_PROVIDER, "e2b");
  assert.equal(config.services.worker.environment.SCREEN_PROXY_SECRET, "");
  assert.equal(config.services.api.environment.SCREEN_PROXY_SECRET, "fake-screen");
  assert.equal(config.services.api.environment.E2B_API_KEY, "fake-test-secret");
});

test("startup failures restore application configuration", { concurrency: true }, async (t) => {
  await Promise.all([
    t.test("a stopped worker prevents success and restores the original deployment", (t) => {
      const f = fixture(t);
      const result = f.invoke([], { WORKER_STOPPED: "1" });
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(path.join(f.root, ".env.e2b.compose.json")), false);
      assert.equal(f.calls().filter((c) => c.includes("up")).length, 2);
    }),
    t.test(
      "an invalid health response restores an existing private override byte for byte",
      (t) => {
        const f = fixture(t);
        assert.equal(f.invoke().status, 0);
        const filename = path.join(f.root, ".env.e2b.compose.json");
        const previous = readFileSync(filename, "utf8");
        const result = f.invoke([], { FAIL_HEALTH: "1", E2B_API_KEY: "fake-replacement-secret" });
        assert.notEqual(result.status, 0);
        assert.equal(readFileSync(filename, "utf8"), previous);
        assert.doesNotMatch(result.stdout + result.stderr, /fake-replacement-secret/);
        assert.equal(f.calls().filter((c) => c.includes("up")).length, 3);
      },
    ),
  ]);
});
