import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bash, LOCAL_TOOLS, type LocalToolContext } from "./local-tools.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A guest whose private volume is mounted, as its working directory, beside the shared one. */
async function context(signal = new AbortController().signal): Promise<LocalToolContext> {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-guest-"));
  dirs.push(root);
  const cwd = path.join(root, "workspace", "bots", "bot_1");
  await mkdir(cwd, { recursive: true });
  return {
    cwd,
    signal,
    spoolDir: path.join(root, "spool"),
    botId: "bot_1",
    root,
    mounts: [
      { path: "/workspace/bots/bot_1", scope: "private", access: "rw" },
      { path: "/workspace/shared", scope: "shared", access: "rw" },
    ],
  };
}

function tool(name: string) {
  return LOCAL_TOOLS[name]!;
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

describe("file tools", () => {
  it("write, edit, read and list the bot's volume with the in-process paths and results", async () => {
    const ctx = await context();

    expect(await tool("write_file")({ path: "notes/todo.md", content: "one\ntwo\n" }, ctx)).toEqual(
      {
        result: { ok: true, path: "notes/todo.md" },
      },
    );
    expect(
      await tool("edit_file")({ path: "notes/todo.md", old_text: "two", new_text: "2" }, ctx),
    ).toEqual({ result: { ok: true, path: "notes/todo.md", replacements: 1 } });
    expect(await tool("read_file")({ path: "notes/todo.md" }, ctx)).toEqual({
      result: {
        path: "notes/todo.md",
        content: "one\n2\n",
        startLine: 1,
        endLine: 2,
        totalLines: 2,
      },
    });
    expect(
      await tool("read_file")({ path: "/workspace/bots/bot_1/notes/todo.md", limit: 1 }, ctx),
    ).toEqual({
      result: {
        path: "/workspace/bots/bot_1/notes/todo.md",
        content: "one\n",
        startLine: 1,
        endLine: 1,
        totalLines: 2,
        nextOffset: 2,
      },
    });
    expect(await tool("list_files")({}, ctx)).toEqual({
      result: { path: "", entries: [{ path: "notes", kind: "dir", size: 0 }] },
    });
    expect(await tool("list_files")({ path: "notes" }, ctx)).toEqual({
      result: { path: "notes", entries: [{ path: "notes/todo.md", kind: "file", size: 6 }] },
    });
    expect(await readFile(path.join(ctx.cwd, "notes", "todo.md"), "utf8")).toBe("one\n2\n");
  });

  it("writes shared/ to the space's shared volume", async () => {
    const ctx = await context();

    expect(await tool("write_file")({ path: "shared/plan.md", content: "plan" }, ctx)).toEqual({
      result: { ok: true, path: "shared/plan.md" },
    });
    expect(await readFile(path.join(ctx.root, "workspace", "shared", "plan.md"), "utf8")).toBe(
      "plan",
    );
  });

  it("returns the in-process refusals", async () => {
    const ctx = await context();
    await writeFile(path.join(ctx.cwd, "a.txt"), "same same");
    await writeFile(path.join(ctx.cwd, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00]));
    await writeFile(path.join(ctx.cwd, "huge.txt"), "");
    await truncate(path.join(ctx.cwd, "huge.txt"), 10 * 1024 * 1024 + 1);

    const cases: Array<[string, Record<string, unknown>, unknown]> = [
      [
        "write_file",
        { path: "a.txt", content: "new" },
        {
          error:
            "file already exists; use edit_file to change part of it, or set overwrite to true to replace it whole",
          path: "a.txt",
        },
      ],
      [
        "edit_file",
        { path: "a.txt", old_text: "same", new_text: "x" },
        {
          error:
            "old_text matches several places; include more surrounding text or set replace_all to true",
          path: "a.txt",
          matches: 2,
        },
      ],
      [
        "edit_file",
        { path: "a.txt", old_text: "other", new_text: "x" },
        {
          error: "old_text not found; read the file again with read_file and copy the text exactly",
          path: "a.txt",
        },
      ],
      [
        "read_file",
        { path: "a.txt", offset: 5 },
        {
          error: "offset is past the end of the file; use a smaller offset",
          path: "a.txt",
          totalLines: 1,
        },
      ],
      [
        "read_file",
        { path: "blob.bin" },
        { error: "file is not UTF-8 text; use open_path to inspect it", path: "blob.bin" },
      ],
      [
        "read_file",
        { path: "huge.txt" },
        { error: "file is too large to read; use shell", path: "huge.txt" },
      ],
    ];
    for (const [name, args, result] of cases) {
      expect(await tool(name)(args, ctx), `${name} ${JSON.stringify(args)}`).toEqual({ result });
    }
    expect(await readFile(path.join(ctx.cwd, "a.txt"), "utf8")).toBe("same same");
  });

  it("refuses a write that is not on a writable mounted volume", async () => {
    const ctx = {
      ...(await context()),
      mounts: [
        { path: "/workspace/bots/bot_1", scope: "private" as const, access: "rw" as const },
        { path: "/workspace/shared", scope: "shared" as const, access: "ro" as const },
      ],
    };
    const lost = (target: string) =>
      `${target} is not on a mounted volume, so it would be lost when this run ends; write under a mounted volume (/workspace/bots/bot_1, /workspace/shared)`;

    expect(await tool("write_file")({ path: "/workspace/notes/a.md", content: "x" }, ctx)).toEqual({
      result: { error: lost("/workspace/notes/a.md"), path: "/workspace/notes/a.md" },
    });
    expect(await tool("write_file")({ path: "bots/bot_2/a.md", content: "x" }, ctx)).toEqual({
      result: { error: lost("/workspace/bots/bot_2/a.md"), path: "bots/bot_2/a.md" },
    });
    expect(
      await tool("edit_file")({ path: "shared/plan.md", old_text: "a", new_text: "b" }, ctx),
    ).toEqual({
      result: { error: "/workspace/shared is mounted read-only", path: "shared/plan.md" },
    });
    expect(await readdir(path.join(ctx.root, "workspace"))).toEqual(["bots"]);
  });

  it("returns a result too large for the channel as an error the model sees", async () => {
    const ctx = await context();
    await writeFile(path.join(ctx.cwd, "control.txt"), "\u0001".repeat(200_000));

    expect(await tool("read_file")({ path: "control.txt" }, ctx)).toEqual({
      result: {
        error:
          "the result is too large to return (1200076 bytes); read fewer lines with offset and limit, or list a subdirectory",
        path: "control.txt",
      },
    });
  });

  it("lists a dangling link as a file instead of failing the listing", async () => {
    const ctx = await context();
    await writeFile(path.join(ctx.cwd, "a.txt"), "a");
    await symlink(path.join(ctx.cwd, "gone"), path.join(ctx.cwd, "link"));

    expect(await tool("list_files")({}, ctx)).toEqual({
      result: {
        path: "",
        entries: [
          { path: "a.txt", kind: "file", size: 1 },
          { path: "link", kind: "file", size: path.join(ctx.cwd, "gone").length },
        ],
      },
    });
  });

  it("reports a path outside the workspace or a missing file as a failed call", async () => {
    const ctx = await context();

    expect(await tool("read_file")({ path: "../other/secret.txt" }, ctx)).toEqual({
      text: "Path escapes the computer workspace",
      isError: true,
      truncated: false,
      totalBytes: 0,
    });
    expect(await tool("read_file")({ path: "missing.txt" }, ctx)).toMatchObject({
      text: expect.stringContaining("ENOENT"),
      isError: true,
    });
  });
});

