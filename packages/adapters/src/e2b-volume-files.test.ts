import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SandboxNotFoundError, TimeoutError } from "e2b";
import { afterEach, describe, expect, it } from "vitest";
import {
  E2BVolumeFiles,
  isSandboxGone,
  VOLUME_FILES_MOUNT,
  type VolumeSandbox,
} from "./e2b-volume-files.js";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** What envd answers when a sandbox is behind a failing proxy, or killed: the SDK's own text. */
const unreachable = () =>
  new TimeoutError(
    "502: The sandbox was not found: This error is likely due to sandbox timeout. You can modify the sandbox timeout by passing 'timeoutMs' when starting the sandbox or calling '.setTimeout' on the sandbox with the desired timeout.",
  );
/** What the SDK answers once its health probe saw the sandbox gone mid-request. */
const killedInFlight = () =>
  new TimeoutError(
    "[unavailable] connection terminated: The sandbox was killed or reached its end of life while the request was in flight.",
  );

type Op = "run" | "write" | "read";
type Fault = { op: Op; match?: string; error: () => unknown; before?: () => void };

/**
 * Sandboxes whose mount is a directory here, one directory per volume that outlives its
 * sandboxes: their commands run in this machine's shell. `faults` make the next matching call of
 * the volume's current sandbox fail once, and `listed` is what the control plane says.
 */
