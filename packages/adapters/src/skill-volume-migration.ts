import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext, PortableFile, VolumeFiles } from "@rakazo/adapter-kit";
import { hasCode, skillDirName } from "./skill-store.js";
import { discoverVolumeSkills } from "./volume-skills.js";

/** Copy every owner's existing skills into the space's shared volume. Never replace a differing file. */
export async function migrateUserSkillsToShared(
  options: { source: string; volumeRef: string; files: VolumeFiles; dryRun?: boolean },
  context: AdapterContext,
) {
  const users = await readdir(options.source, { withFileTypes: true }).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  });
  const planned = new Map<string, PortableFile>();
  const walk = async (dir: string, target: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const destination = `${target}/${entry.name}`;
      if (entry.isDirectory()) await walk(file, destination);
      else {
        const info = await lstat(file);
        if (!info.isFile()) throw new Error("Skill migration refuses linked or special files");
        const content = await readFile(file);
        const prior = planned.get(destination);
        if (
          prior &&
          (prior.mode !== (info.mode & 0o777) || !Buffer.from(prior.content).equals(content))
        )
          throw new Error("Skill migration found conflicting owner skills");
        planned.set(destination, {
          path: destination,
          content,
          mode: info.mode & 0o777,
          executable: Boolean(info.mode & 0o111),
        });
      }
    }
  };
  for (const user of users.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!user.isDirectory()) continue;
    const { skills } = await discoverVolumeSkills([
      { source: "shared", path: path.join(options.source, user.name) },
    ]);
    for (const skill of skills)
      await walk(path.dirname(skill.path), `skills/${skillDirName(skill.name)}`);
  }
  const existing = new Map(
    (await options.files.list(options.volumeRef, context)).map((entry) => [entry.path, entry]),
  );
  const missing: PortableFile[] = [];
  for (const file of planned.values()) {
    const segments = file.path.split("/");
    for (let count = 1; count < segments.length; count++) {
      const parent = existing.get(segments.slice(0, count).join("/"));
      if (parent && parent.kind !== "dir")
        throw new Error("Skill migration refuses a non-directory target ancestor");
    }
    const found = existing.get(file.path);
    if (!found) {
      missing.push(file);
      continue;
    }
    if (
      found.kind !== "file" ||
      found.mode !== file.mode ||
      !Buffer.from(await options.files.read(options.volumeRef, file.path, context)).equals(
        Buffer.from(file.content),
      )
    ) {
      throw new Error("Skill migration refuses to overwrite a changed shared file");
    }
  }
  if (!options.dryRun) {
    for (const file of missing) {
      context.signal.throwIfAborted();
      await options.files.write(options.volumeRef, file, context);
      if (
        !Buffer.from(await options.files.read(options.volumeRef, file.path, context)).equals(
          Buffer.from(file.content),
        )
      ) {
        throw new Error("Skill migration copy verification failed");
      }
    }
  }
  return {
    planned: planned.size,
    copied: options.dryRun ? 0 : missing.length,
    unchanged: planned.size - missing.length,
  };
}
