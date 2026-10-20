import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

/** A sandbox whose mount is a directory here: its commands run in this machine's shell. */
async function localVolumes() {
  const opened: string[] = [];
  const killed: string[] = [];
  const dirs = new Map<string, string>();
  const open = async (volumeRef: string): Promise<VolumeSandbox> => {
    opened.push(volumeRef);
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-volume-"));
    roots.push(dir);
    dirs.set(volumeRef, dir);
    const local = (guestPath: string) => guestPath.replaceAll(VOLUME_FILES_MOUNT, dir);
    return {
      run: async (command) => (await run("bash", ["-c", local(command)])).stdout,
      async write(guestPath, content) {
        await mkdir(path.dirname(local(guestPath)), { recursive: true });
        await writeFile(local(guestPath), content);
      },
      read: async (guestPath) => new Uint8Array(await readFile(local(guestPath))),
      kill: async () => {
        killed.push(volumeRef);
      },
    };
  };
  return { files: new E2BVolumeFiles(open), opened, killed, dirs };
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
