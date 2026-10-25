import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

const source = fileURLToPath(new URL("./tangow.mjs", import.meta.url));
function fixture(t, { e2b = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "tangow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "checkout ' with spaces");
  const bin = path.join(directory, "bin");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "infra/compose"), { recursive: true });
  mkdirSync(bin);
  copyFileSync(source, path.join(root, "scripts/tangow.mjs"));
  copyFileSync(
    fileURLToPath(new URL("./tangow-options.mjs", import.meta.url)),
    path.join(root, "scripts/tangow-options.mjs"),
  );
  for (const name of ["tangow-builds.mjs", "tangow-deployment.mjs"])
    copyFileSync(
      fileURLToPath(new URL(`./${name}`, import.meta.url)),
      path.join(root, "scripts", name),
    );
  writeFileSync(path.join(root, "infra/compose/docker-compose.yml"), "services: {}\n");
  writeFileSync(
    path.join(root, "infra/compose/setup-e2b.mjs"),
    `import {writeFileSync} from 'node:fs';writeFileSync('setup-args.json',JSON.stringify(process.argv.slice(2)));`,
  );
  writeFileSync(path.join(root, ".gitignore"), ".env*\n");
  writeFileSync(
    path.join(root, ".env"),
    'SECRET=fake-test-secret\nAGENT_RUNTIME=pi\nGIT_SHA=old\nUNRELATED="$(touch must-not-exist)"\n',
  );
  if (e2b) {
    const environment = {
      SANDBOX_PROVIDER: "e2b",
      E2B_API_KEY: "fake-test-secret",
      E2B_DOMAIN: "e2b.example.com",
      WORKER_TEMPLATE: "custom-worker",
    };
    writeFileSync(
      path.join(root, ".env.e2b.compose.json"),
      JSON.stringify({ services: { api: { environment }, worker: { environment } } }),
    );
  }
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  git("add", ".");
  git("commit", "-m", "initial");
  const before = git("rev-parse", "HEAD");
  const remote = path.join(directory, "remote.git");
  git("init", "--bare", remote);
  git("remote", "add", "origin", remote);
  writeFileSync(path.join(root, "version"), "updated");
  git("add", "version");
  git("commit", "-m", "new revision");
  const target = git("rev-parse", "HEAD");
  git("push", "origin", "main");
  git("reset", "--hard", before);
  const calls = path.join(directory, "calls");
  const fake = `#!${process.execPath}
const fs=require('node:fs');
const name=require('node:path').basename(process.argv[1]);let args=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,JSON.stringify([name,...args])+'\\n');
if(name==='sudo'){
 if(args[1]==='cat'){const mode=fs.statSync(args[2]).mode;fs.chmodSync(args[2],0o600);try{process.stdout.write(fs.readFileSync(args[2]));}finally{fs.chmodSync(args[2],mode);}process.exit(0);}
 if(args[0]!=='-n'||args[1]!=='docker')process.exit(2);args=args.slice(2);
}
if(name==='pnpm'){if(args.includes('template:build')&&process.env.E2B_API_KEY!=='fake-test-secret')process.exit(1);process.exit(0);}
if(args.includes('build')&&process.env.FAIL_BUILD){console.error('fake-test-secret');process.exit(1);}
if(args.includes('config')){console.log(JSON.stringify({services:{api:{environment:{SANDBOX_PROVIDER:process.env.PROVIDER,SANDBOX_SUPERVISOR_TOKEN:process.env.NO_TOKEN?'':'fake-token',E2B_API_KEY:process.env.NO_KEY?'':'fake-test-secret',AGENT_RUNTIME:process.env.SCRIPTED?'scripted':undefined}},worker:{environment:{SANDBOX_PROVIDER:process.env.PROVIDER,SANDBOX_SUPERVISOR_TOKEN:process.env.NO_TOKEN?'':'fake-token',E2B_API_KEY:process.env.NO_KEY?'':'fake-test-secret'}}}}));process.exit(0);}
if(args.includes('wait')&&process.env.FAIL_MIGRATE)process.exit(1);
if(args.includes('scripts/setup-e2b-homes.ts')){console.log(JSON.stringify({computers:process.env.E2B_SNAPSHOTS?[{id:'computer-old',kind:'e2b',homeStorage:'snapshot'}]:[]}));process.exit(0);}
if(args.includes('scripts/migrate-docker-homes.ts')){console.log(JSON.stringify({deferred:process.env.DEFERRED?[{id:'computer-busy',state:'running',bots:[{name:'Fixture bot'}],reason:'snapshot'}]:[]}));process.exit(0);}
if(args.includes('exec')&&args.includes('api'))console.log(JSON.stringify({ok:true,revision:process.env.TARGET,sandbox:process.env.PROVIDER}));
else if(args.includes('ps')&&args.includes('-q'))console.log(args.at(-1)+'-container');
else if(args.includes('ps'))console.log('api running\\nworker running\\nweb running');
else if(args.includes('{{json .RepoDigests}}'))console.log(JSON.stringify(process.env.NO_DIGEST?[]:['registry.example.com/computer@sha256:'+'c'.repeat(64)]));
else if(args[0]==='image'&&args.some(a=>a.includes('org.opencontainers.image.revision')))console.log(process.env.BAD_WORKER_REVISION?'old':process.env.TARGET);
else if(args[0]==='image'&&args.includes('inspect'))console.log(args.includes('{{.Id}}')?(args.at(-1).includes('supervisor')?'sha256:supervisor':args.at(-1).includes('/worker:')?'sha256:guest':'sha256:app'):'registry.example.com/computer@sha256:'+'c'.repeat(64));
else if(args[0]==='inspect'&&args.some(a=>a.includes('.State.ExitCode')))console.log('exited 0 '+(args.at(-1)==='worker-image-container'?'sha256:guest':process.env.BAD_MIGRATE_IMAGE?'sha256:old':'sha256:app'));
else if(args[0]==='inspect')console.log(args.includes('{{.Image}}')?'sha256:app':args.some(a=>a.includes('Config.Env'))?process.env.TARGET:args.at(-1)==='supervisor-container'?'sha256:supervisor true 0':'sha256:app true 0');
`;
  for (const name of ["docker", "sudo", "pnpm"])
    writeFileSync(path.join(bin, name), fake, { mode: 0o755 });
  const invoke = (args, env = {}) =>
    spawnSync(process.execPath, [source, "--path", root, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        CALLS: calls,
        TARGET: target,
        PROVIDER: e2b ? "e2b" : "docker",
        ...env,
      },
    });
  return {
    root,
    before,
    target,
    git,
    invoke,
    calls: () =>
      existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse) : [],
  };
}

