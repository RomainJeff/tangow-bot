import { Duplex, PassThrough, Readable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ exec: vi.fn(), inspect: vi.fn() }));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));

import { supervisorApp } from "./index.js";

const identityHeaders = {
  authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
  "content-type": "application/json",
  "x-rakazo-bot-id": "bot",
  "x-rakazo-space-id": "space",
};
const stableNativeHome =
  "/tmp/rakazo-codex-bot-0000000000000000000000000000000000000000000000000000000000000000";
const stableClaudeHome =
  "/tmp/rakazo-claude-bot-0000000000000000000000000000000000000000000000000000000000000000";

let nativeStream: Duplex;
let nativeExitCode: number | null;
let nativeExitRecorded: boolean;
let ignoreTerm: boolean;
let endOnKill: boolean;
let privateFileContents: string[];
let nativeWrapper: string | undefined;
let simulateStdinChild: boolean;
let nativeGroupAlive: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  nativeStream = new PassThrough();
  nativeExitCode = null;
  nativeExitRecorded = true;
  ignoreTerm = false;
  endOnKill = false;
  privateFileContents = [];
  nativeWrapper = undefined;
  simulateStdinChild = false;
  nativeGroupAlive = false;
  mock.inspect.mockReset();
  mock.exec.mockReset();
  mock.inspect.mockResolvedValue({
    Config: {
      Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
    },
  });
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => {
    const command = options.Cmd.join(" ");
    if (command.includes('cat > "$2"')) {
      const writer = new PassThrough();
      writer.on("data", (chunk: Buffer) => privateFileContents.push(chunk.toString("utf8")));
      writer.resume();
      return {
        start: async () => writer,
        inspect: async () => ({ ExitCode: 0 }),
      };
    }
    if (options.Cmd[0] === "setsid") {
      nativeWrapper = options.Cmd[4];
      if (simulateStdinChild) {
        nativeStream = new Duplex({
          read() {},
          write(chunk, _encoding, callback) {
            if (
              chunk.toString("utf8") === "ping\n" &&
              nativeWrapper?.includes('"$@" <&3 3<&- & child=$!')
            )
              this.push(dockerFrame(1, "got:ping\n"));
            callback();
          },
        });
      }
      return {
        start: async () => nativeStream,
        inspect: async () => ({ ExitCode: nativeExitCode }),
      };
    }
    if (command.includes('test -f "$1"') && nativeExitCode !== null && nativeExitRecorded) {
      return {
        start: async () => Readable.from([dockerFrame(1, String(nativeExitCode))]),
        inspect: async () => ({ ExitCode: 0 }),
      };
    }
    if (command.includes("kill -0 -$(cat")) {
      return {
        start: async () => Readable.from([dockerFrame(1, nativeGroupAlive ? "present" : "empty")]),
        inspect: async () => ({ ExitCode: 0 }),
      };
    }
    if (command.includes("kill -TERM") && nativeExitCode !== null && !ignoreTerm)
      nativeStream.end();
    if (command.includes("kill -KILL") && endOnKill) nativeStream.end();
    return {
      start: async () => Readable.from([]),
      inspect: async () => ({ ExitCode: 0 }),
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function startNativeProcess() {
  const response = await supervisorApp.request("/computers/computer/native-processes", {
    method: "POST",
    headers: identityHeaders,
    body: JSON.stringify({
      argv: ["codex", "app-server"],
      cwd: "project",
      privateHome: stableNativeHome,
      env: { CODEX_HOME: stableNativeHome },
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

function deleteNativeProcess(sessionId: string) {
  return supervisorApp.request(`/computers/computer/native-processes/${sessionId}`, {
    method: "DELETE",
    headers: identityHeaders,
  });
}

function reconfirmNativeProcess(sessionId: string, computerId = "computer") {
  return supervisorApp.request(`/computers/${computerId}/native-processes/${sessionId}/reconfirm`, {
    method: "POST",
    headers: identityHeaders,
  });
}

function dockerFrame(stream: 1 | 2, text: string) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("native process stop and private-home cleanup", () => {
  it.each([
    { label: "just below 1 MiB", char: "x", count: 1024 * 1024 - 1, status: 200 },
    { label: "exactly 1 MiB", char: "x", count: 1024 * 1024, status: 200 },
    { label: "one byte above 1 MiB", char: "x", count: 1024 * 1024 + 1, status: 400 },
    { label: "UTF-8 at 1 MiB", char: "é", count: 512 * 1024, status: 200 },
    { label: "UTF-8 above 1 MiB", char: "é", count: 512 * 1024 + 1, status: 400 },
    { label: "JSON-escaped data at 1 MiB", char: "\u0000", count: 1024 * 1024, status: 200 },
  ])("bounds decoded native writes: $label", async ({ char, count, status }) => {
    // stdin is not echoed into Docker's multiplexed stdout.
    nativeStream = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const id = await startNativeProcess();
    const write = vi.spyOn(nativeStream, "write");
    try {
      const data = char.repeat(count);
      const response = await supervisorApp.request(
        `/computers/computer/native-processes/${id}/write`,
        {
          method: "POST",
          headers: identityHeaders,
          body: JSON.stringify({ data }),
        },
      );
      expect(response.status).toBe(status);
      if (status === 200) expect(write).toHaveBeenCalledWith(data, expect.any(Function));
      else expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      nativeExitCode = 0;
      nativeStream.push(null);
      await deleteNativeProcess(id);
    }
  });

  it.each([
    { failure: "schema", code: "schema_rejected", status: 400 },
    { failure: "json", code: "schema_rejected", status: 400 },
    { failure: "files", code: "private_files_failed", status: 500 },
    { failure: "exec", code: "exec_failed", status: 500 },
    { failure: "start", code: "exec_failed", status: 500 },
  ])("reports a safe startup diagnostic for $failure", async ({ failure, code, status }) => {
    const log = vi.spyOn(getLogger(), "error").mockImplementation(() => {});
    try {
      if (failure === "files" || failure === "exec")
        mock.exec.mockRejectedValueOnce(new Error("private-env-value private-argv-value"));
      if (failure === "start")
        mock.exec.mockResolvedValueOnce({
          start: async () => {
            throw new Error("private-env-value private-argv-value");
          },
        });
      const response = await supervisorApp.request("/computers/computer/native-processes", {
        method: "POST",
        headers: identityHeaders,
        body:
          failure === "json"
            ? '{"argv":private-argv-value}'
            : JSON.stringify({
                argv: [
                  "claude",
                  failure === "schema" ? "private-argv-value".repeat(40) : "private-argv-value",
                ],
                cwd: ".",
                privateHome: stableClaudeHome,
                env: { CLAUDE_CONFIG_DIR: stableClaudeHome, FIXTURE_SECRET: "private-env-value" },
                ...(failure === "files"
                  ? { files: [{ path: "mcp-config.json", content: "private-file-value" }] }
                  : {}),
              }),
      });
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toMatchObject({ code });
      if (failure === "schema") expect(body).toMatchObject({ paths: [["argv", 1]] });
      expect(log).toHaveBeenCalledWith(
        "native process start failed",
        expect.objectContaining({ code }),
      );
      const publicAndLog = JSON.stringify([body, log.mock.calls]);
      for (const secret of ["private-env-value", "private-argv-value", "private-file-value"])
        expect(publicAndLog).not.toContain(secret);
    } finally {
      log.mockRestore();
    }
  });

  it("preserves a valid stable native home after a confirmed stop and purges it only explicitly", async () => {
    nativeExitCode = 143;
    const started = await supervisorApp.request("/computers/computer/native-processes", {
      method: "POST",
      headers: identityHeaders,
      body: JSON.stringify({
        argv: ["codex", "app-server"],
        cwd: "project",
        privateHome: stableNativeHome,
        env: { CODEX_HOME: stableNativeHome },
        files: [{ path: "config.toml", content: "[mcp_servers.rakazo]" }],
      }),
    });
    expect(started.status).toBe(200);
    const nativeExec = mock.exec.mock.calls.find(([options]) => options.Cmd[0] === "setsid")?.[0];
    expect(nativeExec.User).toBe("1000:1000");
    expect(nativeExec.WorkingDir).toBe("/home/rakazo/project");
    expect(nativeExec.Env).toContain("HOME=/home/rakazo");
    expect(nativeExec.Env).toContain(`CODEX_HOME=${stableNativeHome}`);
    expect(nativeExec.Cmd.join(" ")).toContain("mkdir -p -m 700");
    const { id } = (await started.json()) as { id: string };

    const stopped = await deleteNativeProcess(id);
    expect(await stopped.json()).toMatchObject({ status: "stopped", cleanup: "preserved" });
    expect(mock.exec.mock.calls.map(([options]) => options.Cmd.join(" ")).join("\n")).not.toContain(
      'test -d "$1" && rm -rf -- "$1"',
    );
    const cleanupCommands = mock.exec.mock.calls
      .map(([options]) => options.Cmd.join(" "))
      .join("\n");
    expect(cleanupCommands).toContain("-name config.toml");
    expect(cleanupCommands).toContain("-name auth.json");
    expect(cleanupCommands).toContain("-name auth.json.lock");
    expect(cleanupCommands).toContain("-name credentials.json");
    expect(cleanupCommands).toContain("-name credentials.json.lock");
    expect(cleanupCommands).toContain("-name auth");
    expect(cleanupCommands).toContain("-name credentials");

    const purged = await supervisorApp.request("/computers/computer/native-homes", {
      method: "DELETE",
      headers: identityHeaders,
      body: JSON.stringify({ home: stableNativeHome }),
    });
    expect(await purged.json()).toEqual({ cleanup: "removed" });
    expect(mock.exec.mock.calls.map(([options]) => options.Cmd.join(" ")).join("\n")).toContain(
      "rm -rf",
    );
  });

  it("rejects a native home outside the bot-scoped stable format", async () => {
    const response = await supervisorApp.request("/computers/computer/native-processes", {
      method: "POST",
      headers: identityHeaders,
      body: JSON.stringify({
        argv: ["codex", "app-server"],
        cwd: "project",
        privateHome: "/tmp/not-a-rakazo-native-home",
      }),
    });
    expect(response.status).toBe(500);
  });

  it("writes Claude's private MCP config and prompt and purges them after a confirmed stop", async () => {
    nativeExitCode = 143;
    const started = await supervisorApp.request("/computers/computer/native-processes", {
      method: "POST",
      headers: identityHeaders,
      body: JSON.stringify({
        argv: ["claude", "--print"],
        cwd: "project",
        privateHome: stableClaudeHome,
        env: { CLAUDE_CONFIG_DIR: stableClaudeHome },
        files: [
          { path: "mcp-config.json", content: '{"mcpServers":{}}' },
          { path: "system-prompt.md", content: "Private bot instructions." },
        ],
      }),
    });
    expect(started.status).toBe(200);
    expect(privateFileContents).toEqual(['{"mcpServers":{}}', "Private bot instructions."]);
    const promptWrite = mock.exec.mock.calls.find(([options]) =>
      options.Cmd.includes(`${stableClaudeHome}/system-prompt.md`),
    )?.[0];
    expect(promptWrite.Cmd.join(" ")).toContain("umask 077");
    expect(promptWrite.Cmd.join(" ")).toContain('chmod 600 "$2"');
    const { id } = (await started.json()) as { id: string };

    const stopped = await deleteNativeProcess(id);

    expect(await stopped.json()).toMatchObject({ status: "stopped", cleanup: "preserved" });
    const cleanupCommands = mock.exec.mock.calls
      .map(([options]) => options.Cmd.join(" "))
      .join("\n");
    expect(cleanupCommands).toContain("-name .credentials.json");
    expect(cleanupCommands).toContain("-name mcp-config.json");
    expect(cleanupCommands).toContain("-name system-prompt.md");
  });

  it("ignores provider environment variables when no private home is declared", async () => {
    const response = await supervisorApp.request("/computers/computer/native-processes", {
      method: "POST",
      headers: identityHeaders,
      body: JSON.stringify({
        argv: ["codex", "app-server"],
        cwd: "project",
        env: { CODEX_HOME: stableNativeHome },
        files: [{ path: "config.toml", content: "[mcp_servers.rakazo]" }],
      }),
    });
    expect(response.status).toBe(500);
    expect(privateFileContents).toEqual([]);
  });

  it("rejects a valid-looking home owned by another bot", async () => {
    const response = await supervisorApp.request("/computers/computer/native-processes", {
      method: "POST",
      headers: identityHeaders,
      body: JSON.stringify({
        argv: ["codex", "app-server"],
        cwd: "project",
        privateHome:
          "/tmp/rakazo-codex-other-bot-0000000000000000000000000000000000000000000000000000000000000000",
      }),
    });
    expect(response.status).toBe(500);
  });

  it("reconfirms an empty native process group without killing it again", async () => {
    nativeExitRecorded = false;
    nativeGroupAlive = false;
    const sessionId = await startNativeProcess();
    await expect(reconfirmNativeProcess(sessionId)).resolves.toHaveProperty("status", 200);
    const repeated = await reconfirmNativeProcess(sessionId);
    await expect(repeated.json()).resolves.toMatchObject({ status: "stopped" });
    expect(
      mock.exec.mock.calls
        .map(([options]) => options.Cmd.join(" "))
        .filter((command) => command.includes("kill -KILL")),
    ).toHaveLength(0);
  });

  it("keeps a living native process group stop_unconfirmed on reconfirmation", async () => {
    nativeExitRecorded = false;
    nativeGroupAlive = true;
    const sessionId = await startNativeProcess();
    const response = await reconfirmNativeProcess(sessionId);
    await expect(response.json()).resolves.toMatchObject({ status: "stop_unconfirmed" });
  });

  it("fails closed when re-confirming a native session lost from the registry", async () => {
    const response = await reconfirmNativeProcess("missing-session");
    await expect(response.json()).resolves.toMatchObject({ status: "stop_unconfirmed" });
  });

  it("fails closed when re-confirming a session on a different Computer", async () => {
    const sessionId = await startNativeProcess();
    const response = await reconfirmNativeProcess(sessionId, "other-computer");
    await expect(response.json()).resolves.toMatchObject({ status: "stop_unconfirmed" });
  });
  it("forwards route writes to the backgrounded native child", async () => {
    vi.useRealTimers();
    simulateStdinChild = true;
    const response = await supervisorApp.request("/computers/computer/native-processes", {
      method: "POST",
      headers: identityHeaders,
      body: JSON.stringify({ argv: ["sh", "-c", 'read l; printf "got:%s\\n" "$l"'], cwd: "" }),
    });
    const { id } = (await response.json()) as { id: string };
    const write = await supervisorApp.request(`/computers/computer/native-processes/${id}/write`, {
      method: "POST",
      headers: identityHeaders,
      body: JSON.stringify({ data: "ping\n" }),
    });
    expect(write.status).toBe(200);

    const read = await supervisorApp.request(`/computers/computer/native-processes/${id}/read`, {
      method: "POST",
      headers: identityHeaders,
    });
    expect(await read.json()).toMatchObject({ lines: ["got:ping\n"] });
  });

  it("writes an MCP config through stdin with private permissions, not Docker exec argv or env", async () => {
    const ticket = "ticket-must-stay-private";
    const response = await supervisorApp.request("/computers/computer/native-processes", {
      method: "POST",
      headers: identityHeaders,
      body: JSON.stringify({
        argv: ["codex", "app-server"],
        cwd: "project",
        privateHome: stableNativeHome,
        env: { CODEX_HOME: stableNativeHome },
        files: [{ path: "config.toml", content: `[mcp_servers.rakazo]\nticket = "${ticket}"\n` }],
      }),
    });

    expect(response.status).toBe(200);
    const writer = mock.exec.mock.calls.find(([options]) =>
      options.Cmd.join(" ").includes('cat > "$2"'),
    )?.[0];
    expect(writer.Cmd.join(" ")).not.toContain(ticket);
    expect(JSON.stringify(writer.Env)).not.toContain(ticket);
    expect(writer.Cmd.join(" ")).toContain("chmod 600");
    expect(privateFileContents.join("")).toContain(ticket);
  });

  it("keeps the wrapper alive through TERM so it can record the child exit", async () => {
    await startNativeProcess();

    const wrapper = mock.exec.mock.calls.find(([options]) => options.Cmd[0] === "setsid")?.[0]
      .Cmd[4];

    expect(wrapper).toContain("exec 3<&0");
    expect(wrapper).toContain('"$@" <&3 3<&- & child=$!');
    expect(wrapper).toContain("trap");
    expect(wrapper).toContain('wait "$child"');
    expect(wrapper).toContain('printf "%s" "$status" > "$exit_file"');
  });

  it("returns the wrapper exit record when TERM stops a living process", async () => {
    nativeExitCode = 143;
    const sessionId = await startNativeProcess();

    const response = await deleteNativeProcess(sessionId);

    expect(await response.json()).toMatchObject({
      status: "stopped",
      terminal: { code: 143, exitSource: "wrapper_exit_file" },
    });
  });

  it("uses the image-portable negative process-group syntax for TERM", async () => {
    nativeExitCode = 143;
    const sessionId = await startNativeProcess();

    await deleteNativeProcess(sessionId);

    const term = mock.exec.mock.calls
      .map(([options]) => options.Cmd.join(" "))
      .find((command) => command.includes('test -s "$1" && kill -TERM'));
    expect(term).toContain('kill -TERM -$(cat "$1")');
    expect(term).not.toContain("kill -TERM --");
  });

  it("returns classified stderr facts without exposing stderr bytes or mixing them into stdout", async () => {
    vi.useRealTimers();
    nativeExitCode = 0;
    nativeExitRecorded = false;
    const sessionId = await startNativeProcess();
    const secretMarker = "stderr-secret-marker-never-returned";
    nativeStream.write(dockerFrame(1, '{"jsonrpc":"2.0","id":1,"result":{}}\n'));
    nativeStream.write(dockerFrame(2, secretMarker));
    nativeStream.end();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const response = await supervisorApp.request(
      `/computers/computer/native-processes/${sessionId}/read`,
      { method: "POST", headers: identityHeaders },
    );
    const body = await response.text();
    expect(body).not.toContain(secretMarker);
    expect(JSON.parse(body)).toEqual({
      lines: ['{"jsonrpc":"2.0","id":1,"result":{}}\n'],
      streamLost: true,
      terminal: null,
    });
  });

  it("classifies an authentication stderr failure without returning its text", async () => {
    vi.useRealTimers();
    nativeExitRecorded = false;
    const sessionId = await startNativeProcess();
    nativeStream.write(dockerFrame(2, "authentication token rejected"));
    nativeStream.end();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const response = await supervisorApp.request(
      `/computers/computer/native-processes/${sessionId}/read`,
      { method: "POST", headers: identityHeaders },
    );
    expect(await response.json()).toEqual({
      lines: [],
      streamLost: true,
      terminal: null,
    });
  });

  it("reports a lost hijacked stream without claiming that the native process ended", async () => {
    vi.useRealTimers();
    const sessionId = await startNativeProcess();
    nativeStream.end();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const response = await supervisorApp.request(
      `/computers/computer/native-processes/${sessionId}/read`,
      { method: "POST", headers: identityHeaders },
    );
    expect(await response.json()).toEqual({
      lines: [],
      streamLost: true,
      terminal: null,
    });
  });

  it("does not claim a stop from a lost stream when its process group remains", async () => {
    nativeExitCode = 0;
    nativeExitRecorded = false;
    ignoreTerm = true;
    nativeGroupAlive = true;
    const sessionId = await startNativeProcess();
    nativeStream.end();
    await vi.advanceTimersByTimeAsync(0);

    const response = await deleteNativeProcess(sessionId);

    expect(await response.json()).toMatchObject({
      status: "stop_unconfirmed",
      cleanup: "deferred",
    });
  });

  it("confirms a lost stream after KILL only when the process group is empty", async () => {
    nativeExitCode = 0;
    nativeExitRecorded = false;
    ignoreTerm = true;
    const sessionId = await startNativeProcess();
    nativeStream.end();
    await vi.advanceTimersByTimeAsync(0);

    const stopping = deleteNativeProcess(sessionId);
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(await (await stopping).json()).toMatchObject({
      status: "stopped",
      terminal: { exitSource: "unknown_after_kill" },
    });
  });

  it("keeps a lost stream unconfirmed when a KILL leaves a group member alive", async () => {
    nativeExitCode = 0;
    nativeExitRecorded = false;
    ignoreTerm = true;
    nativeGroupAlive = true;
    const sessionId = await startNativeProcess();
    nativeStream.end();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = deleteNativeProcess(sessionId);
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(await (await stopping).json()).toMatchObject({
      status: "stop_unconfirmed",
      cleanup: "deferred",
    });
  });

  it("reads the wrapper exit record after KILL even when the hijacked stream is still present", async () => {
    nativeExitCode = 137;
    ignoreTerm = true;
    const sessionId = await startNativeProcess();

    const stopping = deleteNativeProcess(sessionId);
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(await (await stopping).json()).toMatchObject({
      status: "stopped",
      terminal: { code: 137, exitSource: "wrapper_exit_file" },
    });
  });

  it("accepts the internal workspace root for a dedicated Computer", async () => {
    const response = await supervisorApp.request("/computers/computer/native-processes", {
      method: "POST",
      headers: identityHeaders,
      body: JSON.stringify({ argv: ["codex", "app-server"], cwd: "" }),
    });

    expect(response.status).toBe(200);
  });

  it("defers home purge and retains a writable handle when TERM and KILL do not confirm exit", async () => {
    nativeGroupAlive = true;
    const sessionId = await startNativeProcess();

    const stopping = deleteNativeProcess(sessionId);
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.advanceTimersByTimeAsync(2_100);
    const response = await stopping;

    expect(await response.json()).toEqual({ status: "stop_unconfirmed", cleanup: "deferred" });
    expect(mock.exec.mock.calls.map(([options]) => options.Cmd.join(" "))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("kill -TERM"),
        expect.stringContaining("kill -KILL"),
      ]),
    );
    expect(mock.exec.mock.calls.map(([options]) => options.Cmd.join(" ")).join("\n")).not.toContain(
      'test -d "$1" && rm -rf -- "$1"',
    );

    const write = await supervisorApp.request(
      `/computers/computer/native-processes/${sessionId}/write`,
      { method: "POST", headers: identityHeaders, body: JSON.stringify({ data: "retry\n" }) },
    );
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual({ ok: true });
  });

  it("preserves the durable home after a confirmed stop", async () => {
    nativeExitCode = 137;
    const sessionId = await startNativeProcess();

    const response = await deleteNativeProcess(sessionId);

    expect(await response.json()).toMatchObject({ status: "stopped", cleanup: "preserved" });
    expect(mock.exec.mock.calls.map(([options]) => options.Cmd.join(" ")).join("\n")).not.toContain(
      'test -d "$1" && rm -rf -- "$1"',
    );
    const retry = await deleteNativeProcess(sessionId);
    expect(await retry.json()).toMatchObject({ status: "stopped" });
  });

  it("reports an unknown exit after TERM is ignored and KILL ends the wrapper without an exit file", async () => {
    vi.useRealTimers();
    nativeExitCode = 0;
    nativeExitRecorded = false;
    ignoreTerm = true;
    endOnKill = true;
    const sessionId = await startNativeProcess();

    const stopping = deleteNativeProcess(sessionId);
    const response = await stopping;

    expect(await response.json()).toMatchObject({ status: "stopped", cleanup: "preserved" });
    const read = await supervisorApp.request(
      `/computers/computer/native-processes/${sessionId}/read`,
      { method: "POST", headers: identityHeaders },
    );
    expect(read.status).toBe(404);
    expect(await read.json()).toEqual({ error: "native process not found" });
    const commands = mock.exec.mock.calls.map(([options]) => options.Cmd.join(" ")).join("\n");
    expect(commands).toContain("kill -TERM");
    expect(commands).toContain("kill -KILL");
    expect(commands).toContain("rm -f");
  });
});