async function localVolumes() {
  const opened: string[] = [];
  const killed: string[] = [];
  const dirs = new Map<string, string>();
  const faults = new Map<string, Fault[]>();
  const listed = new Map<string, boolean>();
  const failingKills = new Set<string>();
  /** Each upload's path and the mode the file had just before the bytes landed. */
  const uploads: Array<{ path: string; modeBefore: number | null }> = [];
  const open = async (volumeRef: string): Promise<VolumeSandbox> => {
    opened.push(volumeRef);
    const id = `${volumeRef}#${opened.filter((ref) => ref === volumeRef).length}`;
    let dir = dirs.get(volumeRef);
    if (!dir) {
      dir = await mkdtemp(path.join(tmpdir(), "rakazo-volume-"));
      roots.push(dir);
      dirs.set(volumeRef, dir);
    }
    listed.set(volumeRef, true);
    const local = (guestPath: string) => guestPath.replaceAll(VOLUME_FILES_MOUNT, dir);
    const inject = (op: Op, subject: string) => {
      const queue = faults.get(volumeRef) ?? [];
      const index = queue.findIndex(
        (fault) => fault.op === op && (!fault.match || subject.includes(fault.match)),
      );
      if (index === -1) return;
      const [fault] = queue.splice(index, 1);
      fault!.before?.();
      throw fault!.error();
    };
    return {
      run: async (command, signal) => {
        signal.throwIfAborted();
        inject("run", command);
        return (await run("bash", ["-c", local(command)])).stdout;
      },
      async write(guestPath, content, signal) {
        signal.throwIfAborted();
        const modeBefore = await stat(local(guestPath)).then(
          (info) => info.mode & 0o777,
          () => null,
        );
        uploads.push({ path: guestPath, modeBefore });
        inject("write", guestPath);
        // As envd does: missing parents are created, and a file that exists keeps its mode.
        await mkdir(path.dirname(local(guestPath)), { recursive: true });
        await writeFile(local(guestPath), content);
      },
      read: async (guestPath) => {
        inject("read", guestPath);
        return new Uint8Array(await readFile(local(guestPath)));
      },
      kill: async () => {
        killed.push(id);
        if (failingKills.has(id)) {
          failingKills.delete(id);
          throw new Error(`cannot kill ${id}`);
        }
      },
      isGone: (error) => isSandboxGone(error, async () => listed.get(volumeRef) ?? false),
    };
  };
  return {
    files: new E2BVolumeFiles(open),
    opened,
    killed,
    dirs,
    uploads,
    failingKills,
    fail: (volumeRef: string, fault: Fault) => {
      faults.set(volumeRef, [...(faults.get(volumeRef) ?? []), fault]);
    },
    /** The control plane stops listing the volume's current sandbox. */
    unlist: (volumeRef: string) => listed.set(volumeRef, false),
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
    expect(killed.sort()).toEqual(["vol-a#1", "vol-b#1"]);
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

  it("stages a file at 0600 before its bytes land, and gives it its own mode only once whole", async () => {
    const { files, dirs, uploads } = await localVolumes();

    await files.write("vol", { path: "public.txt", content: text("p") }, context);
    await files.write("vol", { path: "key.txt", content: text("k"), mode: 0o600 }, context);

    expect(uploads.map((upload) => upload.modeBefore)).toEqual([0o600, 0o600]);
    expect((await stat(path.join(dirs.get("vol")!, "public.txt"))).mode & 0o777).toBe(0o644);
    expect((await readdir(dirs.get("vol")!)).sort()).toEqual(["key.txt", "public.txt"]);
  });

  it("removes the staged file when placing it fails, and when the write is cancelled", async () => {
    const { files, dirs, fail } = await localVolumes();
    fail("vol", { op: "run", match: "renameSync", error: () => new Error("node did not start") });

    await expect(
      files.write("vol", { path: "a.txt", content: text("a") }, context),
    ).rejects.toThrow("node did not start");

    const cancel = new AbortController();
    fail("vol", {
      op: "write",
      before: () => cancel.abort(),
      error: () => new DOMException("aborted", "AbortError"),
    });
    await expect(
      files.write(
        "vol",
        { path: "b.txt", content: text("b") },
        { ...context, signal: cancel.signal },
      ),
    ).rejects.toThrow("aborted");

    expect(await readdir(dirs.get("vol")!)).toEqual([]);
  });

  it("retries a write on a new sandbox, under a new staged name, when E2B killed the first mid-call", async () => {
    const { files, opened, dirs, uploads, unlist, fail } = await localVolumes();
    fail("vol", { op: "write", before: () => unlist("vol"), error: killedInFlight });

    await files.write("vol", { path: "kept.txt", content: text("kept") }, context);

    expect(opened).toEqual(["vol", "vol"]);
    expect(new Set(uploads.map((upload) => upload.path)).size).toBe(2);
    expect(await readdir(dirs.get("vol")!)).toEqual(["kept.txt"]);
  });

  it("fails an upload whose connection dropped, without a second sandbox, while the control plane still lists the first", async () => {
    const { files, opened, dirs, fail } = await localVolumes();
    fail("vol", { op: "write", error: killedInFlight });

    await expect(
      files.write("vol", { path: "kept.txt", content: text("kept") }, context),
    ).rejects.toThrow("killed or reached its end of life");

    expect(opened).toEqual(["vol"]);
    expect(await readdir(dirs.get("vol")!)).toEqual([]);
  });

  const deathSignals = [
    ["a missing sandbox", () => new SandboxNotFoundError("Sandbox vol#1 not found")],
    ["a 502", unreachable],
    ["a sandbox reported killed mid-request", killedInFlight],
  ] as const;

  it.each(deathSignals)(
    "replaces the sandbox on %s once the control plane no longer lists it",
    async (_name, error) => {
      const { files, opened, killed, unlist, fail } = await localVolumes();
      await files.write("vol", { path: "kept.txt", content: text("kept") }, context);
      unlist("vol");
      fail("vol", { op: "read", error });

      expect(new TextDecoder().decode(await files.read("vol", "kept.txt", context))).toBe("kept");
      expect(opened).toEqual(["vol", "vol"]);
      expect(killed).toEqual(["vol#1"]);
    },
  );

  it.each(deathSignals)(
    "keeps the sandbox, and fails the call, on %s while the control plane still lists it",
    async (_name, error) => {
      const { files, opened, killed, fail } = await localVolumes();
      await files.write("vol", { path: "kept.txt", content: text("kept") }, context);
      fail("vol", { op: "read", error });

      await expect(files.read("vol", "kept.txt", context)).rejects.toThrow();
      expect(new TextDecoder().decode(await files.read("vol", "kept.txt", context))).toBe("kept");
      expect(opened).toEqual(["vol"]);

      await files.close();
      expect(killed).toEqual(["vol#1"]);
    },
  );

  it("destroys at close a dead sandbox whose first destroy failed", async () => {
    const { files, killed, failingKills, unlist, fail } = await localVolumes();
    await files.write("vol", { path: "kept.txt", content: text("kept") }, context);
    failingKills.add("vol#1");
    unlist("vol");
    fail("vol", { op: "read", error: killedInFlight });

    await files.read("vol", "kept.txt", context);
    await files.close();

    expect(killed.sort()).toEqual(["vol#1", "vol#1", "vol#2"]);
  });

  it("waits for every sandbox's destruction, then reports the one it could not destroy", async () => {
    const { files, killed, failingKills } = await localVolumes();
    await files.write("vol-a", { path: "a.txt", content: text("a") }, context);
    await files.write("vol-b", { path: "b.txt", content: text("b") }, context);
    failingKills.add("vol-a#1");

    await expect(files.close()).rejects.toThrow("cannot kill vol-a#1");

    expect(killed.sort()).toEqual(["vol-a#1", "vol-b#1"]);
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
