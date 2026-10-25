import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  docker,
  dockerDesktop,
  dockerWorkersEnabled,
  freePort,
  workerSpec as spec,
  useDockerSupervisor,
} from "./docker-worker.test-support.js";

describe.skipIf(!dockerWorkersEnabled)("Docker worker isolation, from inside a worker", () => {
  const supervisor = useDockerSupervisor();
  const workers = () => supervisor.provider();
  const attempts = [`isoa${randomUUID().slice(0, 8)}`, `isob${randomUUID().slice(0, 8)}`] as const;
  let mine: string;
  let theirs: string;
  let theirsIp: string;
  let hostServer: ReturnType<typeof createServer>;
  let hostPort: number;
  let publishedPort: number;
  const marker = (name: string) => `ISOLATION_MARKER_${name}_${supervisor.token.slice(0, 8)}`;
  const extra: string[] = [];

  beforeAll(async () => {
    const deadline = new Date(Date.now() + 60_000);
    const w = workers();
    for (const name of ["rakazo-isoa", "rakazo-isob", "rakazo-isos1", "rakazo-isos2"]) {
      await w.ensureVolume({ name, ensureDeadline: deadline });
      await writeFile(path.join(w.volumePath(name), "secret.txt"), marker(name));
    }
    const a = await w.ensure(
      spec(attempts[0], [
        { volumeRef: "rakazo-isoa", path: "/workspace/bots/a", access: "rw" },
        { volumeRef: "rakazo-isos1", path: "/workspace/shared", access: "rw" },
      ]),
    );
    const b = await w.ensure(
      spec(attempts[1], [
        { volumeRef: "rakazo-isob", path: "/workspace/bots/b", access: "rw" },
        { volumeRef: "rakazo-isos2", path: "/workspace/shared", access: "ro" },
      ]),
    );
    mine = a.providerRef;
    theirs = b.providerRef;
    const image = docker("inspect", "-f", "{{.Config.Image}}", mine);
    theirsIp = docker(
      "inspect",
      "-f",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      theirs,
    );
    // Another worker listening, as a hostile run could.
    docker(
      "exec",
      "-d",
      theirs,
      "node",
      "-e",
      "require('net').createServer(s=>s.end('hi')).listen(8080,'0.0.0.0')",
    );
    // What a Compose deployment runs beside the workers: named services on their own network,
    // and a service published on the host's 127.0.0.1.
    const network = `rakazo-test-compose-${supervisor.token.slice(0, 6)}`;
    docker("network", "create", network);
    extra.push(`network:${network}`);
    for (const alias of ["postgres", "api", "supervisor"]) {
      const id = docker(
        "run",
        "-d",
        "--rm",
        "--network",
        network,
        "--network-alias",
        alias,
        "--label",
        "rakazo.test=true",
        image,
        "node",
        "-e",
        "require('net').createServer(s=>s.end('hi')).listen(8080,'0.0.0.0')",
      );
      extra.push(`container:${id}`);
    }
    publishedPort = await freePort();
    extra.push(
      `container:${docker(
        "run",
        "-d",
        "--rm",
        "--label",
        "rakazo.test=true",
        "-p",
        `127.0.0.1:${publishedPort}:8080`,
        image,
        "node",
        "-e",
        "require('net').createServer(s=>s.end('hi')).listen(8080,'0.0.0.0')",
      )}`,
    );
    hostServer = createServer((socket) => socket.end("hi"));
    await new Promise<void>((resolve) => hostServer.listen(0, "127.0.0.1", resolve));
    hostPort = (hostServer.address() as { port: number }).port;
  }, 120_000);

  afterAll(async () => {
    hostServer?.close();
    for (const attemptId of attempts) await workers().destroy({ attemptId });
    for (const item of extra.reverse()) {
      const [kind, id] = item.split(":") as [string, string];
      if (kind === "container") docker("rm", "-f", id);
      else docker("network", "rm", id);
    }
  });

  /** Runs a probe as the guest would: uid 1000 in the worker, no extra env. */
  // Async, so the supervisor client's pooled sockets see their close while a probe runs.
  const inWorker = (script: string, container = mine) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        "docker",
        ["exec", "-i", container, "node", "-"],
        { encoding: "utf8", timeout: 120_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin?.end(script);
    });

  it("cannot read another bot's or another space's volume, or host paths outside its mounts", async () => {
    const output = await inWorker(`
      const fs = require("fs"), cp = require("child_process");
      const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return e.code; } };
      const results = {};
      results.own = read("/workspace/bots/a/secret.txt");
      results.ownShared = read("/workspace/shared/secret.txt");
      for (const p of [
        "/workspace/bots/b/secret.txt",
        "/data/volumes/rakazo-isob/secret.txt",
        "/data/volumes/rakazo-isos2/secret.txt",
        "/workspace/bots/a/../../../data/volumes/rakazo-isob/secret.txt",
        "/workspace/bots/a/../rakazo-isob/secret.txt",
        "/workspace/bots/a/../../rakazo-isob/secret.txt",
        "/proc/1/root/workspace/bots/b/secret.txt",
        ${JSON.stringify(path.join(supervisor.dataDir, "volumes/rakazo-isob/secret.txt"))},
        "/var/run/docker.sock",
      ]) results[p] = read(p);
      fs.symlinkSync("../rakazo-isob/secret.txt", "/workspace/bots/a/link-rel");
      fs.symlinkSync(${JSON.stringify(path.join(supervisor.dataDir, "volumes/rakazo-isob/secret.txt"))}, "/workspace/bots/a/link-abs");
      results.linkRel = read("/workspace/bots/a/link-rel");
      results.linkAbs = read("/workspace/bots/a/link-abs");
      results.workspace = fs.readdirSync("/workspace").sort();
      results.bots = fs.readdirSync("/workspace/bots");
      results.mounts = fs.readFileSync("/proc/self/mountinfo", "utf8").split("\\n")
        .map((l) => l.split(" ")[4]).filter((m) => m && !/^\\/(proc|sys|dev)/.test(m));
      results.found = cp.spawnSync("rg", ["-uuu", "--no-messages", "-l", "-F", "ISOLATION_MARKER_rakazo-isob", "/",
        "-g", "!proc", "-g", "!sys"], { encoding: "utf8", timeout: 90000 }).stdout.trim();
      results.foundS2 = cp.spawnSync("rg", ["-uuu", "--no-messages", "-l", "-F", "ISOLATION_MARKER_rakazo-isos2", "/",
        "-g", "!proc", "-g", "!sys"], { encoding: "utf8", timeout: 90000 }).stdout.trim();
      console.log(JSON.stringify(results));
    `);
    const results = JSON.parse(output) as Record<string, unknown>;
    console.log("volume probes", JSON.stringify(results, null, 1));
    expect(results.own).toBe(marker("rakazo-isoa"));
    expect(results.ownShared).toBe(marker("rakazo-isos1"));
    for (const [key, value] of Object.entries(results)) {
      if (key.startsWith("/")) expect(value, key).toBe("ENOENT");
    }
    expect(results.linkRel).toBe("ENOENT");
    expect(results.linkAbs).toBe("ENOENT");
    expect(results.workspace).toEqual(["bots", "shared"]);
    expect(results.bots).toEqual(["a"]);
    expect(results.found).toBe("");
    expect(results.foundS2).toBe("");
    // The read-only shared mount of the other worker refuses writes.
    const write = await inWorker(
      `try { require("fs").writeFileSync("/workspace/shared/x", "x"); console.log("written") } catch (e) { console.log(e.code) }`,
      theirs,
    );
    expect(write.trim()).toBe("EROFS");
  }, 180_000);

  it("has no Docker socket, no supervisor token and no secrets", async () => {
    const output = await inWorker(`
      const fs = require("fs"), cp = require("child_process");
      const results = {};
      results.sockets = cp.spawnSync("find", ["/", "-xdev", "-type", "s"], { encoding: "utf8" }).stdout.trim();
      results.dockerHost = process.env.DOCKER_HOST ?? null;
      results.envKeys = Object.keys(process.env).sort();
      results.pid1Env = fs.readFileSync("/proc/1/environ", "utf8").split("\\0").filter(Boolean).map((e) => e.split("=")[0]).sort();
      // The pattern comes on stdin, so the search's own argv does not match it.
      results.tokenFound = cp.spawnSync("rg", ["-uuu", "--no-messages", "-l", "-F", "-f", "-", "/",
        "-g", "!sys"], { encoding: "utf8", timeout: 90000, input: ${JSON.stringify(`${supervisor.token}\n`)} }).stdout.trim();
      console.log(JSON.stringify(results));
    `);
    const results = JSON.parse(output) as Record<string, string | string[] | null>;
    console.log("secret probes", JSON.stringify(results, null, 1));
    expect(results.sockets).toBe("");
    expect(results.dockerHost).toBeNull();
    expect(results.tokenFound).toBe("");
    for (const keys of [results.envKeys, results.pid1Env] as string[][]) {
      expect(
        keys.filter((key) => /TOKEN|SECRET|KEY|PASSWORD|DATABASE|SUPERVISOR/.test(key)),
      ).toEqual([]);
    }
  }, 180_000);

  it("cannot resolve or reach the services, the host's ports or another worker", async () => {
    const output = await inWorker(`
      const net = require("net"), dns = require("dns").promises;
      const reach = (host, port) => new Promise((resolve) => {
        const socket = net.connect({ host, port, timeout: 3000 });
        socket.once("data", () => { socket.destroy(); resolve("reached"); });
        socket.once("connect", () => setTimeout(() => { socket.destroy(); resolve("connected"); }, 500));
        socket.once("timeout", () => { socket.destroy(); resolve("timeout"); });
        socket.once("error", (e) => resolve(e.code));
      });
      const resolveName = (name) => dns.lookup(name).then((r) => r.address, (e) => e.code);
      (async () => {
        const gateway = require("fs").readFileSync("/proc/net/route", "utf8").split("\\n")
          .map((l) => l.split("\\t")).find((c) => c[1] === "00000000")?.[2];
        const gw = gateway && gateway.match(/../g).reverse().map((h) => parseInt(h, 16)).join(".");
        const results = { gateway: gw };
        for (const name of ["postgres", "api", "supervisor", "host.docker.internal", "gateway.docker.internal"])
          results["dns:" + name] = await resolveName(name);
        for (const [label, host, port] of [
          ["otherWorker", ${JSON.stringify(theirsIp)}, 8080],
          ["supervisor@loopback", "127.0.0.1", ${supervisor.port}],
          ["supervisor@gateway", gw, ${supervisor.port}],
          ["supervisor@host.docker.internal", "host.docker.internal", ${supervisor.port}],
          ["hostService@gateway", gw, ${hostPort}],
          ["hostService@host.docker.internal", "host.docker.internal", ${hostPort}],
          ["published@gateway", gw, ${publishedPort}],
          ["published@host.docker.internal", "host.docker.internal", ${publishedPort}],
          ["postgres:5432@host.docker.internal", "host.docker.internal", 5432],
        ]) results[label] = await reach(host, port);
        results.egress = await fetch("https://example.com", { signal: AbortSignal.timeout(8000) })
          .then((r) => r.status, (e) => String(e.cause?.code ?? e.name));
        console.log(JSON.stringify(results));
      })();
    `);
    const results = JSON.parse(output) as Record<string, unknown>;
    console.log("network probes", JSON.stringify(results, null, 1));
    // The other worker is listening: it answers itself.
    const self = await inWorker(
      `require("net").connect(8080, "127.0.0.1").on("data", (d) => { console.log(String(d)); process.exit(0); })`,
      theirs,
    );
    expect(self.trim()).toBe("hi");
    expect(results["dns:postgres"]).toBe("ENOTFOUND");
    expect(results["dns:api"]).toBe("ENOTFOUND");
    expect(results["dns:supervisor"]).toBe("ENOTFOUND");
    expect(results.otherWorker).not.toBe("reached");
    expect(results["supervisor@loopback"]).not.toBe("reached");
    expect(results["supervisor@gateway"]).not.toBe("reached");
    expect(results["published@gateway"]).not.toBe("reached");
    // Docker Desktop routes host.docker.internal to the Mac's loopback, whatever the network.
    if (!dockerDesktop) {
      expect(results["dns:host.docker.internal"]).toBe("ENOTFOUND");
    }
  }, 120_000);

  it("runs as uid 1000 with no capabilities and no new privileges", async () => {
    const output = await inWorker(`
      const fs = require("fs"), cp = require("child_process");
      const status = Object.fromEntries(fs.readFileSync("/proc/self/status", "utf8").split("\\n")
        .map((l) => l.split(":\\t")).filter((p) => p.length === 2));
      console.log(JSON.stringify({
        uid: process.getuid(), gid: process.getgid(),
        CapInh: status.CapInh, CapPrm: status.CapPrm, CapEff: status.CapEff, CapBnd: status.CapBnd, CapAmb: status.CapAmb,
        NoNewPrivs: status.NoNewPrivs, Seccomp: status.Seccomp,
        su: cp.spawnSync("su", ["-c", "id -u"], { encoding: "utf8", input: "" }).status,
        chownRoot: (() => { try { fs.writeFileSync("/tmp/own", "x"); fs.chownSync("/tmp/own", 0, 0); return "ok"; } catch (e) { return e.code; } })(),
        chownRootOnVolume: (() => { try { fs.chownSync("/workspace/bots/a/secret.txt", 0, 0); return "ok"; } catch (e) { return e.code; } })(),
        writeEtc: (() => { try { fs.writeFileSync("/etc/x", "x"); return "ok"; } catch (e) { return e.code; } })(),
        pid1: fs.readFileSync("/proc/1/cmdline", "utf8").replaceAll("\\0", " ").trim(),
      }));
    `);
    const results = JSON.parse(output) as Record<string, unknown>;
    console.log("privilege probes", JSON.stringify(results, null, 1));
    expect(results).toMatchObject({
      uid: 1000,
      gid: 1000,
      CapInh: "0000000000000000",
      CapPrm: "0000000000000000",
      CapEff: "0000000000000000",
      CapBnd: "0000000000000000",
      CapAmb: "0000000000000000",
      NoNewPrivs: "1",
      Seccomp: "2",
      chownRoot: "EPERM",
      writeEtc: "EACCES",
    });
    expect(results.su).not.toBe(0);
    // Docker Desktop's file sharing accepts any chown; a Linux bind refuses it without CAP_CHOWN.
    if (!dockerDesktop) expect(results.chownRootOnVolume).toBe("EPERM");
  });
});
