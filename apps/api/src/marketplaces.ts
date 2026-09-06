/**
 * Skills v2 phase 3: `marketplaces.*` — GitHub marketplaces added at space level. The
 * SpaceMarketplace row is the lock (url, ref, pinned commit, installed plugins); the files live
 * under DATA_DIR/skills/marketplaces/<spaceId>/<marketplace>/ (see marketplace-store.ts).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ORPCError } from "@orpc/server";
import {
  createSafeRemoteFetch,
  diffPluginTrees,
  downloadGithubTarball,
  installPluginTree,
  type MarketplaceManifest,
  marketplacesRoot,
  type PluginSource,
  parseGithubRepoUrl,
  pluginDirIn,
  pluginSource,
  readMarketplaceManifest,
  removeInstalledPlugin,
  resolveGithubCommit,
} from "@rakazo/adapters";
import type {
  Actor,
  MarketplaceFileChange,
  MarketplacePlugin,
  MarketplaceUpdateCheck,
  SpaceMarketplace,
} from "@rakazo/contracts";
import { IsolationError, type PrismaClient } from "@rakazo/db";

export type MarketplacesDeps = {
  prisma: PrismaClient;
  dataDir: string;
  /** Test seam; production goes through createSafeRemoteFetch (anti-SSRF). */
  fetch?: typeof fetch;
};

type Row = Awaited<ReturnType<PrismaClient["spaceMarketplace"]["create"]>>;
const MANIFEST = path.join(".claude-plugin", "marketplace.json");

/** Adapter errors are user-facing (bad URL, missing manifest, unsupported plugin…). */
function badRequest(error: unknown): never {
  if (error instanceof ORPCError) throw error;
  throw new ORPCError("BAD_REQUEST", {
    message: error instanceof Error ? error.message : "Marketplace operation failed.",
  });
}

/**
 * A plugin fetched from its own GitHub repository carries its own pinned commit: the
 * marketplace row's `commit` only pins the index. Older rows stored bare names, so both
 * shapes are read.
 */
type Installed = { name: string; commit?: string };

const installedPlugins = (row: Row): Installed[] =>
  Array.isArray(row.installedPlugins)
    ? row.installedPlugins.flatMap((entry): Installed[] => {
        if (typeof entry === "string") return [{ name: entry }];
        if (entry && typeof entry === "object" && "name" in entry) {
          const { name, commit } = entry as { name: unknown; commit?: unknown };
          if (typeof name === "string") {
            return [{ name, commit: typeof commit === "string" ? commit : undefined }];
          }
        }
        return [];
      })
    : [];

const installedNames = (row: Row): string[] => installedPlugins(row).map((p) => p.name);

/** Prisma rejects `undefined` inside a Json value, so an unpinned plugin stays a bare name. */
const entry = (name: string, commit?: string): Installed => (commit ? { name, commit } : { name });
const byName = (a: Installed, b: Installed) => a.name.localeCompare(b.name);

