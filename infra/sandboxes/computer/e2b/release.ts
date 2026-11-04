import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import type { TemplateClass } from "e2b";
import { Template } from "e2b";

/** Hash the environment's build instructions and copied files, never the checkout revision. */
export async function computerReleaseRef(
  template: TemplateClass,
  profile: { cpuCount: number; memoryMB: number },
  contextPath: string,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([await Template.toJSON(template, false), profile]));
  async function visit(relative: string): Promise<void> {
    const absolute = path.join(contextPath, relative);
    const stat = await lstat(absolute);
    if (stat.isDirectory()) {
      hash.update(JSON.stringify([relative, "directory"]));
      for (const name of (await readdir(absolute)).sort()) await visit(`${relative}/${name}`);
    } else if (stat.isSymbolicLink()) {
      hash.update(JSON.stringify([relative, "link", await readlink(absolute)]));
    } else if (stat.isFile()) {
      hash.update(JSON.stringify([relative, "file", Boolean(stat.mode & 0o111), stat.size]));
      hash.update(await readFile(absolute));
    } else {
      throw new Error(`Unsupported computer build input: ${relative}`);
    }
  }
  await visit("skills/agent");
  await visit("skills/computer");
  return `computer-${hash.digest("hex")}`;
}
