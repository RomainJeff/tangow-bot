/**
 * Skills v2 phase 3: marketplace plugins are installed on disk under
 * DATA_DIR/skills/marketplaces/<spaceId>/<marketplace>/plugins/<plugin>/skills/<slug>/ and
 * read back as read-only `mkt:` skills. Only `<plugin>/skills/**` is consumed (design Q5);
 * the DB row (SpaceMarketplace) is the lock, this module never touches it.
 */
import { lstatSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { marketplaceSkillKey, parseSkillMd } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";

export const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_SKILL_MD_BYTES = 100_000;
const IGNORED_PLUGIN_CONTENT = ["commands", "agents", "hooks", ".mcp.json"];

export function marketplacesRoot(dataDir: string, spaceId: string): string {
  return path.join(dataDir, "skills", "marketplaces", spaceId);
}

const ManifestSchema = z.object({
  name: z.string().min(1),
  plugins: z
    .array(
      z.object({
        name: z.string().min(1),
        source: z.unknown(),
        description: z.string().optional(),
      }),
    )
    .default([]),
});

export type MarketplacePlugin = {
  name: string;
  /** Relative `./…` path inside the repository, null when the source is unsupported. */
  source: string | null;
  description?: string;
  supported: boolean;
};
export type MarketplaceManifest = { name: string; plugins: MarketplacePlugin[] };

function safeName(raw: string, what: string): string {
  const name = raw.trim().toLowerCase();
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid ${what} name "${raw}".`);
  return name;
}

/**
 * Reads `.claude-plugin/marketplace.json` from an extracted checkout. Only relative `./`
 * sources are installable (design Q6); others are listed but flagged unsupported.
 */
export async function readMarketplaceManifest(checkoutDir: string): Promise<MarketplaceManifest> {
  const file = path.join(checkoutDir, ".claude-plugin", "marketplace.json");
  const raw = await readFile(file, "utf8").catch(() => {
    throw new Error("Repository has no .claude-plugin/marketplace.json.");
  });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("marketplace.json is invalid JSON.");
  }
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("marketplace.json is invalid: expected { name, plugins: [{ name, source }] }.");
  }
  return {
    name: safeName(parsed.data.name, "marketplace"),
    plugins: parsed.data.plugins.map((plugin) => {
      const source = plugin.source;
      const relative =
        typeof source === "string" && source.startsWith("./") && !source.split("/").includes("..");
      return {
        name: safeName(plugin.name, "plugin"),
        source: relative ? source : null,
        description: plugin.description,
        supported: relative,
      };
    }),
  };
}

export type MarketplaceSkillFile = {
  id: string;
  marketplace: string;
  plugin: string;
  slug: string;
  name: string;
  description: string;
  content: string;
  source: "plugin";
  readOnly: true;
  updatedAt: Date;
};

async function listDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && SAFE_NAME.test(entry.name.toLowerCase()))
    .map((entry) => entry.name)
    .sort();
}

export async function listMarketplaceSkills(root: string): Promise<MarketplaceSkillFile[]> {
  const out: MarketplaceSkillFile[] = [];
  for (const marketplace of await listDirs(root)) {
    for (const plugin of await listDirs(path.join(root, marketplace, "plugins"))) {
      const skillsDir = path.join(root, marketplace, "plugins", plugin, "skills");
      for (const slug of await listDirs(skillsDir)) {
        const file = path.join(skillsDir, slug, "SKILL.md");
        const content = await readFile(file, "utf8").catch(() => null);
        if (content === null) continue;
        const parsed = parseSkillMd(content);
        if ("error" in parsed) {
          getLogger().warn(`[skills] ignoring marketplace ${file}: ${parsed.error}`);
          continue;
        }
        out.push({
          id: marketplaceSkillKey(marketplace, plugin, slug),
          marketplace,
          plugin,
          slug,
          name: parsed.name,
          description: parsed.description,
          content,
          source: "plugin",
          readOnly: true,
          updatedAt: (await stat(file)).mtime,
        });
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Copies `<source>/skills/<slug>/**` into `<root>/<marketplace>/plugins/<plugin>/skills/<slug>/`
 * (slug lowercased). Validates everything before touching the root, so a rejected plugin
 * leaves the previous install intact.
 */
export async function installPluginFromCheckout(
  root: string,
  marketplace: string,
  checkoutDir: string,
  manifest: MarketplaceManifest,
  pluginName: string,
): Promise<void> {
  const plugin = manifest.plugins.find((p) => p.name === pluginName);
  if (!plugin) throw new Error(`Plugin "${pluginName}" is not in the marketplace.`);
  if (!plugin.source) {
    throw new Error(
      `Plugin "${pluginName}" has an unsupported source (only paths inside the repository are supported).`,
    );
  }
  const pluginDir = path.resolve(checkoutDir, plugin.source);
  if (!pluginDir.startsWith(path.resolve(checkoutDir) + path.sep)) {
    throw new Error("Plugin source escapes the repository.");
  }
  const skillsDir = path.join(pluginDir, "skills");
  const slugs = await listDirs(skillsDir);
  if (slugs.length === 0) throw new Error(`Plugin "${pluginName}" has no skills/ directory.`);
  for (const slug of slugs) {
    const size = (await stat(path.join(skillsDir, slug, "SKILL.md")).catch(() => null))?.size;
    if (size === undefined) throw new Error(`Skill "${slug}" has no SKILL.md.`);
    if (size > MAX_SKILL_MD_BYTES) {
      throw new Error(
        `Skill "${slug}" SKILL.md exceeds ${MAX_SKILL_MD_BYTES} bytes; plugin rejected.`,
      );
    }
  }
  for (const ignored of IGNORED_PLUGIN_CONTENT) {
    if (await stat(path.join(pluginDir, ignored)).catch(() => null)) {
      getLogger().info(`[skills] ${marketplace}/${pluginName}: ignoring ${ignored} (skills only)`);
    }
  }
  const target = path.join(root, marketplace, "plugins", pluginName, "skills");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const slug of slugs) {
    await cp(path.join(skillsDir, slug), path.join(target, slug.toLowerCase()), {
      recursive: true,
      dereference: false,
      // ponytail: the tarball extractor already drops symlinks; belt and braces for other checkouts.
      filter: (src) => !lstatSync(src).isSymbolicLink(),
    });
  }
}

export async function removeInstalledPlugin(
  root: string,
  marketplace: string,
  plugin: string,
): Promise<void> {
  await rm(path.join(root, marketplace, "plugins", plugin), { recursive: true, force: true });
}

export type FileChange = {
  path: string;
  status: "added" | "removed" | "modified";
  sizeBefore?: number;
  sizeAfter?: number;
  /** Text content, only when <= 100k and not binary. */
  before?: string;
  after?: string;
};

/** Recursive file-level diff between two skills/ trees. Paths are relative and sorted. */
export async function diffPluginTrees(beforeDir: string, afterDir: string): Promise<FileChange[]> {
  const [before, after] = await Promise.all([walk(beforeDir), walk(afterDir)]);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: FileChange[] = [];
  for (const rel of paths) {
    const a = before.get(rel);
    const b = after.get(rel);
    if (a && b && a.equals(b)) continue;
    changes.push({
      path: rel,
      status: !a ? "added" : !b ? "removed" : "modified",
      sizeBefore: a?.length,
      sizeAfter: b?.length,
      before: a ? asText(a) : undefined,
      after: b ? asText(b) : undefined,
    });
  }
  return changes;
}

// ponytail: whole tree in memory; skills are capped at 100k per SKILL.md so this stays small.
async function walk(dir: string, prefix = ""): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [k, v] of await walk(path.join(dir, entry.name), rel)) out.set(k, v);
    } else if (entry.isFile()) {
      out.set(rel, await readFile(path.join(dir, entry.name)));
    }
  }
  return out;
}

function asText(buffer: Buffer): string | undefined {
  if (buffer.length > MAX_SKILL_MD_BYTES || buffer.includes(0)) return undefined;
  return buffer.toString("utf8");
}