test("help, dry-run and invalid command options execute nothing and change nothing", (t) => {
  const f = fixture(t);
  const env = readFileSync(path.join(f.root, ".env"), "utf8");
  for (const args of [["--help"], ["update", "--dry-run"], ["cleanup", "--dry-run"]])
    assert.equal(f.invoke(args).status, 0);
  for (const args of [
    ["update", "--yes"],
    ["logs", "postgres"],
    ["provider", "unknown"],
    ["update", "--computers"],
    ["--host=-oProxyCommand=bad", "update"],
    ["update", "--unknown=fake-test-secret"],
  ]) {
    const result = f.invoke(args);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /fake-test-secret/);
  }
  assert.deepEqual(f.calls(), []);
  assert.equal(readFileSync(path.join(f.root, ".env"), "utf8"), env);
  assert.equal(f.git("rev-parse", "HEAD"), f.before);
  assert.equal(existsSync(path.join(f.root, ".env.tangow.lock")), false);
});

test("update automatically builds E2B templates, preserves its override and verifies deployment", (t) => {
  const f = fixture(t, { e2b: true });
  f.git("switch", "-c", "old-deployment");
  const override = readFileSync(path.join(f.root, ".env.e2b.compose.json"), "utf8");
  const result = f.invoke(["update", "--sudo"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Ready: ${f.target} \\(e2b\\)`));
  assert.match(result.stdout, /Updated application and E2B templates/);
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(f.git("rev-parse", "HEAD"), f.target);
  assert.equal(readFileSync(path.join(f.root, ".env.e2b.compose.json"), "utf8"), override);
  assert.match(readFileSync(path.join(f.root, ".env"), "utf8"), new RegExp(`GIT_SHA=${f.target}`));
  assert.doesNotMatch(readFileSync(path.join(f.root, ".env"), "utf8"), /^AGENT_RUNTIME=/m);
  assert.equal(statSync(path.join(f.root, ".env")).mode & 0o777, 0o600);
  assert.equal(existsSync(path.join(f.root, "must-not-exist")), false);
  const calls = f.calls();
  assert.ok(calls.some((c) => c.includes(`GIT_SHA=${f.target}`)));
  assert.ok(calls.some((c) => c.includes("custom-worker")));
  assert.ok(
    calls.some((c) => c.includes(`registry.example.com/computer@sha256:${"c".repeat(64)}`)),
  );
  assert.ok(calls.some((c) => c.includes("{{.Image}} {{.State.Running}} {{.RestartCount}}")));
  assert.ok(calls.some((c) => c.includes("web") && c.includes("exec")));
  assert.ok(
    calls.filter((c) => c.includes("compose")).every((c) => c.includes(".env.e2b.compose.json")),
  );
  assert.ok(
    calls
      .filter((c) => c[0] !== "pnpm")
      .every((c) => c[0] === "sudo" && c[1] === "-n" && c[2] === "docker"),
  );
  assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(calls), /fake-test-secret/);
  assert.equal(existsSync(path.join(f.root, ".env.tangow.lock")), false);
});

test("dirty or divergent checkouts are refused without rebuilding or rewriting history", (t) => {
  for (const kind of ["dirty", "divergent"]) {
    const f = fixture(t);
    writeFileSync(path.join(f.root, "local-file"), "keep me");
    if (kind === "divergent") {
      f.git("add", "local-file");
      f.git("commit", "-m", "local change");
    }
    const original = f.git("rev-parse", "HEAD");
    const result = f.invoke(["update"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, kind === "dirty" ? /local changes/ : /outside origin\/main/);
    assert.equal(f.git("rev-parse", "HEAD"), original);
    assert.ok(
      f.calls().every((c) => !c.includes("build") && !c.includes("up") && !c.includes("restart")),
    );
    assert.equal(readFileSync(path.join(f.root, "local-file"), "utf8"), "keep me");
  }
});

test("build failures leave running services and environment untouched and hide tool secrets", (t) => {
  const f = fixture(t);
  const before = readFileSync(path.join(f.root, ".env"), "utf8");
  const result = f.invoke(["update"], { FAIL_BUILD: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /have not been restarted/);
  assert.doesNotMatch(result.stdout + result.stderr, /fake-test-secret/);
  assert.equal(readFileSync(path.join(f.root, ".env"), "utf8"), before);
  assert.ok(f.calls().every((c) => !c.includes("up") && !c.includes("restart")));
  assert.equal(existsSync(path.join(f.root, ".env.tangow.lock")), false);
});

test("incomplete migration and concurrent operations block mutations", (t) => {
  for (const lock of [".env.e2b.upgrade.json", ".env.e2b.setup.lock", ".env.tangow.lock"]) {
    const f = fixture(t);
    writeFileSync(path.join(f.root, lock), "{}");
    const result = f.invoke(["restart"]);
    assert.notEqual(result.status, 0);
    assert.deepEqual(f.calls(), []);
    assert.equal(readFileSync(path.join(f.root, lock), "utf8"), "{}");
  }
});

test("cleanup requires consent and only prunes unused cache and images", (t) => {
  const f = fixture(t);
  assert.notEqual(f.invoke(["cleanup"]).status, 0);
  assert.deepEqual(f.calls(), []);
  const result = f.invoke(["cleanup", "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [
    ["docker", "builder", "prune", "--all", "--force"],
    ["docker", "image", "prune", "--all", "--force"],
  ]);
});

test("provider setup forwards sudo and migration consent without reversing E2B homes", (t) => {
  const f = fixture(t, { e2b: true });
  assert.notEqual(f.invoke(["provider", "docker"]).status, 0);
  writeFileSync(path.join(f.root, ".env.e2b.upgrade.json"), "{}");
  const result = f.invoke([
    "provider",
    "e2b",
    "--sudo",
    "--migrate-existing",
    "--computer-image",
    "registry.example.com/computer:local",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.root, "setup-args.json"), "utf8")), [
    "--computer-image",
    "registry.example.com/computer:local",
    "--sudo",
    "--migrate-existing",
  ]);
});

test("sudo reads a root-private override without exposing credentials", {
  skip:
    process.getuid?.() === 0
      ? "Root bypasses file permission checks; exercise this case as an unprivileged user."
      : false,
}, (t) => {
  const f = fixture(t, { e2b: true });
  const filename = path.join(f.root, ".env.e2b.compose.json");
  chmodSync(filename, 0);
  assert.notEqual(f.invoke(["status"]).status, 0);
  const result = f.invoke(["status", "--sudo"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Configured provider: e2b/);
  assert.doesNotMatch(
    result.stdout + result.stderr + JSON.stringify(f.calls()),
    /fake-test-secret/,
  );
});

test("standalone template builds require a clean revision matching API and worker", (t) => {
  const f = fixture(t, { e2b: true });
  const args = ["computers", "build", "--computer-image", "registry.example.com/computer:local"];
  const mismatch = f.invoke(args);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /must match the running API and worker/);
  assert.ok(f.calls().every((c) => !c.includes("push") && !c.includes("build")));
  f.git("merge", "--ff-only", "origin/main");
  const result = f.invoke(args);
  assert.equal(result.status, 0, result.stderr);
});

test("Docker updates deploy the supervisor too and restart preserves running images", (t) => {
  const f = fixture(t);
  const update = f.invoke(["update"]);
  assert.equal(update.status, 0, update.stderr);
  assert.ok(f.calls().some((c) => c.includes("build") && c.includes("supervisor")));
  assert.ok(f.calls().some((c) => c.includes("up") && c.includes("supervisor")));
  assert.ok(f.calls().some((c) => c.includes("supervisor-container")));
  const restart = f.invoke(["restart"]);
  assert.equal(restart.status, 0, restart.stderr);
});

test("private deployment defaults choose sudo and registry while explicit flags override the image", (t) => {
  for (const explicit of [false, true]) {
    const f = fixture(t, { e2b: true });
    writeFileSync(
      path.join(f.root, ".env.tangow.json"),
      JSON.stringify({ sudo: true, computerImage: "saved.example.com/computer:release" }),
    );
    const result = f.invoke([
      "update",
      ...(explicit ? ["--computer-image", "override.example.com/computer:release"] : []),
    ]);
    assert.equal(result.status, 0, result.stderr);
    const expected = explicit
      ? "override.example.com/computer:release"
      : "saved.example.com/computer:release";
    assert.ok(f.calls().some((c) => c[0] === "sudo" && c.includes("push") && c.includes(expected)));
  }
});

test("missing registry configuration and invalid private config fail before updating Git or services", (t) => {
  const f = fixture(t, { e2b: true });
  const result = f.invoke(["update"], { NO_DIGEST: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Set computerImage in .env.tangow.json/);
  assert.equal(f.git("rev-parse", "HEAD"), f.before);
  assert.ok(f.calls().every((c) => !c.includes("build") && !c.includes("up")));
  writeFileSync(
    path.join(f.root, ".env.tangow.json"),
    JSON.stringify({ sudo: "fake-test-secret" }),
  );
  const invalid = f.invoke(["update"]);
  assert.notEqual(invalid.status, 0);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /fake-test-secret/);
});

test("Docker update builds worker guest at the application revision and verifies migration before service start", (t) => {
  const f = fixture(t);
  const result = f.invoke(["update"]);
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  const build = calls.find((c) => c.includes("build") && c.includes("api"));
  assert.ok(build.includes("worker-image"));
  assert.ok(build.includes(`GIT_SHA=${f.target}`));
  const wait = calls.findIndex((c) => c.includes("wait") && c.includes("migrate"));
  const start = calls.findIndex((c) => c.includes("up") && c.includes("api"));
  assert.ok(wait >= 0 && start > wait);
});

test("failed migration or mismatched guest image prevents restarting application services", (t) => {
  for (const env of [
    { FAIL_MIGRATE: "1" },
    { BAD_MIGRATE_IMAGE: "1" },
    { BAD_WORKER_REVISION: "1" },
  ]) {
    const f = fixture(t);
    const result = f.invoke(["update"], env);
    assert.notEqual(result.status, 0);
    assert.ok(
      f.calls().every((c) => !c.includes("restart") && !(c.includes("up") && c.includes("api"))),
    );
  }
});

test("E2B snapshot homes refuse update and restart before any application start", (t) => {
  for (const command of ["update", "restart"]) {
    const f = fixture(t, { e2b: true });
    const result = f.invoke([command], { E2B_SNAPSHOTS: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /provider e2b/);
    assert.ok(
      f.calls().every((c) => !c.includes("restart") && !(c.includes("up") && c.includes("api"))),
    );
  }
});

test("successful startup reports deferred Docker homes with bot context", (t) => {
  const f = fixture(t);
  const result = f.invoke(["update"], { DEFERRED: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deferred.*Fixture bot/);
});

test("invalid production provider credentials and scripted runtime refuse updates before builds", (t) => {
  for (const [e2b, env] of [
    [false, { NO_TOKEN: "1" }],
    [true, { NO_KEY: "1" }],
    [false, { SCRIPTED: "1" }],
  ]) {
    const f = fixture(t, { e2b });
    const result = f.invoke(["update"], env);
    assert.notEqual(result.status, 0);
    assert.ok(f.calls().every((c) => !c.includes("build") && !c.includes("up")));
    assert.doesNotMatch(result.stdout + result.stderr, /fake-test-secret/);
  }
});
