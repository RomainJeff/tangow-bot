import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext, PortableFile, VolumeFiles } from "@rakazo/adapter-kit";
import { parseSkillMd } from "@rakazo/core";
import { hasCode, skillDirName } from "./skill-store.js";

type MigrationEvent = {
  kind: "skipped" | "merged" | "conflict" | "copied" | "unchanged";
  source: string;
  skill?: string;
  reason?: string;
};

/**
 * Copy independent bundles; leave every conflicting bundle for manual resolution. `user` limits
 * the copy to one person's directory.
 */
export async function migrateUserSkillsToShared(
  options: {
    source: string;
    volumeRef: string;
    files: VolumeFiles;
    dryRun?: boolean;
    user?: string;
  },
  context: AdapterContext,
) {
  const events: MigrationEvent[] = [];
  const users = await readdir(options.source, { withFileTypes: true }).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  });
  const bundles = new Map<string, { source: string; files: PortableFile[] }>();
  const conflicts = new Set<string>();
  const walk = async (dir: string, target: string, files: PortableFile[]): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const destination = `${target}/${entry.name}`;
      if (entry.isDirectory()) await walk(file, destination, files);
      else {
        const info = await lstat(file);
        if (!info.isFile()) throw new Error("linked or special file");
        files.push({
          path: destination,
          content: await readFile(file),
          mode: info.mode & 0o777,
          executable: Boolean(info.mode & 0o111),
        });
      }
    }
  };
  for (const user of users.sort((a, b) => a.name.localeCompare(b.name))) {
    if (options.user !== undefined && user.name !== options.user) continue;
    if (!user.isDirectory() || user.name.startsWith(".")) {
      events.push({ kind: "skipped", source: user.name, reason: "not a visible owner directory" });
      continue;
    }
    const owner = path.join(options.source, user.name);
    for (const entry of (await readdir(owner, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const source = `${user.name}/${entry.name}`;
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        events.push({
          kind: "skipped",
          source,
          reason: entry.name.startsWith(".") ? "hidden directory" : "not a plain directory",
        });
        continue;
      }
      const dir = path.join(owner, entry.name);
      const skillFile = path.join(dir, "SKILL.md");
      const info = await lstat(skillFile).catch(() => null);
      if (!info?.isFile() || info.size > 400_000) {
        events.push({ kind: "skipped", source, reason: "missing, linked or oversized SKILL.md" });
        continue;
      }
      const parsed = parseSkillMd(await readFile(skillFile, "utf8"));
      if ("error" in parsed) {
        events.push({ kind: "skipped", source, reason: "invalid SKILL.md" });
        continue;
      }
      const skill = skillDirName(parsed.name);
      const files: PortableFile[] = [];
      try {
        await walk(dir, `skills/${skill}`, files);
      } catch (error) {
        events.push({
          kind: "skipped",
          source,
          skill,
          reason: error instanceof Error ? error.message : "unreadable bundle",
        });
        continue;
      }
      const prior = bundles.get(skill);
      if (prior) {
        const same =
          prior.files.length === files.length &&
          files.every((file) => {
            const previous = prior.files.find((item) => item.path === file.path);
            return (
              previous !== undefined &&
              previous.mode === file.mode &&
              Buffer.from(previous.content).equals(Buffer.from(file.content))
            );
          });
        events.push({
          kind: same ? "merged" : "conflict",
          source,
          skill,
          reason: same ? "identical bundle" : `differs from ${prior.source}`,
        });
        if (!same) conflicts.add(skill);
      } else bundles.set(skill, { source, files });
    }
  }
  const existing = new Map(
    (await options.files.list(options.volumeRef, context)).map((entry) => [entry.path, entry]),
  );
  const missing: PortableFile[] = [];
  let planned = 0;
  for (const [skill, bundle] of bundles) {
    if (conflicts.has(skill)) continue;
    const additions: PortableFile[] = [];
    let conflict = false;
    const paths = new Set(bundle.files.map((file) => file.path));
    // Extra target files make a different bundle even if SKILL.md matches.
    if (
      [...existing.values()].some(
        (file) =>
          file.path.startsWith(`skills/${skill}/`) && file.kind !== "dir" && !paths.has(file.path),
      )
    )
      conflict = true;
    for (const file of bundle.files) {
      const segments = file.path.split("/");
      for (let count = 1; count < segments.length; count++) {
        const parent = existing.get(segments.slice(0, count).join("/"));
        if (parent && parent.kind !== "dir") conflict = true;
      }
      const found = existing.get(file.path);
      if (!found) additions.push(file);
      else if (
        found.kind !== "file" ||
        found.mode !== file.mode ||
        !Buffer.from(await options.files.read(options.volumeRef, file.path, context)).equals(
          Buffer.from(file.content),
        )
      )
        conflict = true;
    }
    if (conflict) {
      events.push({
        kind: "conflict",
        source: bundle.source,
        skill,
        reason: "shared bundle differs; resolve manually",
      });
      continue;
    }
    planned += bundle.files.length;
    missing.push(...additions);
    events.push({
      kind: additions.length ? "copied" : "unchanged",
      source: bundle.source,
      skill,
      ...(options.dryRun && additions.length ? { reason: "dry run; copy planned" } : {}),
    });
  }
  if (!options.dryRun) {
    for (const file of missing) {
      context.signal.throwIfAborted();
      await options.files.write(options.volumeRef, file, context);
      if (
        !Buffer.from(await options.files.read(options.volumeRef, file.path, context)).equals(
          Buffer.from(file.content),
        )
      )
        throw new Error("Skill migration copy verification failed");
    }
  }
  return {
    planned,
    copied: options.dryRun ? 0 : missing.length,
    unchanged: planned - missing.length,
    events,
  };
}
