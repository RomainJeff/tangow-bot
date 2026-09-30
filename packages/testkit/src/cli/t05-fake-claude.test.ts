import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fakeClaude = fileURLToPath(new URL("./t05-fake-claude.mjs", import.meta.url));

async function runFakeClaude(configDir: string, args: string[] = []) {
  const child = spawn(process.execPath, [fakeClaude, ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end('{"type":"user","message":{"content":"hello"}}\n');
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

describe("T05 fake Claude CLI", () => {
  it("writes a private session from stream-json and resumes that same session", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "rakazo-t05-fake-claude-"));

    const first = await runFakeClaude(configDir);
    expect(first.code).toBe(0);
    const sessionId = JSON.parse(first.stdout.split("\n")[0] ?? "{}").session_id;
    expect(sessionId).toBe("t05-fake-session");
    await expect(readFile(path.join(configDir, "t05-session.json"), "utf8")).resolves.toContain(
      sessionId,
    );

    const resumed = await runFakeClaude(configDir, ["--resume", sessionId]);
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.stdout.split("\n")[0] ?? "{}").session_id).toBe(sessionId);
  });
});
