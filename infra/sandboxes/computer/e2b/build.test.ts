import { Template } from "e2b";
import { expect, it, onTestFinished, vi } from "vitest";

it("does not publish a failed computer build as latest", async () => {
  const originalArgv = process.argv;
  process.argv = [
    process.execPath,
    "build.ts",
    "--image",
    `registry.test/computer@sha256:${"a".repeat(64)}`,
  ];
  onTestFinished(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });
  const failure = new Error("build failed");
  const build = vi.spyOn(Template, "build").mockRejectedValue(failure);
  const publish = vi.spyOn(Template, "assignTags");
  await expect(import("./build.js")).rejects.toBe(failure);
  expect(build).toHaveBeenCalledWith(
    expect.anything(),
    expect.stringMatching(/^desktop:computer-[a-f0-9]{64}$/),
    expect.not.objectContaining({ tags: expect.arrayContaining(["latest"]) }),
  );
  expect(publish).not.toHaveBeenCalled();
});
