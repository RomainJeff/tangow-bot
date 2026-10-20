import { describe, expect, it, vi } from "vitest";
import { E2BVolumeFiles } from "./e2b-volume-files.js";

type Written = { path: string; uid?: number; gid?: number; mode?: number };

const volume = vi.hoisted(() => {
  const entries = new Map<
    string,
    { type: "file" | "directory"; mode: number; content?: Uint8Array }
  >();
  const writes: Written[] = [];
  const named = [{ volumeId: "vol-1", name: "rakazo-volume_1" }];
  return { entries, writes, named };
});

vi.mock("@e2b/desktop", () => {
  const stat = (path: string) => {
    const entry = volume.entries.get(path);
    if (!entry) throw new Error(`missing ${path}`);
    return { name: path.split("/").at(-1), path, type: entry.type, mode: entry.mode };
  };
  const remote = {
    async list(directory: string) {
      const prefix = directory === "/" ? "/" : `${directory}/`;
      return [...volume.entries.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .map(stat);
    },
    async makeDir(path: string, opts: { uid: number; gid: number; mode: number }) {
      volume.writes.push({ path, uid: opts.uid, gid: opts.gid, mode: opts.mode });
      volume.entries.set(path, { type: "directory", mode: 0o40000 | opts.mode });
      return stat(path);
    },
    async writeFile(
      path: string,
      data: ArrayBuffer,
      opts: { uid: number; gid: number; mode: number },
    ) {
      volume.writes.push({ path, uid: opts.uid, gid: opts.gid, mode: opts.mode });
      volume.entries.set(path, {
        type: "file",
        mode: 0o100000 | opts.mode,
        content: new Uint8Array(data),
      });
      return stat(path);
    },
    async readFile(path: string) {
      return volume.entries.get(path)?.content ?? new Uint8Array();
    },
  };
  return {
    VolumeFileType: {
      FILE: "file",
      DIRECTORY: "directory",
      SYMLINK: "symlink",
      UNKNOWN: "unknown",
    },
    Volume: {
      list: async () => volume.named,
      connect: async (volumeId: string) => {
        if (volumeId !== "vol-1") throw new Error(`unknown volume ${volumeId}`);
        return remote;
      },
    },
  };
});

const context = {
  operationId: "e2b-volume-test",
  traceId: "e2b-volume-test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

describe("E2B volume files", () => {
  it("writes files owned by the guest user under created parents, and lists them back by relative path", async () => {
    const files = new E2BVolumeFiles({ owner: { uid: 1001, gid: 1002 } });

    await files.write(
      "rakazo-volume_1",
      { path: "bin/tools/run.sh", content: new TextEncoder().encode("echo"), executable: true },
      context,
    );
    await files.write(
      "rakazo-volume_1",
      { path: "bin/notes.md", content: new TextEncoder().encode("hi") },
      context,
    );
    await files.write(
      "rakazo-volume_1",
      { path: "bin/secret", content: new TextEncoder().encode("key"), mode: 0o600 },
      context,
    );

    expect(volume.writes).toEqual([
      { path: "/bin", uid: 1001, gid: 1002, mode: 0o755 },
      { path: "/bin/tools", uid: 1001, gid: 1002, mode: 0o755 },
      { path: "/bin/tools/run.sh", uid: 1001, gid: 1002, mode: 0o755 },
      { path: "/bin/notes.md", uid: 1001, gid: 1002, mode: 0o644 },
      { path: "/bin/secret", uid: 1001, gid: 1002, mode: 0o600 },
    ]);
    expect(await files.list("rakazo-volume_1", context)).toEqual([
      { path: "bin", kind: "dir", mode: 0o755 },
      { path: "bin/tools", kind: "dir", mode: 0o755 },
      { path: "bin/tools/run.sh", kind: "file", mode: 0o755 },
      { path: "bin/notes.md", kind: "file", mode: 0o644 },
      { path: "bin/secret", kind: "file", mode: 0o600 },
    ]);
    expect(
      new TextDecoder().decode(await files.read("rakazo-volume_1", "bin/notes.md", context)),
    ).toBe("hi");
  });

  it("refuses a volume name that E2B does not know or knows twice", async () => {
    volume.named.push({ volumeId: "vol-2", name: "rakazo-twice" });
    volume.named.push({ volumeId: "vol-3", name: "rakazo-twice" });

    await expect(new E2BVolumeFiles().list("rakazo-missing", context)).rejects.toThrow(
      "0 E2B volumes are named rakazo-missing, expected exactly one",
    );
    await expect(new E2BVolumeFiles().list("rakazo-twice", context)).rejects.toThrow(
      "2 E2B volumes are named rakazo-twice, expected exactly one",
    );
  });

  it.each(["../escape", "a//b", "a/./b", "a\\b", "/abs", "a/"])(
    "refuses to write or read the path %j",
    async (path) => {
      const files = new E2BVolumeFiles();
      const before = volume.writes.length;

      await expect(
        files.write("rakazo-volume_1", { path, content: new Uint8Array() }, context),
      ).rejects.toThrow("Refusing the volume path");
      await expect(files.read("rakazo-volume_1", path, context)).rejects.toThrow(
        "Refusing the volume path",
      );
      expect(volume.writes.length).toBe(before);
    },
  );
});