describe("grep", () => {
  async function tree() {
    const ctx = await context();
    const files: Record<string, string | Buffer> = {
      "b.md": "Alpha\nbeta\nalphabet\n",
      "a/one.ts": "const alpha = 1;\n",
      "a/deep/two.ts": "// alpha\n",
      "image.png": Buffer.from([0x61, 0x6c, 0x70, 0x68, 0x61, 0x00]),
      ".git/config": "alpha",
      "node_modules/x/index.js": "alpha",
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(ctx.cwd, file)), { recursive: true });
      await writeFile(path.join(ctx.cwd, file), content);
    }
    return ctx;
  }

  it("lists matching lines in path order, skipping binary files, .git and node_modules", async () => {
    const ctx = await tree();

    expect(await tool("grep")({ pattern: "alpha" }, ctx)).toEqual({
      text: "a/deep/two.ts:1:// alpha\na/one.ts:1:const alpha = 1;\nb.md:3:alphabet",
      isError: false,
      truncated: false,
      totalBytes: 68,
    });
  });

  it("narrows by path, glob and case, and caps the results", async () => {
    const ctx = await tree();

    expect(
      await tool("grep")({ pattern: "^alpha", ignore_case: true, path: "b.md" }, ctx),
    ).toMatchObject({
      text: "b.md:1:Alpha\nb.md:3:alphabet",
    });
    expect(await tool("grep")({ pattern: "alpha", glob: "*.ts" }, ctx)).toMatchObject({
      text: "a/deep/two.ts:1:// alpha\na/one.ts:1:const alpha = 1;",
    });
    expect(
      await tool("grep")({ pattern: "alpha", path: "a", glob: "deep/**/*.ts" }, ctx),
    ).toMatchObject({
      text: "a/deep/two.ts:1:// alpha",
    });
    expect(await tool("grep")({ pattern: "alpha", max_results: 1 }, ctx)).toMatchObject({
      text: "a/deep/two.ts:1:// alpha\n\n[more matches not shown: narrow the pattern, the path or the glob]",
      truncated: true,
    });
    expect(await tool("grep")({ pattern: "gamma" }, ctx)).toMatchObject({ text: "No matches." });
  });

  it("searches a named file whose path matches a glob with a slash, and skips unreadable files", async () => {
    const ctx = await tree();
    await writeFile(path.join(ctx.cwd, "a", "locked.ts"), "alpha");
    await chmod(path.join(ctx.cwd, "a", "locked.ts"), 0o000);

    expect(
      await tool("grep")({ pattern: "alpha", path: "a/one.ts", glob: "a/*.ts" }, ctx),
    ).toMatchObject({ text: "a/one.ts:1:const alpha = 1;" });
    expect(await tool("grep")({ pattern: "alpha", path: "a" }, ctx)).toMatchObject({
      text: "a/deep/two.ts:1:// alpha\na/one.ts:1:const alpha = 1;",
    });
  });

  it("refuses an invalid regular expression", async () => {
    const ctx = await tree();

    expect(await tool("grep")({ pattern: "(" }, ctx)).toEqual({
      text: "invalid pattern: Invalid regular expression: /(/: Unterminated group",
      isError: true,
      truncated: false,
      totalBytes: 0,
    });
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
