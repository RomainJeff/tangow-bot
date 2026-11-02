import { beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "./api";
import { mobileArtifactImageUri } from "./artifact-open";

const files = vi.hoisted(() => ({ existing: new Map<string, number>() }));

vi.mock("expo-file-system", () => ({
  Paths: { cache: "cache" },
  File: class {
    uri: string;
    constructor(
      dir: string,
      public name: string,
    ) {
      this.uri = `file://${dir}/${name}`;
    }
    get exists() {
      return files.existing.has(this.name);
    }
    get size() {
      return files.existing.get(this.name) ?? 0;
    }
    create() {}
    write() {
      files.existing.set(this.name, 3);
    }
  },
}));
vi.mock("expo-sharing", () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./i18n", () => ({ t: (text: string) => text }));

const target = { botId: "bot-1" };

describe("mobileArtifactImageUri", () => {
  beforeEach(() => {
    files.existing.clear();
    vi.mocked(rpc).mockReset();
    vi.mocked(rpc).mockResolvedValue({ contentBase64: "AAAA" } as never);
  });

  it("downloads once for two loads of the same artifact at the same time", async () => {
    const [first, second] = await Promise.all([
      mobileArtifactImageUri(target, "art-1", "image/png"),
      mobileArtifactImageUri(target, "art-1", "image/png"),
    ]);

    expect(first).toBe("file://cache/art-1.png");
    expect(second).toBe("file://cache/art-1.png");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("reuses a non-empty cached file without fetching", async () => {
    files.existing.set("art-2.png", 10);

    expect(await mobileArtifactImageUri(target, "art-2", "image/png")).toBe(
      "file://cache/art-2.png",
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fetches again when the cached file is empty", async () => {
    files.existing.set("art-3.png", 0);

    await mobileArtifactImageUri(target, "art-3", "image/png");

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("skips the cache when asked to refetch", async () => {
    files.existing.set("art-4.png", 10);

    await mobileArtifactImageUri(target, "art-4", "image/png", true);

    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
