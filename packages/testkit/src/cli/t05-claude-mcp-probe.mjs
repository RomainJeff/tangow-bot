import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import path from "node:path";

export function relayReport(raw) {
  const records = raw.trim() ? raw.trim().split("\n").map(JSON.parse) : [];
  for (const record of records) {
    assert(record.method === null || typeof record.method === "string");
    assert(["expected", "unexpected"].includes(record.bearer));
  }
  return [
    ...records.map(
      (record) =>
        `MCP_REQUEST method=${record.method ?? "none"} match=${record.bearer === "expected"}`,
    ),
    `J3D2_CLAUDE_MCP_METHODS=${[...new Set(records.flatMap((record) => (record.method ? [record.method] : [])))].join(",") || "none"}`,
    `J3D2_CLAUDE_MCP_BEARER=${records.some((record) => record.method) && records.every((record) => record.bearer === "expected") ? "yes" : "no"}`,
  ];
}

async function probe() {
  console.log(`PROBE_NODE=${process.version}`);
  assert.equal(process.versions.node.split(".")[0], "22");
  assert.equal(process.getuid(), 1000);
  const invocation = JSON.parse(await readFile("/probe/invocation.json", "utf8"));
  const configIndex = invocation.argv.indexOf("--mcp-config");
  assert(configIndex >= 0 && invocation.argv.includes("--strict-mcp-config"));
  const configPath = invocation.argv[configIndex + 1];
  const nativeHome = path.dirname(configPath);
  const configFile = invocation.files.find((file) => file.path === "mcp-config.json");
  const config = JSON.parse(configFile.content);
  const authorization = config.mcpServers.rakazo.headers.Authorization;
  assert(authorization.startsWith("Bearer "));
  assert.equal(config.mcpServers.rakazo.url, invocation.relayUrl);
  await mkdir(nativeHome, { recursive: true, mode: 0o700 });
  await mkdir("/tmp/probe/work", { recursive: true, mode: 0o700 });
  await mkdir("/tmp/probe/home", { recursive: true, mode: 0o700 });
  await writeFile(configPath, configFile.content, { mode: 0o600 });
  const promptIndex = invocation.argv.indexOf("--append-system-prompt-file");
  const promptFile = invocation.files.find((file) => file.path === "system-prompt.md");
  assert(promptIndex >= 0 && promptFile);
  assert.equal(invocation.argv[promptIndex + 1], `${nativeHome}/system-prompt.md`);
  assert(Buffer.byteLength(promptFile.content) >= 4_096);
  assert(!invocation.argv.includes("--append-system-prompt"));
  assert(!invocation.argv.some((argument) => argument.includes("Workspace task")));
  await writeFile(invocation.argv[promptIndex + 1], promptFile.content, { mode: 0o600 });
  console.log(`J3D2F_ARGV_COUNT=${invocation.argv.length}`);
  console.log(`J3D2F_PROMPT_BYTES=${Buffer.byteLength(promptFile.content)}`);
  console.log("J3D2F_PROMPT_IN_ARGV=no");
  const recordPath = "/evidence/requests.jsonl";
  await writeFile(recordPath, "", { mode: 0o600 });
  // Explicit allowlist: no inherited provider credentials, proxies or native homes.
  const env = {
    PATH: "/probe-bin:/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/probe/home",
    TMPDIR: "/tmp",
    CI: "1",
    CLAUDE_CONFIG_DIR: nativeHome,
  };
  const relay = spawn(process.execPath, ["/probe/t05-fake-mcp-relay.mjs"], {
    env: { ...env, T05_MCP_RELAY_RECORD: recordPath, T05_MCP_RELAY_BEARER: authorization.slice(7) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bridge;
  try {
    const [line] = await once(relay.stdout, "data");
    const port = Number(line.toString().trim().split("=")[1]);
    assert(Number.isInteger(port) && port > 0);
    // The existing fake relay binds loopback. Expose it only on the internal probe network.
    bridge = createServer((socket) => {
      const upstream = connect(port, "127.0.0.1");
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    bridge.listen(Number(new URL(invocation.relayUrl).port), "0.0.0.0");
    await once(bridge, "listening");
    const version = spawnSync("/usr/local/bin/claude", ["--version"], { env, encoding: "utf8" });
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), "2.1.282 (Claude Code)");
    console.log(`CLAUDE_VERSION=${version.stdout.trim()}`);
    console.log("CLAUDE_AUTH_ENV=absent");
    const help = spawnSync("/usr/local/bin/claude", ["--help"], { env, encoding: "utf8" });
    assert.equal(help.status, 0);
    for (const line of help.stdout.split("\n")) {
      if (
        line.includes("--allowedTools") ||
        line.includes("--permission-mode") ||
        line.includes("--append-system-prompt")
      ) {
        console.log(`CLAUDE_HELP=${line.trim()}`);
      }
    }
    assert(/--append-system-prompt(?:-file|\[-file\])/.test(help.stdout));
    const binary = await readFile("/usr/local/bin/claude");
    for (const name of ["Bash", "Edit", "Write", "NotebookEdit"]) {
      const index = binary.indexOf(`"${name}"`);
      assert(index >= 0, `Missing tool name in Claude 2.1.282: ${name}`);
      console.log(
        `CLAUDE_BINARY_TOOL=${name} CONTEXT=${JSON.stringify(binary.subarray(Math.max(0, index - 60), index + name.length + 62).toString("utf8"))}`,
      );
    }
    const dontAskIndex = binary.indexOf("Don't prompt for permissions, deny if not pre-approved");
    assert(dontAskIndex >= 0);
    console.log(
      `CLAUDE_BINARY_PERMISSION=${JSON.stringify(binary.subarray(Math.max(0, dontAskIndex - 40), dontAskIndex + 80).toString("utf8"))}`,
    );
    const allowedToolsIndex = invocation.argv.indexOf("--allowedTools");
    assert(allowedToolsIndex >= 0);
    assert.equal(
      invocation.argv[allowedToolsIndex + 1],
      "mcp__rakazo,Bash,Edit,Write,NotebookEdit",
    );
    console.log(`J3D2F_ALLOWED_TOOLS=${invocation.argv[allowedToolsIndex + 1]}`);
    const child = spawn("/usr/local/bin/claude", invocation.argv.slice(1), {
      env,
      cwd: "/tmp/probe/work",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.stdin.end(invocation.stdin);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 45_000);
    let exitCode;
    try {
      [exitCode] = await once(child, "close");
    } finally {
      clearTimeout(timeout);
    }

    // Read and report the evidence FIRST, even when Claude failed or timed out.
    const raw = await readFile(recordPath, "utf8");
    console.log("RELAY_RECORD_READ_BEFORE_CLEANUP=yes");
    for (const line of relayReport(raw)) console.log(line);
    console.log(`CLAUDE_EXIT=${exitCode} TIMEOUT=${timedOut}`);
    let initialized = false;
    let connected = false;
    let authenticationFailed = false;
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        console.log("CLAUDE_NON_JSON_OUTPUT=omitted");
        continue;
      }
      if (event.type === "system" && event.subtype === "init") {
        initialized = true;
        const server = event.mcp_servers?.find((server) => server.name === "rakazo");
        connected = server?.status === "connected";
        console.log(
          `CLAUDE_MCP_STATUS=${server?.status === "connected" ? "connected" : "not-connected"}`,
        );
      }
      if (event.error === "authentication_failed") {
        authenticationFailed = true;
        console.log("CLAUDE_ERROR=authentication_failed");
      }
      if (
        event.message?.content?.some((block) => block.text === "Not logged in · Please run /login")
      ) {
        console.log("CLAUDE_TEXT=Not logged in · Please run /login");
      }
    }
    console.log(`CLAUDE_STDERR_BYTES=${Buffer.byteLength(stderr)}`);
    const argvAccepted =
      initialized && authenticationFailed && exitCode === 1 && !timedOut && !stderr;
    console.log(`J3D2F_ARGV_ACCEPTED=${argvAccepted ? "yes" : "no"}`);
    console.log(`J3D2F_MCP_CONNECTED=${connected ? "yes" : "no"}`);
    console.log("J3D2F_REAL_TOOL_CALL=NOT RUN (no login)");
    assert(argvAccepted, "Claude must reach authentication without an option error");
    assert(connected, "The Rakazo MCP server must remain connected");
  } finally {
    bridge?.close();
    const closed = once(relay, "close");
    relay.kill("SIGTERM");
    await closed;
  }
}

if (process.argv.includes("--run")) await probe();
