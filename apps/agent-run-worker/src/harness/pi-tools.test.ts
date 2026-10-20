import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeToolContext } from "../harness.js";
import { executePiTool } from "./pi-tools.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function context(signal = new AbortController().signal): Promise<NativeToolContext> {
  const cwd = await mkdtemp(path.join(tmpdir(), "rakazo-native-"));
  dirs.push(cwd);
  return { cwd, signal, spoolDir: path.join(cwd, "spool") };
}

async function bash(args: Record<string, unknown>, ctx: NativeToolContext) {
  const output = await executePiTool("bash", args, randomUUID(), ctx);
  if (!("text" in output)) throw new Error("Expected command output");
  return output;
}

it("forwards a small native read image within the controller result budget", async () => {
  const ctx = await context();
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
  await writeFile(path.join(ctx.cwd, "pixel.png"), Buffer.from(png, "base64"));
  const output = await executePiTool("read", { path: "pixel.png" }, "read-image", ctx);
  expect(output).toMatchObject({
    result: {
      kind: "agent_tool_result",
      content: expect.arrayContaining([{ type: "image", data: png, mimeType: "image/png" }]),
    },
  });
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(64 * 1024);
});

describe("bash", () => {
  it("runs in the workdir and reports a failing command as an error with its output", async () => {
    const ctx = await context();

    expect(await bash({ command: "pwd; echo oops >&2; exit 3" }, ctx)).toEqual({
      text: `${await realpath(ctx.cwd)}\noops\n\n\nCommand exited with code 3`,
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

  it("keeps the newest spool files and leaves other files of the spool directory alone", async () => {
    const ctx = await context();
    await mkdir(ctx.spoolDir, { recursive: true });
    for (let index = 0; index < 16; index += 1) {
      const file = path.join(ctx.spoolDir, `bash-old-${String(index).padStart(2, "0")}.log`);
      await writeFile(file, "old");
      await utimes(file, 1_000 + index, 1_000 + index);
    }
    await writeFile(path.join(ctx.spoolDir, "notes.txt"), "mine");

    const output = await bash({ command: "seq 1 3000" }, ctx);
    const kept = (await readdir(ctx.spoolDir)).sort();

    expect(kept).toEqual(
      [
        ...Array.from({ length: 15 }, (_, i) => `bash-old-${String(i + 1).padStart(2, "0")}.log`),
        path.basename(output.spoolPath!),
        "notes.txt",
      ].sort(),
    );
  });

  it("never prunes the spool file of a command still running", async () => {
    const ctx = await context();
    await mkdir(ctx.spoolDir, { recursive: true });
    for (let index = 0; index < 16; index += 1) {
      await writeFile(path.join(ctx.spoolDir, `bash-old-${index}.log`), "old");
    }
    const release = path.join(ctx.cwd, "release");
    const running = bash(
      { command: `seq 1 3000; while [ ! -e ${release} ]; do sleep 0.05; done` },
      ctx,
    );
    await waitFor(() => readdir(ctx.spoolDir).then((names) => (names.length === 16 ? 1 : 0)));
    const later = new Date(Date.now() + 60_000);
    for (let index = 1; index < 16; index += 1) {
      await utimes(path.join(ctx.spoolDir, `bash-old-${index}.log`), later, later);
    }

    await bash({ command: "seq 1 3000" }, ctx);
    await writeFile(release, "");
    const output = await running;

    expect(await readFile(output.spoolPath!, "utf8")).toBe(
      `${Array.from({ length: 3000 }, (_, i) => i + 1).join("\n")}\n`,
    );
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

it.each(["read", "edit"])("refuses oversized files in %s before loading them", async (name) => {
  const ctx = await context();
  const file = path.join(ctx.cwd, "large.txt");
  await writeFile(file, "original");
  await truncate(file, 250 * 1024 + 1);
  const output = await executePiTool(
    name,
    { path: "large.txt", edits: [{ oldText: "original", newText: "changed" }] },
    "large",
    ctx,
  );
  expect(output).toMatchObject({ isError: true, text: expect.stringContaining("250 KiB") });
  expect(output).toMatchObject({ text: expect.stringContaining("bash") });
  expect((await readFile(file)).subarray(0, 8).toString()).toBe("original");
});

it.each([1, 17])(
  "continues native reads at the first unseen whole line from offset %i",
  async (offset) => {
    const ctx = await context();
    const lines = Array.from({ length: 700 }, (_, i) => `${i + 1}: ${"x".repeat(60)}`);
    await writeFile(path.join(ctx.cwd, "lines.txt"), lines.join("\n"));
    const output = await executePiTool("read", { path: "lines.txt", offset }, "page", ctx);
    if (!("text" in output)) throw new Error("Expected text");
    const shown = output.text.split("\n").filter((line) => /^\d+: /.test(line));
    expect(shown).toEqual(lines.slice(offset - 1, offset - 1 + shown.length));
    const next = offset + shown.length;
    expect(output.text).toContain(`Use offset=${next} to continue`);
    expect(output.text.length).toBeLessThanOrEqual(12_000);
    const continued = await executePiTool(
      "read",
      { path: "lines.txt", offset: next, limit: 1 },
      "next",
      ctx,
    );
    if (!("text" in continued)) throw new Error("Expected text");
    expect(continued.text.split("\n")[0]).toBe(lines[next - 1]);
  },
);

it.each([
  ["seq 1 3000; exit 7", "Command exited with code 7"],
  ["seq 1 3000; sleep 5", "Command timed out after 0.2 seconds"],
])("keeps bash status beside the truncation marker for %s", async (command, status) => {
  const output = await bash({ command, timeout: 0.2 }, await context());
  expect(output.isError).toBe(true);
  expect(output.text).toMatch(new RegExp(`\\[output truncated:[^\\n]+\\]\\n${status}`));
  expect(output.text.length).toBeLessThanOrEqual(12_000);
});
