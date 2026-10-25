import type { ConnectorTool } from "@rakazo/adapter-kit";

export type ToolkitDirectoryEntry = {
  slug: string;
  name: string;
  logo: string | null;
  noAuth: boolean;
};

export type ToolkitCatalogEntry = ToolkitDirectoryEntry & { connected: boolean };

export const COMPOSIO_DIRECTORY_TTL_MS = 60 * 60 * 1000;

export function mergeCatalogWithConnected(
  directory: ToolkitDirectoryEntry[],
  connectedSlugs: Iterable<string>,
): ToolkitCatalogEntry[] {
  const connected = new Set([...connectedSlugs].map((slug) => slug.trim().toLowerCase()));
  return directory.map((item) => ({
    ...item,
    connected: connected.has(item.slug.trim().toLowerCase()),
  }));
}

/**
 * Coalesces directory loads and serves stale entries during refreshes. Failed
 * refreshes preserve stale entries for later retries; cold-load errors propagate.
 */
export function createToolkitDirectoryCache<T = ToolkitDirectoryEntry>(opts?: {
  ttlMs?: number;
  now?: () => number;
}) {
  const ttlMs = opts?.ttlMs ?? COMPOSIO_DIRECTORY_TTL_MS;
  const now = opts?.now ?? Date.now;
  let entry: { items: T[]; fetchedAt: number } | undefined;
  let inflight: Promise<T[]> | undefined;

  async function load(loader: () => Promise<T[]>) {
    inflight ??= loader()
      .then((items) => {
        entry = { items, fetchedAt: now() };
        return items;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  return {
    peek(): T[] | undefined {
      return entry?.items;
    },
    async get(loader: () => Promise<T[]>): Promise<T[]> {
      if (!entry) return load(loader);
      if (now() - entry.fetchedAt < ttlMs) return entry.items;
      if (!inflight) {
        // Keep stale items on failure; load clears inflight so a later read can retry.
        void load(loader).catch(() => undefined);
      }
      return entry.items;
    },
    invalidate() {
      entry = undefined;
    },
  };
}

export const composioToolkitDirectory = createToolkitDirectoryCache();

export const composioToolSchemas = new Map<
  string,
  ReturnType<typeof createToolkitDirectoryCache<ConnectorTool>>
>();
