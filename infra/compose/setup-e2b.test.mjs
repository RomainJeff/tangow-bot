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
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(
    fileURLToPath(new URL("../../scripts/tangow-deployment.mjs", import.meta.url)),
    path.join(root, "scripts/tangow-deployment.mjs"),
  );
  copyFileSync(source, path.join(root, "infra/compose/setup-e2b.mjs"));
  const upgrade = fileURLToPath(new URL("./e2b-upgrade.mjs", import.meta.url));
  if (existsSync(upgrade)) copyFileSync(upgrade, path.join(root, "infra/compose/e2b-upgrade.mjs"));
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
if (name === 'sudo') {
 if (args[0] !== '-n') process.exit(2);
 const preserve = args[1]?.startsWith('--preserve-env=') ? args[1].split('=')[1].split(',') : [];
 const index = preserve.length ? 2 : 1;
 if (args[index] !== 'docker') process.exit(2);
 const env = {...process.env};
 for (const key of Object.keys(env)) if ((key.startsWith('E2B_') || key === 'WORKER_TEMPLATE') && !preserve.includes(key)) delete env[key];
 const result = require('node:child_process').spawnSync('docker', args.slice(index+1), {stdio:'inherit', env}); process.exit(result.status ?? 1);
}
if (name === 'tar') { fs.writeFileSync(args[args.indexOf('-czf')+1], 'fake-data-backup'); process.exit(0); }
if (name === 'docker' && args.includes('scripts/setup-e2b-homes.ts')) {
 if (args.includes('--verify') && process.env.FAIL_VERIFY) process.exit(1);
 if (args.includes('--verify') && process.env.EXPECT_TEMPLATE && (args.includes('WORKER_TEMPLATE') ? process.env.WORKER_TEMPLATE : 'rakazo-worker-pi-native') !== process.env.EXPECT_TEMPLATE) process.exit(1);
 const computers=process.env.UPGRADE_EXISTING && !fs.existsSync('.upgraded') ? [{id:'computer-old',spaceId:'space-old',scope:'team',homeStorage:process.env.DOCKER_VOLUMES?'volumes':'snapshot'}] : [];
 console.log(JSON.stringify(args.includes('--prepare') ? {prepared:'computer-old'} : {computers,previews:process.env.UNMAPPED && args.includes('--plans') ? [{computerId:'computer-old',notCopied:[{homePath:'legacy.txt',kind:'unmapped'}]}] : [],blockers:{runs:process.env.BUSY_RUNS?1:0,controls:0,leases:0,maintenance:0,unsupported:0}})); process.exit(0);
}
if (name === 'docker' && args.includes('scripts/migrate-home-to-volumes.ts')) {
 if (process.env.FAIL_MIGRATION && !args.includes('--dry-run')) process.exit(1);
 if (!args.includes('--dry-run')) fs.writeFileSync('.upgraded','yes');
 console.log(JSON.stringify({outcome:args.includes('--dry-run')?'planned':'adopted'})); process.exit(0);
}
if (name === 'docker' && args.includes('scripts/carry-docker-volumes-to-e2b.ts')) { fs.writeFileSync('.upgraded','yes'); console.log(JSON.stringify({outcome:'carried',volumes:[]})); process.exit(0); }
if (name === 'docker' && args.includes('scripts/migrate-skills-to-volumes.ts')) { console.log(JSON.stringify({events:[]})); process.exit(0); }
if (name === 'docker' && args.includes('postgres')) { console.log('fake-database-backup'); process.exit(0); }
if (name === 'git') {
 if (args.includes('rev-parse')) console.log('${sha}');
} else if (name === 'docker') {
 if (args.includes('config') && args.includes('--format')) { console.log(JSON.stringify({services:{api:{environment:{AGENT_RUNTIME:process.env.SCRIPTED?'scripted':'worker'}},worker:{environment:{AGENT_RUNTIME:process.env.SCRIPTED?'scripted':'worker'}}}})); process.exit(0); }
 if (args.includes('@rakazo/adapters') && process.env.STOPPED_SERVICES && !args.includes('run')) process.exit(1);
 if (args[0] === 'compose' && args.includes('ps')) console.log('container-id');
 if (args[0] === 'inspect' && args.some(a=>a.includes('.State.ExitCode'))) { console.log('exited '+(process.env.MIGRATION_FAILED?'1':'0')+' sha256:app'); process.exit(0); }
 if (args[0] === 'inspect') console.log(args.includes('{{.State.Running}}') ? (process.env.WORKER_STOPPED ? 'false' : 'true') : (process.env.MISMATCH || process.env.OLD_RUNTIME) ? 'b'.repeat(40) : '${sha}');
 if (args[0] === 'image') console.log(args.includes('{{.Id}}') ? 'sha256:app' : args.some(a=>a.includes('Config.Env')) ? (process.env.MISMATCH ? 'b'.repeat(40) : '${sha}') : 'registry.example.com/computer@sha256:'+'c'.repeat(64));
 if (args.includes('up') && process.env.FAIL_START && fs.existsSync('.env.e2b.compose.json')) process.exit(1);
 if (args.includes('logs')) console.log('worker ready');
 if (args.includes('@rakazo/adapters') && (process.env.FAIL_CONTAINER_CONNECT || !process.env.E2B_API_KEY)) process.exit(1);
 if (args.includes('exec') && !args.includes('ps') && !args.includes('@rakazo/adapters')) {
   global.fetch = async () => ({ ok: true, json: async () => ({ok:true,sandbox:process.env.FAIL_HEALTH?'docker':'e2b',revision:'${sha}'}) });
   eval('(async () => {' + args.at(-1) + '})()').catch(() => process.exit(1));
 }
} else if (name === 'pnpm' && process.env.FAIL_BUILD && args.includes('template:build')) process.exit(1);
`;
  for (const name of ["git", "docker", "pnpm", "tar", "sudo"])
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

test("refuses a built image that does not match the checkout before probing or publishing", (t) => {
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

test("failed switch retains E2B configuration and stops services without rollback", (t) => {
  const f = fixture(t);
  const result = f.invoke([], { FAIL_START: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(path.join(f.root, ".env.e2b.compose.json")), true);
  const starts = f.calls().filter((c) => c.includes("up"));
  assert.equal(starts.length, 1);
  assert.ok(starts[0].some((v) => v.endsWith(".env.e2b.compose.json")));
  assert.ok(f.calls().some((c) => c.includes("stop")));
  assert.match(result.stderr, /No rollback was attempted/);
  const resumed = f.invoke([], { STOPPED_SERVICES: "1" });
  assert.equal(resumed.status, 0, resumed.stderr);
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

test("startup failures retain E2B configuration for forward recovery", {
  concurrency: true,
}, async (t) => {
  await Promise.all([
    t.test("a stopped worker prevents success and leaves services stopped", (t) => {
      const f = fixture(t);
      const result = f.invoke([], { WORKER_STOPPED: "1" });
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(path.join(f.root, ".env.e2b.compose.json")), true);
      assert.equal(f.calls().filter((c) => c.includes("up")).length, 1);
    }),
    t.test("an invalid health response retains the new private configuration", (t) => {
      const f = fixture(t);
      assert.equal(f.invoke().status, 0);
      const filename = path.join(f.root, ".env.e2b.compose.json");
      const result = f.invoke([], { FAIL_HEALTH: "1", E2B_API_KEY: "fake-replacement-secret" });
      assert.notEqual(result.status, 0);
      assert.equal(
        JSON.parse(readFileSync(filename, "utf8")).services.api.environment.E2B_API_KEY,
        "fake-replacement-secret",
      );
      assert.doesNotMatch(result.stdout + result.stderr, /fake-replacement-secret/);
      assert.equal(f.calls().filter((c) => c.includes("up")).length, 2);
    }),
  ]);
});

test("unreachable E2B from the application containers refuses before template publication", (t) => {
  const f = fixture(t);
  const result = f.invoke([], { FAIL_CONTAINER_CONNECT: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(
    f.calls().some((c) => c.includes("template:build") || c.includes("push") || c.includes("up")),
    false,
  );
  assert.equal(existsSync(path.join(f.root, ".env.e2b.compose.json")), false);
});

test("existing homes are upgraded before services restart and no snapshots remain", (t) => {
  const f = fixture(t);
  const result = f.invoke(["--migrate-existing"], { UPGRADE_EXISTING: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(f.root, ".upgraded")), true);
  const calls = f.calls();
  const migrate = calls.findIndex(
    (c) => c.includes("scripts/migrate-home-to-volumes.ts") && !c.includes("--dry-run"),
  );
  const start = calls.findIndex((c) => c.includes("up"));
  assert.ok(migrate >= 0 && start > migrate);
  const verify = calls.findIndex(
    (c) => c.includes("scripts/setup-e2b-homes.ts") && c.includes("--verify"),
  );
  assert.ok(verify > migrate && verify < start);
  assert.equal(existsSync(path.join(f.root, ".env.e2b.upgrade.json")), false);
});

test("a Docker computer on volumes is carried to E2B instead of migrated, before services restart", (t) => {
  const f = fixture(t);
  const result = f.invoke(["--migrate-existing"], { UPGRADE_EXISTING: "1", DOCKER_VOLUMES: "1" });
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  const carry = calls.findIndex((c) => c.includes("scripts/carry-docker-volumes-to-e2b.ts"));
  const start = calls.findIndex((c) => c.includes("up"));
  assert.ok(carry >= 0 && start > carry);
  assert.equal(
    calls.some((c) => c.includes("scripts/migrate-home-to-volumes.ts")),
    false,
  );
});

test("active generations refuse the upgrade before any build or service change", (t) => {
  const f = fixture(t);
  const result = f.invoke(["--migrate-existing"], { UPGRADE_EXISTING: "1", BUSY_RUNS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Active generations/);
  assert.equal(
    f.calls().some((c) => c.includes("template:build") || c.includes("stop") || c.includes("up")),
    false,
  );
});

test("partial migration stays in maintenance and resumes without another database backup", (t) => {
  const f = fixture(t);
  const first = f.invoke(["--migrate-existing"], { UPGRADE_EXISTING: "1", FAIL_MIGRATION: "1" });
  assert.notEqual(first.status, 0);
  assert.equal(existsSync(path.join(f.root, ".env.e2b.upgrade.json")), true);
  assert.equal(
    f.calls().some((c) => c.includes("up")),
    false,
  );
  const again = f.invoke([], { UPGRADE_EXISTING: "1" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(existsSync(path.join(f.root, ".upgraded")), true);
  assert.equal(f.calls().filter((c) => c.some((v) => v.includes("pg_dump"))).length, 1);
  assert.equal(existsSync(path.join(f.root, ".env.e2b.upgrade.json")), false);
});

test("setup warns about retained entries and scopes the migration without another prompt", (t) => {
  const f = fixture(t);
  const result = f.invoke(["--migrate-existing"], { UPGRADE_EXISTING: "1", UNMAPPED: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Only bots\/ and shared\//);
  const moves = f.calls().filter((c) => c.includes("scripts/migrate-home-to-volumes.ts"));
  assert.equal(moves.length, 2);
  for (const command of moves) {
    assert.ok(command.includes("--workspace-only"));
    assert.ok(command.includes("--leave-unmapped"));
  }
  assert.equal(existsSync(path.join(f.root, ".env.e2b.upgrade.json")), false);
});

test("worker probe failure keeps an upgraded deployment in maintenance", (t) => {
  const f = fixture(t);
  const result = f.invoke(["--migrate-existing"], { UPGRADE_EXISTING: "1", FAIL_VERIFY: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(path.join(f.root, ".upgraded")), true);
  assert.equal(existsSync(path.join(f.root, ".env.e2b.upgrade.json")), true);
  assert.equal(f.calls().at(-1).includes("stop"), true);
});

test("a concurrent installer refuses before commands run and a stale lock can be retried", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, ".env.e2b.setup.lock"), String(process.pid));
  const blocked = f.invoke();
  assert.notEqual(blocked.status, 0);
  assert.deepEqual(f.calls(), []);
  writeFileSync(path.join(f.root, ".env.e2b.setup.lock"), "2147483646");
  const retried = f.invoke();
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(existsSync(path.join(f.root, ".env.e2b.setup.lock")), false);
});

test("the final probe uses a custom worker template selected by the operator", (t) => {
  const f = fixture(t);
  const result = f.invoke([], {
    WORKER_TEMPLATE: "custom-pi-worker",
    EXPECT_TEMPLATE: "custom-pi-worker",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("sudo covers migration inventory and database backup and restore verification", (t) => {
  const f = fixture(t);
  const result = f.invoke(["--sudo", "--migrate-existing"], { UPGRADE_EXISTING: "1" });
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  const privileged = calls.filter((c) => c[0] === "sudo");
  assert.equal(privileged.length, calls.filter((c) => c[0] === "docker").length);
  assert.ok(
    privileged.every(
      (c) => c[1] === "-n" && c[2].startsWith("--preserve-env=E2B_API_KEY,") && c[3] === "docker",
    ),
  );
  assert.ok(privileged.some((c) => c.includes("scripts/setup-e2b-homes.ts")));
  assert.ok(privileged.some((c) => c.some((arg) => arg.includes("pg_dump"))));
  assert.ok(privileged.some((c) => c.includes("pg_restore")));
  assert.doesNotMatch(result.stdout + result.stderr, /fake-test-secret/);
});

test("provider setup rejects a scripted runtime before building or switching services", (t) => {
  const f = fixture(t);
  const result = f.invoke([], { SCRIPTED: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /scripted is reserved for tests/);
  assert.ok(f.calls().every((c) => !c.includes("template:build") && !c.includes("up")));
  assert.equal(existsSync(path.join(f.root, ".env.e2b.compose.json")), false);
});

test("snapshot preflight recovery uses the verified new image while the old API is still deployed", (t) => {
  const f = fixture(t);
  const unprepared = f.invoke(["--migrate-existing"], { OLD_RUNTIME: "1", UPGRADE_EXISTING: "1" });
  assert.notEqual(unprepared.status, 0);
  assert.match(unprepared.stderr, /prepare revision and migrations/);
  const envPath = path.join(f.root, ".env");
  writeFileSync(envPath, `${readFileSync(envPath, "utf8")}GIT_SHA=${sha}\n`);
  const failedMigration = f.invoke(["--migrate-existing"], {
    OLD_RUNTIME: "1",
    MIGRATION_FAILED: "1",
    UPGRADE_EXISTING: "1",
  });
  assert.notEqual(failedMigration.status, 0);
  assert.match(failedMigration.stderr, /migrate did not complete successfully/);
  assert.ok(f.calls().every((c) => !c.includes("template:build") && !c.includes("up")));
  const result = f.invoke(["--migrate-existing"], { OLD_RUNTIME: "1", UPGRADE_EXISTING: "1" });
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  const stopped = calls.findIndex((c) => c.includes("stop") && c.includes("api"));
  const build = calls.findIndex((c) => c.includes("template:build"));
  assert.ok(stopped >= 0 && build > stopped);
  assert.ok(calls.some((c) => c.includes("scripts/migrate-home-to-volumes.ts")));
});
