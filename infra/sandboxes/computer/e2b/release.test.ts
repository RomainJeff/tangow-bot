import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Template } from "e2b";
import { expect, it, onTestFinished } from "vitest";
import { computerReleaseRef } from "./release.js";
import { COMPUTER_PROFILE, computerTemplate } from "./template.js";

it("versions only the computer image, effective template, profile and embedded files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "computer-release-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "skills/agent"), { recursive: true });
  await mkdir(path.join(root, "skills/computer"));
  const skill = path.join(root, "skills/computer/example.md");
  await writeFile(skill, "original skill");
  const image = `registry.test/computer@sha256:${"a".repeat(64)}`;
  const template = computerTemplate(image);
  const ref = await computerReleaseRef(template, COMPUTER_PROFILE, root);
  expect(ref).toMatch(/^computer-[a-f0-9]{64}$/);
  await writeFile(path.join(root, "README.md"), "unrelated main commit");
  await utimes(skill, new Date(0), new Date(0));
  expect(await computerReleaseRef(template, COMPUTER_PROFILE, root)).toBe(ref);

  await writeFile(skill, "changed skill");
  expect(await computerReleaseRef(template, COMPUTER_PROFILE, root)).not.toBe(ref);
  await writeFile(skill, "original skill");
  await chmod(skill, 0o600);
  expect(await computerReleaseRef(template, COMPUTER_PROFILE, root)).toBe(ref);
  const newerImage = computerTemplate(image.replace("a".repeat(64), "b".repeat(64)));
  expect(await computerReleaseRef(newerImage, COMPUTER_PROFILE, root)).not.toBe(ref);
  expect(await computerReleaseRef(template, { ...COMPUTER_PROFILE, cpuCount: 4 }, root)).not.toBe(
    ref,
  );
  expect(
    await computerReleaseRef(
      Template().fromImage(image).setEnvs({ EXTRA: "changed" }),
      COMPUTER_PROFILE,
      root,
    ),
  ).not.toBe(ref);
});
