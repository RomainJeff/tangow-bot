/**
 * Skills v2 phase 3: marketplace plugins are installed on disk under
 * DATA_DIR/skills/marketplaces/<spaceId>/<marketplace>/plugins/<plugin>/skills/<slug>/ and
 * read back as read-only `mkt:` skills. Only `<plugin>/skills/**` is consumed (design Q5);
 * the DB row (SpaceMarketplace) is the lock, this module never touches it.
 *
 * Upstream plugins are not all flat: some declare their skills in `.claude-plugin/plugin.json`
 * and file them under `skills/<category>/<slug>/`. Both shapes are read; the installed tree
 * stays flat.
 *
 * A plugin either lives inside the marketplace repository (`source: "./x"`) or in a GitHub
 * repository of its own (`source: { source: "github" | "url", … }`), which index marketplaces
 * such as superpowers-marketplace use throughout. This module resolves the source; fetching an
 * external repository is the caller's job (see marketplaces.ts).
 */
import { lstatSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { marketplaceSkillKey, parseSkillMd } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { type GithubRepo, parseGithubRepoUrl } from "./github-tarball.js";

export const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_SKILL_MD_BYTES = 100_000;
/** A plugin can be a whole repository (`source: "./"`), so its tree needs its own ceiling. */
export const MAX_PLUGIN_TREE_BYTES = 50 * 1024 * 1024;
const IGNORED_PLUGIN_CONTENT = ["commands", "agents", "hooks", ".mcp.json"];
const MANIFEST_PATH = path.join(".claude-plugin", "marketplace.json");

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

/** Where a plugin's files come from. `local` is a path inside the marketplace repository. */
export type PluginSource =
  | { kind: "local"; path: string }
  | { kind: "github"; url: string; ref?: string };

export type MarketplacePlugin = {
  name: string;
  /** null when the source is neither a `./` path nor a public GitHub repository. */
  source: PluginSource | null;
  description?: string;
  supported: boolean;
};
export type MarketplaceManifest = { name: string; plugins: MarketplacePlugin[] };

function safeName(raw: string, what: string): string {
  const name = raw.trim().toLowerCase();
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid ${what} name "${raw}".`);
  return name;
}

const GithubSourceSchema = z.union([
  z.object({ source: z.literal("github"), repo: z.string(), ref: z.string().optional() }),
  z.object({ source: z.literal("url"), url: z.string(), ref: z.string().optional() }),
]);

/**
 * Relative `./` path, or a public GitHub repository (design Q6). Anything else — a git://
 * remote, a tarball URL, a local absolute path — is unsupported and returns null.
 */
function parsePluginSource(source: unknown): PluginSource | null {
  if (typeof source === "string") {
    const local = source.startsWith("./") && !source.split("/").includes("..");
    return local ? { kind: "local", path: source } : null;
  }
  const parsed = GithubSourceSchema.safeParse(source);
  if (!parsed.success) return null;
  const url =
    parsed.data.source === "github"
      ? `https://github.com/${parsed.data.repo}`
      : parsed.data.url.replace(/^git\+/, "");
  // parseGithubRepoUrl is the allowlist: it rejects every host but github.com.
  try {
    parseGithubRepoUrl(url);
  } catch {
    return null;
  }
  return { kind: "github", url, ref: parsed.data.ref };
}

/** Plugins whose source is neither a `./` path nor a public GitHub repository stay unsupported. */
function parseManifest(raw: string): MarketplaceManifest {
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
      const source = parsePluginSource(plugin.source);
      return {
        name: safeName(plugin.name, "plugin"),
        source,
        description: plugin.description,
        supported: source !== null,
      };
    }),
  };
}

/** Reads `.claude-plugin/marketplace.json` from an extracted checkout. */
export async function readMarketplaceManifest(checkoutDir: string): Promise<MarketplaceManifest> {
  const raw = await readFile(path.join(checkoutDir, MANIFEST_PATH), "utf8").catch(() => {
    throw new Error("Repository has no .claude-plugin/marketplace.json.");
  });
  return parseManifest(raw);
}

const PluginJsonSchema = z.object({ skills: z.array(z.string()).optional() });

function isInside(parent: string, child: string): boolean {
  const root = path.resolve(parent);
  return child === root || child.startsWith(root + path.sep);
}

/** `skills` from `.claude-plugin/plugin.json`, or null when the plugin ships no such list. */
async function declaredSkillDirs(pluginDir: string): Promise<string[] | null> {
  const file = path.join(pluginDir, ".claude-plugin", "plugin.json");
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) return null;
  let declared: string[] | undefined;
  try {
    declared = PluginJsonSchema.parse(JSON.parse(raw)).skills;
  } catch {
    throw new Error("plugin.json is invalid: expected { skills?: string[] }.");
  }
  if (!declared) return null;
  return declared.map((entry) => {
    const dir = path.resolve(pluginDir, entry);
    if (!isInside(pluginDir, dir)) throw new Error(`Skill path "${entry}" escapes the plugin.`);
    return dir;
  });
}

