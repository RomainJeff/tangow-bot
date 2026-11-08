import { Template } from "e2b";
import { expect, it, onTestFinished, vi } from "vitest";

it("publishes both version lookup and untagged creation after a successful build", async () => {
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
  let finishBuild: (() => void) | undefined;
  vi.spyOn(Template, "build").mockImplementation(
    () =>
      new Promise((resolve) => {
        finishBuild = () =>
          resolve({
            alias: "desktop",
            name: "desktop",
            templateId: "template",
            buildId: "build",
            tags: [],
          });
      }),
  );
  const publish = vi
    .spyOn(Template, "assignTags")
    .mockResolvedValue({ buildId: "build", tags: ["latest", "default"] });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const building = import("./build.js");
  await vi.waitFor(() => expect(finishBuild).toBeDefined());
  expect(publish).not.toHaveBeenCalled();
  finishBuild?.();
  await building;
  expect(publish).toHaveBeenCalledWith(expect.stringMatching(/^desktop:computer-[a-f0-9]{64}$/), [
    "latest",
    "default",
  ]);
});
