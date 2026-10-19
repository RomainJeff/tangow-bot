import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bash } from "./local-tools.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function context(signal = new AbortController().signal) {
  const cwd = await mkdtemp(path.join(tmpdir(), "rakazo-guest-"));
  dirs.push(cwd);
  return { cwd, signal, spoolDir: path.join(cwd, ".spool") };
}

describe("bash", () => {
  it("runs in the workdir and reports a failing command as an error with its output", async () => {
    const ctx = await context();

    expect(await bash({ command: "pwd; echo oops >&2; exit 3" }, ctx)).toEqual({
      text: `${await realpath(ctx.cwd)}\noops\n\nCommand exited with code 3`,
      isError: true,
      truncated: false,
      totalBytes: Buffer.byteLength(`${await realpath(ctx.cwd)}\noops\n`),
    });
  });

  it("shows the model the first and last lines of a long output and where the rest is", async () => {
    const ctx = await context();

    const output = await bash({ command: "seq 1 3000" }, ctx);
    const lines = output.text.split("\n");

    expect(output.truncated).toBe(true);
    expect(lines.slice(0, 2)).toEqual(["1", "2"]);
    expect(lines.slice(-2)).toEqual(["2999", "3000"]);
    expect(lines.length).toBeLessThanOrEqual(2000);
    expect(output.text).toContain(
      `[output truncated: 13893 bytes in total, it is in ${output.spoolPath}]`,
    );
    expect(await readFile(output.spoolPath!, "utf8")).toBe(
      `${Array.from({ length: 3000 }, (_, i) => i + 1).join("\n")}\n`,
    );
  });

  it("stops spooling at 16 MiB but still counts every byte", async () => {
    const ctx = await context();

    const output = await bash({ command: "head -c 20971520 /dev/zero | tr '\\0' 'a'" }, ctx);

    expect(output.totalBytes).toBe(20 * 1024 * 1024);
    expect((await stat(output.spoolPath!)).size).toBe(16 * 1024 * 1024);
    expect(output.text.length).toBeLessThanOrEqual(12_000);
    expect(output.text).toContain("its first 16777216 bytes are in");
  });

  it("kills the command's whole process group when the run is aborted", async () => {
    const abort = new AbortController();
    const ctx = await context(abort.signal);
    const pidFile = path.join(ctx.cwd, "child.pid");

    const running = bash({ command: `sleep 30 & echo $! > ${pidFile}; wait` }, ctx);
    await waitFor(() => readFile(pidFile, "utf8").then(Number, () => 0));
    const child = Number(await readFile(pidFile, "utf8"));
    const startedAt = Date.now();
    abort.abort();
    const output = await running;

    expect(output).toMatchObject({ isError: true, text: "Command aborted" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(isAlive(child)).toBe(false);
  });
});

async function waitFor(read: () => Promise<number>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