/**
 * `skills/<slug>/`, descending one level into `skills/<category>/<slug>/` for entries that hold
 * no SKILL.md of their own. Two levels is where every layout seen in the wild stops.
 */
async function scanSkillDirs(skillsDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await listDirs(skillsDir)) {
    const dir = path.join(skillsDir, name);
    if (await stat(path.join(dir, "SKILL.md")).catch(() => null)) {
      out.push(dir);
      continue;
    }
    for (const nested of await listDirs(dir)) out.push(path.join(dir, nested));
  }
  return out;
}

/** Roots `npx skills add` reads, in precedence order. */
// ponytail: .cursor/.codex/.opencode not seen in real repos yet; one line each when asked.
const SKILL_ROOTS = ["skills", ".claude/skills", ".agents/skills"];

export type DiscoveredSkill = { slug: string; relPath: string; description: string };

/** Description of the SKILL.md in `dir`; null when absent, invalid, oversized or `metadata.internal`. */
async function describeSkill(dir: string): Promise<string | null> {
  const file = path.join(dir, "SKILL.md");
  const size = (await stat(file).catch(() => null))?.size;
  if (size === undefined || size > MAX_SKILL_MD_BYTES) return null;
  const content = await readFile(file, "utf8").catch(() => null);
  if (content === null) return null;
  const parsed = parseSkillMd(content);
  if ("error" in parsed) return null;
  const meta = parsed.frontmatter.metadata;
  if (meta && typeof meta === "object" && (meta as Record<string, unknown>).internal === true) {
    return null;
  }
  return parsed.description;
}

/**
 * Skills of a repository without a marketplace manifest (skills.sh layout). A root SKILL.md
 * makes the whole repository one skill named `rootSlug`; otherwise every `<root>/<slug>/`
 * (one category level deep) that holds a valid SKILL.md. Unsafe names never reach here
 * (`listDirs` drops them); invalid frontmatter and `metadata.internal: true` are skipped without
 * entering `found`, so an invalid skill under an earlier root cannot shadow a valid one under a
 * later root. A slug seen under an earlier root shadows later ones, and an intra-root clash (two
 * categories holding the same skill name) keeps the first, silently.
 */
