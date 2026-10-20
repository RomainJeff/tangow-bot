import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { E2BVolumeFiles, VOLUME_FILES_MOUNT, type VolumeSandbox } from "./e2b-volume-files.js";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class SandboxGone extends Error {}

/**
 * Sandboxes whose mount is a directory here, one directory per volume that outlives its
 * sandboxes: their commands run in this machine's shell.
 */
async function localVolumes() {
  const opened: string[] = [];
  const killed: string[] = [];
  const dirs = new Map<string, string>();
  const current = new Map<string, { gone: boolean }>();
  const failingKills = new Set<string>();
  const open = async (volumeRef: string): Promise<VolumeSandbox> => {
    opened.push(volumeRef);
    let dir = dirs.get(volumeRef);
    if (!dir) {
      dir = await mkdtemp(path.join(tmpdir(), "rakazo-volume-"));
      roots.push(dir);
      dirs.set(volumeRef, dir);
    }
    const state = { gone: false };
    current.set(volumeRef, state);
    const local = (guestPath: string) => guestPath.replaceAll(VOLUME_FILES_MOUNT, dir);
    const alive = () => {
      if (state.gone) throw new SandboxGone("sandbox not found");
    };
    return {
      run: async (command) => {
        alive();
        return (await run("bash", ["-c", local(command)])).stdout;
      },
      async write(guestPath, content) {
        alive();
        await mkdir(path.dirname(local(guestPath)), { recursive: true });
        await writeFile(local(guestPath), content);
      },
      read: async (guestPath) => {
        alive();
        return new Uint8Array(await readFile(local(guestPath)));
      },
      kill: async () => {
        if (failingKills.has(volumeRef)) throw new Error(`cannot kill ${volumeRef}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        killed.push(volumeRef);
      },
      isGone: (error) => error instanceof SandboxGone,
    };
  };
  return {
    files: new E2BVolumeFiles(open),
    opened,
    killed,
    dirs,
    /** E2B killed the volume's current sandbox, for example at its timeout. */
    lose: (volumeRef: string) => {
      current.get(volumeRef)!.gone = true;
    },
    failingKills,
  };
}

const context = {
  operationId: "e2b-volume-test",
  traceId: "e2b-volume-test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const text = (value: string) => new TextEncoder().encode(value);

describe("E2B volume files", () => {
  it("writes files with their mode through one sandbox per volume, lists and reads them back", async () => {
    const { files, opened, killed, dirs } = await localVolumes();

    await files.write(
      "vol-a",
      { path: "bin/tools/run.sh", content: text("echo"), executable: true },
      context,
    );
    await files.write("vol-a", { path: "bin/it's notes.md", content: text("hi") }, context);
    await files.write("vol-a", { path: "bin/secret", content: text("key"), mode: 0o600 }, context);
    await files.write("vol-b", { path: "a.txt", content: text("b") }, context);
    await files.write("vol-a", { path: "bin/secret", content: text("new"), mode: 0o640 }, context);

    expect(
      (await files.list("vol-a", context)).sort((a, b) => a.path.localeCompare(b.path)),
    ).toEqual([
      { path: "bin", kind: "dir", mode: 0o755 },
      { path: "bin/it's notes.md", kind: "file", mode: 0o644 },
      { path: "bin/secret", kind: "file", mode: 0o640 },
      { path: "bin/tools", kind: "dir", mode: 0o755 },
      { path: "bin/tools/run.sh", kind: "file", mode: 0o755 },
    ]);
    expect(new TextDecoder().decode(await files.read("vol-a", "bin/secret", context))).toBe("new");
    expect((await stat(path.join(dirs.get("vol-b")!, "a.txt"))).mode & 0o777).toBe(0o644);
    expect(opened).toEqual(["vol-a", "vol-b"]);

    await files.close();
    expect(killed.sort()).toEqual(["vol-a", "vol-b"]);
  });

  it("lists a link and a fifo as other entries without following them", async () => {
    const { files, dirs } = await localVolumes();
    await files.write("vol", { path: "real/file.txt", content: text("x") }, context);
    const dir = dirs.get("vol")!;
    await run("bash", ["-c", `ln -s real ${dir}/link && mkfifo ${dir}/pipe`]);

    const entries = await files.list("vol", context);

    expect(
      entries
        .filter((entry) => entry.kind === "other")
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(["link", "pipe"]);
    expect(entries.some((entry) => entry.path.startsWith("link/"))).toBe(false);
  });

  it("replaces a link at the target instead of writing through it, and leaves no temporary file", async () => {
    const { files, dirs } = await localVolumes();
    await files.write("vol", { path: "seed.txt", content: text("seed") }, context);
    const dir = dirs.get("vol")!;
    const outside = await mkdtemp(path.join(tmpdir(), "rakazo-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "victim.txt"), "untouched");
    await run("bash", ["-c", `ln -s ${outside}/victim.txt ${dir}/notes.md`]);

    await files.write("vol", { path: "notes.md", content: text("mine"), mode: 0o600 }, context);

    expect(await readFile(path.join(outside, "victim.txt"), "utf8")).toBe("untouched");
    expect((await lstat(path.join(dir, "notes.md"))).isFile()).toBe(true);
    expect(await readFile(path.join(dir, "notes.md"), "utf8")).toBe("mine");
    expect((await stat(path.join(dir, "notes.md"))).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).sort()).toEqual(["notes.md", "seed.txt"]);
  });

  it("refuses to write over a directory and removes its temporary file", async () => {
    const { files, dirs } = await localVolumes();
    await files.write("vol", { path: "notes/inner.txt", content: text("x") }, context);

    await expect(
      files.write("vol", { path: "notes", content: text("flat") }, context),
    ).rejects.toThrow();

    expect((await readdir(dirs.get("vol")!)).sort()).toEqual(["notes"]);
    expect(await readdir(path.join(dirs.get("vol")!, "notes"))).toEqual(["inner.txt"]);
  });

  it("opens a new sandbox when E2B killed the volume's sandbox, and keeps the volume's files", async () => {
    const { files, opened, lose } = await localVolumes();
    await files.write("vol", { path: "kept.txt", content: text("kept") }, context);

    lose("vol");

    expect(new TextDecoder().decode(await files.read("vol", "kept.txt", context))).toBe("kept");
    expect(opened).toEqual(["vol", "vol"]);
  });

  it("waits for every sandbox's destruction, then reports the one it could not destroy", async () => {
    const { files, killed, failingKills } = await localVolumes();
    await files.write("vol-a", { path: "a.txt", content: text("a") }, context);
    await files.write("vol-b", { path: "b.txt", content: text("b") }, context);
    failingKills.add("vol-a");

    await expect(files.close()).rejects.toThrow("cannot kill vol-a");

    expect(killed).toEqual(["vol-b"]);
  });

  it.each(["../escape", "a//b", "a/./b", "a\\b", "/abs", "a/"])(
    "refuses to write or read the path %j before opening a sandbox",
    async (badPath) => {
      const { files, opened } = await localVolumes();

      await expect(
        files.write("vol", { path: badPath, content: new Uint8Array() }, context),
      ).rejects.toThrow("Refusing the volume path");
      await expect(files.read("vol", badPath, context)).rejects.toThrow("Refusing the volume path");
      expect(opened).toEqual([]);
    },
  );
});
