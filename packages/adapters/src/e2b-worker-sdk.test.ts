import { describe, expect, it, vi } from "vitest";

const volumes = vi.hoisted(() => ({
  listed: [
    { volumeId: "vol_9f2", name: "rakazo-volume_a" },
    { volumeId: "vol_4c1", name: "rakazo-volume_b" },
  ],
  destroyed: [] as string[],
}));

vi.mock("e2b", () => ({
  CommandExitError: class extends Error {},
  Sandbox: {},
  Volume: {
    list: async () => volumes.listed,
    destroy: async (volumeId: string) => {
      volumes.destroyed.push(volumeId);
      return true;
    },
  },
}));

const { e2bWorkerSdk } = await import("./e2b-worker.js");

describe("the E2B worker binding", () => {
  it("deletes a volume known by its name through the id E2B gave it", async () => {
    const sdk = e2bWorkerSdk({ apiKey: "e2b-test-key" });

    expect(await sdk.destroyVolume("rakazo-volume_b")).toBe(true);
    expect(await sdk.destroyVolume("rakazo-volume_gone")).toBe(false);
    expect(volumes.destroyed).toEqual(["vol_4c1"]);
  });
});