export async function discoverSkills(
  checkoutDir: string,
  rootSlug: string,
): Promise<DiscoveredSkill[]> {
  const root = await describeSkill(checkoutDir);
  if (root !== null) return [{ slug: rootSlug, relPath: "./", description: root }];
  const found = new Map<string, DiscoveredSkill>();
  for (const skillsRoot of SKILL_ROOTS) {
    for (const dir of await scanSkillDirs(path.join(checkoutDir, skillsRoot))) {
      const slug = path.basename(dir).toLowerCase();
      if (found.has(slug)) continue;
      const description = await describeSkill(dir);
      if (description === null) continue;
      found.set(slug, { slug, relPath: `./${path.relative(checkoutDir, dir)}`, description });
    }
  }
  return [...found.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export type MarketplaceKind = "marketplace" | "skills";
export type LoadedManifest = {
  manifest: MarketplaceManifest;
  kind: MarketplaceKind;
  /** File content to persist as the marketplace's manifest (real or synthesized). */
  raw: string;
};

/**
 * Phase 4: the real manifest when the repository ships one (it always wins), otherwise a
 * manifest synthesized from its SKILL.md files — one single-skill plugin per skill, named
 * `<owner>-<repo>`. The synthetic JSON goes through the same parser, so what gets written to
 * disk is exactly what `readMarketplaceManifest` reads back later.
 */
export async function loadOrSynthesizeManifest(
  checkoutDir: string,
  repo: GithubRepo,
): Promise<LoadedManifest> {
  const real = await readFile(path.join(checkoutDir, MANIFEST_PATH), "utf8").catch(() => null);
  if (real !== null) return { manifest: parseManifest(real), kind: "marketplace", raw: real };
  const skills = await discoverSkills(checkoutDir, repo.repo.toLowerCase());
  if (skills.length === 0) {
    throw new Error("Repository has neither .claude-plugin/marketplace.json nor any SKILL.md.");
  }
  const raw = JSON.stringify(
    {
      name: `${repo.owner}-${repo.repo}`,
      plugins: skills.map((s) => ({ name: s.slug, source: s.relPath, description: s.description })),
    },
    null,
    2,
  );
  return { manifest: parseManifest(raw), kind: "skills", raw };
}

/** Skill directories of a plugin, keyed by the flat slug they install as. */
async function resolveSkillDirs(
  pluginDir: string,
  pluginName: string,
): Promise<{ slug: string; dir: string }[]> {
  // A plugin that is itself a skill — skills.sh repositories, bare-skill plugins — installs as
  // one, unless plugin.json declares skills: an explicit list always wins over the root SKILL.md.
  const declared = await declaredSkillDirs(pluginDir);
  if (declared === null && (await stat(path.join(pluginDir, "SKILL.md")).catch(() => null))) {
    return [{ slug: pluginName, dir: pluginDir }];
  }
  const dirs = declared ?? (await scanSkillDirs(path.join(pluginDir, "skills")));
  const bySlug = new Map<string, string>();
  for (const dir of dirs) {
    const raw = path.basename(dir);
    const slug = raw.toLowerCase();
    if (!SAFE_NAME.test(slug)) throw new Error(`Invalid skill name "${raw}".`);
    const clash = bySlug.get(slug);
    if (clash !== undefined && clash !== dir) {
      throw new Error(`Skills "${clash}" and "${dir}" both install as "${slug}".`);
    }
    bySlug.set(slug, dir);
  }
  return [...bySlug]
    .map(([slug, dir]) => ({ slug, dir }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
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
 * Resolves a plugin's directory inside an extracted checkout. For a `github` source the
 * checkout is that repository and the plugin is its root; for a `local` source it is the
 * marketplace repository and the plugin is the declared subdirectory.
 */
export function pluginDirIn(checkoutDir: string, source: PluginSource): string {
  if (source.kind === "github") return path.resolve(checkoutDir);
  // `source: "./"` means the repository itself is the plugin, so equality is legal here.
  const dir = path.resolve(checkoutDir, source.path);
  if (!isInside(checkoutDir, dir)) throw new Error("Plugin source escapes the repository.");
  return dir;
}

/** The source of a plugin listed in the manifest, or a user-facing error. */
export function pluginSource(manifest: MarketplaceManifest, pluginName: string): PluginSource {
  const plugin = manifest.plugins.find((p) => p.name === pluginName);
  if (!plugin) throw new Error(`Plugin "${pluginName}" is not in the marketplace.`);
  if (!plugin.source) {
    throw new Error(
      `Plugin "${pluginName}" has an unsupported source (only repository paths and public GitHub repositories are supported).`,
    );
  }
  return plugin.source;
}

export async function installPluginFromCheckout(
  root: string,
  marketplace: string,
  checkoutDir: string,
  manifest: MarketplaceManifest,
  pluginName: string,
): Promise<void> {
  const source = pluginSource(manifest, pluginName);
  await installPluginTree(root, marketplace, pluginName, pluginDirIn(checkoutDir, source));
}

/** Sum of regular-file sizes under `dir`. Symlinks are not files here, so they are skipped. */
async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await treeBytes(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

/**
 * Copies each skill directory into `<root>/<marketplace>/plugins/<plugin>/skills/<slug>/`
 * (slug lowercased, tree flattened). Validates everything before touching the root, so a
 * rejected plugin leaves the previous install intact.
 */
export async function installPluginTree(
  root: string,
  marketplace: string,
  pluginName: string,
  pluginDir: string,
  options: { maxBytes?: number } = {},
): Promise<void> {
  const skills = await resolveSkillDirs(pluginDir, pluginName);
  if (skills.length === 0) throw new Error(`Plugin "${pluginName}" has no skills/ directory.`);
  for (const { slug, dir } of skills) {
    const size = (await stat(path.join(dir, "SKILL.md")).catch(() => null))?.size;
    if (size === undefined) throw new Error(`Skill "${slug}" has no SKILL.md.`);
    if (size > MAX_SKILL_MD_BYTES) {
      throw new Error(
        `Skill "${slug}" SKILL.md exceeds ${MAX_SKILL_MD_BYTES} bytes; plugin rejected.`,
      );
    }
  }
  // The tarball cap counts compressed bytes; a whole-repository plugin expands past it.
  const maxBytes = options.maxBytes ?? MAX_PLUGIN_TREE_BYTES;
  let bytes = 0;
  for (const { dir } of skills) bytes += await treeBytes(dir);
  if (bytes > maxBytes) {
    throw new Error(`Plugin "${pluginName}" exceeds ${maxBytes} bytes; plugin rejected.`);
  }
  for (const ignored of IGNORED_PLUGIN_CONTENT) {
    if (await stat(path.join(pluginDir, ignored)).catch(() => null)) {
      getLogger().info(`[skills] ${marketplace}/${pluginName}: ignoring ${ignored} (skills only)`);
    }
  }
  const target = path.join(root, marketplace, "plugins", pluginName, "skills");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const { slug, dir } of skills) {
    await cp(dir, path.join(target, slug), {
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
  // Never installed under such a name (see parseManifest), so nothing to remove — and no path escape.
  if (!SAFE_NAME.test(plugin)) return;
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

// ponytail: whole tree in memory; installPluginTree caps a plugin at MAX_PLUGIN_TREE_BYTES.
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
