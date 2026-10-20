import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { piResources, piSkillInstructions } from "./pi-resources.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it("loads exactly the explicit skills and controller context, ignoring ambient files and extensions", async () => {
  root = await mkdtemp(path.join(tmpdir(), "pi-skills-"));
  const cwd = path.join(root, "repo");
  const skillsDir = path.join(root, ".agents", "skills");
  const content = (name: string) =>
    `---\nname: ${name}\ndescription: Use ${name}\n---\nRead only when needed.\n`;
  for (const [dir, name] of [
    [path.join(skillsDir, "visible"), "visible"],
    [path.join(cwd, ".pi", "skills", "ambient"), "ambient"],
    [path.join(root, ".pi", "agent", "skills", "global"), "global"],
  ]) {
    await mkdir(dir!, { recursive: true });
    await writeFile(path.join(dir!, "SKILL.md"), content(name!));
  }
  await writeFile(path.join(cwd, "AGENTS.md"), "ambient instructions must never appear");
  await writeFile(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify({ skills: [path.join(cwd, ".pi", "skills")], extensions: ["./danger.ts"] }),
  );
  await writeFile(
    path.join(cwd, ".pi", "danger.ts"),
    'throw new Error("ambient extension was loaded")',
  );
  const loader = piResources(cwd, skillsDir, "controller context");
  await loader.reload();
  expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["visible"]);
  expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
  expect(loader.getExtensions().extensions).toEqual([]);
  expect(loader.getPrompts().prompts).toEqual([]);
  const prompt = piSkillInstructions(loader);
  expect(prompt).toContain("controller context");
  expect(prompt).toContain("<name>visible</name>");
  expect(prompt).toContain(path.join(skillsDir, "visible", "SKILL.md"));
  expect(prompt).not.toContain("ambient");
});