const toDto = (row: Row): SpaceMarketplace => ({
  id: row.id,
  name: row.name,
  url: row.url,
  ref: row.ref,
  commit: row.commit,
  installedPlugins: installedNames(row),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export function createMarketplacesService(deps: MarketplacesDeps) {
  const { prisma } = deps;
  const root = (actor: Actor) => marketplacesRoot(deps.dataDir, actor.spaceId);
  const dirOf = (actor: Actor, row: Row) => path.join(root(actor), row.name);

  /** Pins `ref` (unless `commit` is given) and extracts the repo into a temp dir the caller must rm. */
  async function download(
    url: string,
    ref: string,
    commit?: string,
  ): Promise<{ dir: string; commit: string }> {
    const safe = deps.fetch
      ? Object.assign(deps.fetch.bind(globalThis), { close: async () => {} })
      : createSafeRemoteFetch();
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-mkt-"));
    try {
      const repo = parseGithubRepoUrl(url);
      const sha = commit ?? (await resolveGithubCommit({ ...repo, ref }, safe));
      await downloadGithubTarball({ ...repo, commit: sha }, dir, { fetch: safe });
      return { dir, commit: sha };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      badRequest(error);
    } finally {
      await safe.close().catch(() => undefined);
    }
  }

  async function checkout(
    url: string,
    ref: string,
    commit?: string,
  ): Promise<{ dir: string; commit: string; manifest: MarketplaceManifest }> {
    const { dir, commit: sha } = await download(url, ref, commit);
    try {
      return { dir, commit: sha, manifest: await readMarketplaceManifest(dir) };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      badRequest(error);
    }
  }

  /**
   * Installs one plugin into `targetRoot` from wherever it lives, returning the commit it was
   * pinned to when the plugin has a repository of its own. `pin` replays an earlier install
   * instead of following the ref.
   */
  async function installOne(
    targetRoot: string,
    row: Row,
    checkoutDir: string,
    manifest: MarketplaceManifest,
    plugin: string,
    pin?: string,
  ): Promise<string | undefined> {
    const source: PluginSource = pluginSource(manifest, plugin);
    if (source.kind === "local") {
      await installPluginTree(targetRoot, row.name, plugin, pluginDirIn(checkoutDir, source));
      return undefined;
    }
    const external = await download(source.url, source.ref ?? "HEAD", pin);
    try {
      await installPluginTree(targetRoot, row.name, plugin, pluginDirIn(external.dir, source));
      return external.commit;
    } finally {
      await rm(external.dir, { recursive: true, force: true });
    }
  }

  async function owned(actor: Actor, marketplaceId: string): Promise<Row> {
    const row = await prisma.spaceMarketplace.findUnique({ where: { id: marketplaceId } });
    if (!row || row.spaceId !== actor.spaceId) throw new IsolationError();
    return row;
  }

  async function forgetSkillRows(actor: Actor, prefix: string): Promise<void> {
    const where = { spaceId: actor.spaceId, skillKey: { startsWith: prefix } };
    await prisma.skillSetting.deleteMany({ where });
    await prisma.botSkill.deleteMany({ where });
  }

  async function setInstalled(row: Row, plugins: Installed[]): Promise<SpaceMarketplace> {
    return toDto(
      await prisma.spaceMarketplace.update({
        where: { id: row.id },
        data: { installedPlugins: plugins },
      }),
    );
  }

  return {
    async list(actor: Actor): Promise<SpaceMarketplace[]> {
      const rows = await prisma.spaceMarketplace.findMany({
        where: { spaceId: actor.spaceId },
        orderBy: { name: "asc" },
      });
      return rows.map(toDto);
    },

    async add(actor: Actor, input: { url: string; ref?: string }): Promise<SpaceMarketplace> {
      const ref = input.ref ?? "HEAD";
      const { dir, commit, manifest } = await checkout(input.url, ref);
      try {
        const clash = await prisma.spaceMarketplace.findUnique({
          where: { spaceId_name: { spaceId: actor.spaceId, name: manifest.name } },
        });
        if (clash) {
          throw new ORPCError("CONFLICT", {
            message: `Marketplace "${manifest.name}" is already added.`,
          });
        }
        const target = path.join(root(actor), manifest.name);
        await mkdir(path.dirname(path.join(target, MANIFEST)), { recursive: true });
        await writeFile(path.join(target, MANIFEST), await readFile(path.join(dir, MANIFEST)));
        return toDto(
          await prisma.spaceMarketplace.create({
            data: { spaceId: actor.spaceId, name: manifest.name, url: input.url, ref, commit },
          }),
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },

    async plugins(actor: Actor, marketplaceId: string): Promise<MarketplacePlugin[]> {
      const row = await owned(actor, marketplaceId);
      const manifest = await readMarketplaceManifest(dirOf(actor, row)).catch(badRequest);
      const installed = new Set(installedNames(row));
      return manifest.plugins.map((p) => ({
        name: p.name,
        description: p.description,
        supported: p.supported,
        installed: installed.has(p.name),
      }));
    },

    async installPlugin(
      actor: Actor,
      marketplaceId: string,
      plugin: string,
    ): Promise<SpaceMarketplace> {
      const row = await owned(actor, marketplaceId);
      const { dir, manifest } = await checkout(row.url, row.ref, row.commit);
      let commit: string | undefined;
      try {
        commit = await installOne(root(actor), row, dir, manifest, plugin).catch(badRequest);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      const kept = installedPlugins(row).filter((p) => p.name !== plugin);
      return setInstalled(row, [...kept, entry(plugin, commit)].sort(byName));
    },

    async removePlugin(
      actor: Actor,
      marketplaceId: string,
      plugin: string,
    ): Promise<SpaceMarketplace> {
      const row = await owned(actor, marketplaceId);
      await removeInstalledPlugin(root(actor), row.name, plugin);
      await forgetSkillRows(actor, `mkt:${row.name}/${plugin}/`);
      return setInstalled(
        row,
        installedPlugins(row).filter((p) => p.name !== plugin),
      );
    },

    // ponytail: checkUpdate + applyUpdate each download the tarball; cache the checkout if GitHub rate limits bite.
    async checkUpdate(actor: Actor, marketplaceId: string): Promise<MarketplaceUpdateCheck> {
      const row = await owned(actor, marketplaceId);
      const { dir, commit, manifest } = await checkout(row.url, row.ref);
      const staging = await mkdtemp(path.join(tmpdir(), "rakazo-mkt-stage-"));
      try {
        const installed = installedPlugins(row);
        // A plugin with its own repository can drift while the index stays put, so its files
        // have to be fetched to answer; a purely local marketplace is settled by the sha alone.
        const external = installed.some((p) => p.commit !== undefined);
        if (commit === row.commit && !external) return { commit, upToDate: true, changes: [] };
        const changes: MarketplaceFileChange[] = [];
        for (const { name } of installed) {
          // Plugin gone or broken upstream: staging stays empty and every file shows as removed.
          await installOne(staging, row, dir, manifest, name).catch(() => undefined);
          const skills = ["plugins", name, "skills"];
          const diff = await diffPluginTrees(
            path.join(dirOf(actor, row), ...skills),
            path.join(staging, row.name, ...skills),
          );
          changes.push(...diff.map((c) => ({ ...c, path: `${name}/${c.path}` })));
        }
        return { commit, upToDate: commit === row.commit && changes.length === 0, changes };
      } finally {
        await Promise.all([
          rm(dir, { recursive: true, force: true }),
          rm(staging, { recursive: true, force: true }),
        ]);
      }
    },

    async applyUpdate(
      actor: Actor,
      marketplaceId: string,
      commit: string,
    ): Promise<SpaceMarketplace> {
      const row = await owned(actor, marketplaceId);
      const { dir, manifest } = await checkout(row.url, row.ref, commit);
      const pinned: Installed[] = [];
      try {
        await writeFile(
          path.join(dirOf(actor, row), MANIFEST),
          await readFile(path.join(dir, MANIFEST)),
        );
        for (const { name } of installedPlugins(row)) {
          pinned.push(entry(name, await installOne(root(actor), row, dir, manifest, name)));
        }
      } catch (error) {
        badRequest(error);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return toDto(
        await prisma.spaceMarketplace.update({
          where: { id: row.id },
          data: { commit, installedPlugins: pinned.sort(byName) },
        }),
      );
    },

    async remove(actor: Actor, marketplaceId: string): Promise<{ ok: true }> {
      const row = await owned(actor, marketplaceId);
      // Files first, rows second (same order as agent-skills): orphan rows are harmless.
      await rm(dirOf(actor, row), { recursive: true, force: true });
      await forgetSkillRows(actor, `mkt:${row.name}/`);
      await prisma.spaceMarketplace.delete({ where: { id: row.id } });
      return { ok: true };
    },
  };
}

export type MarketplacesService = ReturnType<typeof createMarketplacesService>;
