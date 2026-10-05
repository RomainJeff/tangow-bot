import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import { isPreviewableUrl } from "@rakazo/contracts";
import { hasSecretParam, normalizePreviewUrl } from "@rakazo/core";
import {
  type CachedLinkPreview,
  findCachedLinkPreview,
  type LinkPreviewReadSource,
  linkPreviewKeyHash,
  type PrismaClient,
  reserveLinkPreviewRead,
  storeLinkPreviewCache,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  type LinkPreviewReadDeps,
  type LinkPreviewReadResult,
  readLinkPreview,
} from "./read-link-preview.js";

export interface LinkPreviewServiceDeps {
  prisma: Pick<PrismaClient, "$transaction" | "linkPreviewCache" | "linkPreviewRead">;
  artifacts: ArtifactStore;
  /** Test seams: the page reader and its network seams. */
  read?: (url: string, deps: LinkPreviewReadDeps) => Promise<LinkPreviewReadResult>;
  readDeps?: LinkPreviewReadDeps;
  now?: () => Date;
}

export interface ResolvedLinkPreview {
  format: "large" | "photo" | "compact";
  title?: string;
  /** The WebP bytes live in the artifact store under `key` (the cache's copy). */
  image?: { key: string; width: number; height: number; bytes: number; fit?: "contain" };
}

export interface LinkPreviewScope {
  spaceId: string;
  userId: string;
  source: LinkPreviewReadSource;
}

export function previewStoreContext(
  scope: { spaceId: string; userId: string },
  operationId: string,
  signal: AbortSignal = new AbortController().signal,
): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: scope.spaceId,
    userId: scope.userId,
    signal,
  };
}

/** Delete image bytes from the store, never failing: a leaked file is better than a lost preview. */
export async function removePreviewBytes(
  artifacts: ArtifactStore,
  scope: { spaceId: string; userId: string },
  keys: string[],
): Promise<void> {
  await Promise.all(
    keys.map((key) =>
      artifacts
        .remove(key, previewStoreContext(scope, "link-preview:remove"))
        .catch(() => undefined),
    ),
  );
}

/**
 * One preview, from the cache or from the page: the single path the job and the composer share.
 * A link that is not previewable, or names a secret in its query, is never read, cached or logged.
 * Returns null whenever there is nothing to show: a refusal, a failed read, or a limit (a limit
 * caches nothing, so the link is tried again later). Never throws.
 */
export async function resolveLinkPreview(
  deps: LinkPreviewServiceDeps,
  scope: LinkPreviewScope,
  url: string,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<ResolvedLinkPreview | null> {
  try {
    if (!isPreviewableUrl(url) || hasSecretParam(url)) return null;
    const normalized = normalizePreviewUrl(url);
    if (!normalized) return null;
    const now = deps.now?.() ?? new Date();
    const keyHash = linkPreviewKeyHash(scope.spaceId, normalized);

    const cached = await findCachedLinkPreview(deps.prisma, scope.spaceId, keyHash, now);
    if (cached) return cached.status === "ok" ? cached : null;

    if (signal?.aborted) return null;
    const allowed = await reserveLinkPreviewRead(deps.prisma, {
      spaceId: scope.spaceId,
      userId: scope.userId,
      source: scope.source,
      now,
    });
    if (!allowed) return null;

    const read = deps.read ?? readLinkPreview;
    const result = await read(url, {
      ...deps.readDeps,
      ...(signal ? { signal } : {}),
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      // Host and reason only: the link can carry a token.
      log: (event) => getLogger().info("link preview read failed", event),
    });
    if (!result.ok) {
      // Only a failure that describes the link is worth remembering; a slow or busy site is not.
      if (!result.transient) {
        await storeEntry(deps, scope, keyHash, { status: "failed" }, now);
      }
      return null;
    }

    let image: ResolvedLinkPreview["image"];
    if (result.image) {
      const stored = await deps.artifacts.put(
        {
          name: "link-preview.webp",
          mimeType: "image/webp",
          bytes: result.image.bytes,
        },
        previewStoreContext(scope, "link-preview:cache"),
      );
      image = {
        key: stored.id,
        width: result.image.width,
        height: result.image.height,
        bytes: result.image.bytes.byteLength,
        ...(result.imageFit ? { fit: result.imageFit } : {}),
      };
    }
    const entry: Extract<CachedLinkPreview, { status: "ok" }> = {
      status: "ok",
      format: result.format,
      ...(result.title ? { title: result.title } : {}),
      ...(image ? { image } : {}),
    };
    if (!(await storeEntry(deps, scope, keyHash, entry, now))) {
      if (image) await removePreviewBytes(deps.artifacts, scope, [image.key]);
      return null;
    }
    return entry;
  } catch (error) {
    // The error name only: Prisma and fetch errors can carry the request.
    getLogger().warn("link preview failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}

async function storeEntry(
  deps: LinkPreviewServiceDeps,
  scope: LinkPreviewScope,
  keyHash: string,
  entry: CachedLinkPreview,
  now: Date,
): Promise<boolean> {
  try {
    const { removedImageKeys } = await storeLinkPreviewCache(deps.prisma, {
      spaceId: scope.spaceId,
      keyHash,
      entry,
      now,
    });
    await removePreviewBytes(deps.artifacts, scope, removedImageKeys);
    return true;
  } catch (error) {
    getLogger().warn("link preview cache write failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}
