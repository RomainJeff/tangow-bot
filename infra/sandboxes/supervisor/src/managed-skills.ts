import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "@rakazo/logging";

export const MANAGED_SKILL_FAMILIES = ["agent", "computer"] as const;

/**
 * Copies `<repoRoot>/skills/<family>/<slug>` into `<dataDir>/managed-skills/<family>/<slug>`.
 * Each slug is staged in `.tmp-<slug>` then renamed so a computer reading the mount never sees a
 * half-written skill. The family dirs themselves are never renamed: they are bind-mounted and the
 * mounted inode must stay stable. Slugs no longer in the repo are removed. Never throws: a
 * missing or unreadable source only logs a warning.
 */
export async function syncManagedSkills(repoRoot: string, dataDir: string, logger: Logger) {
  for (const family of MANAGED_SKILL_FAMILIES) {
    const source = path.join(repoRoot, "skills", family);
    const target = path.join(dataDir, "managed-skills", family);
    try {
      await mkdir(target, { recursive: true });
      const existing = await readdir(target);
      await Promise.all(
        existing
          .filter((e) => e.startsWith(".tmp-"))
          .map((e) => rm(path.join(target, e), { recursive: true, force: true })),
      );
      const slugs = (await readdir(source, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      for (const slug of slugs) {
        const tmp = path.join(target, `.tmp-${slug}`);
        await cp(path.join(source, slug), tmp, { recursive: true });
        await rm(path.join(target, slug), { recursive: true, force: true });
        await rename(tmp, path.join(target, slug));
      }
      for (const stale of existing.filter((e) => !e.startsWith(".tmp-") && !slugs.includes(e))) {
        await rm(path.join(target, stale), { recursive: true, force: true });
      }
    } catch (error) {
      logger.warn("managed skills sync failed", { family, error: String(error) });
    }
  }
}
