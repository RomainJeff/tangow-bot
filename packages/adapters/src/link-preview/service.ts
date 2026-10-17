import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import { isPreviewableUrl } from "@rakazo/contracts";
import { hasSecretParam, isAuthenticationDestination, normalizePreviewUrl } from "@rakazo/core";
import {
  type CachedLinkPreview,
  findCachedLinkPreview,
  type LinkPreviewReadSource,
  linkPreviewDeviceKeyHash,
  linkPreviewKeyHash,
  type PrismaClient,
  reserveLinkPreviewRead,
  storeLinkPreviewCache,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { LinkPreviewFailureReason } from "./errors.js";
import type { EncodedPreviewImage } from "./image.js";
import {
  cardOf,
  type LinkPreviewReadDeps,
  type LinkPreviewReadResult,
  readLinkPreview,
  readLinkPreviewFromHead,
} from "./read-link-preview.js";
import { MAX_HTML_BYTES } from "./safe-fetch.js";

export interface LinkPreviewServiceDeps {
  prisma: Pick<PrismaClient, "$transaction" | "linkPreviewCache" | "linkPreviewRead">;
  artifacts: ArtifactStore;
  /** The page reader and its options: test seams, and a caller's deadline. */
  read?: (url: string, deps: LinkPreviewReadDeps) => Promise<LinkPreviewReadResult>;
  readFromHead?: (
    url: string,
    head: Uint8Array,
    deps: LinkPreviewReadDeps,
    contentType?: string,
  ) => Promise<LinkPreviewReadResult>;
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

/** What a preview lookup found, and whether the sender's own device may still read the page. */
export interface LinkPreviewResolution {
  preview: ResolvedLinkPreview | null;
  /**
   * The site refused the server (401, 402, 403, 451) or answered with a passing HTTP error (429, 5xx): the
   * sender's device may read the page and send its head (`resolveLinkPreviewWithDeviceHead`).
   * Never set for an unsafe link, a refused address, a missing page or a limit.
   */
  deviceReadable: boolean;
  /**
   * The site itself refused the server (401, 402, 403, 451), as opposed to a passing 429 or 5xx:
   * only then does a device-read card enter the space's cache.
   */
  refused: boolean;
  /**
   * Set when `preview.image` is in the store but in no cache entry (a device-read card for a
   * passing failure): the caller deletes it once it has used it.
   */
  ephemeralImageKey?: string;
}

/**
 * Failures that are the site's own HTTP answer (429, 5xx) and say nothing about the link: another
 * network may well get through. Never a timeout or a network or DNS error, which happen before any
 * HTTP answer and would let a caller tell a private name from an unknown one.
 */
const DEVICE_RETRY_REASONS: ReadonlySet<LinkPreviewFailureReason> = new Set([
  "rate_limited",
  "server_error",
]);

const NOTHING: LinkPreviewResolution = { preview: null, deviceReadable: false, refused: false };

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
  return (await resolveLinkPreviewDetailed(deps, scope, url, signal, deadlineAt)).preview;
}

/**
 * The card this person's own device read for a link the site refuses the server, if one is still
 * fresh. Only ever theirs: another member's head never reaches this person's messages.
 */
async function findOwnDeviceRead(
  deps: LinkPreviewServiceDeps,
  scope: LinkPreviewScope,
  normalized: string,
  now: Date,
): Promise<Extract<CachedLinkPreview, { status: "ok" }> | null> {
  const keyHash = linkPreviewDeviceKeyHash(scope.spaceId, scope.userId, normalized);
  const cached = await findCachedLinkPreview(deps.prisma, scope.spaceId, keyHash, now);
  return cached?.status === "ok" && cached.source === "device" ? cached : null;
}

function resolvedOf(entry: Extract<CachedLinkPreview, { status: "ok" }>): ResolvedLinkPreview {
  return {
    format: entry.format,
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.image ? { image: entry.image } : {}),
  };
}

/** `resolveLinkPreview`, plus whether the sender's device may read what the server could not. */
export async function resolveLinkPreviewDetailed(
  deps: LinkPreviewServiceDeps,
  scope: LinkPreviewScope,
  url: string,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<LinkPreviewResolution> {
  try {
    if (!isPreviewableUrl(url) || hasSecretParam(url)) return NOTHING;
    const normalized = normalizePreviewUrl(url);
    if (!normalized) return NOTHING;
    const now = deps.now?.() ?? new Date();
    const keyHash = linkPreviewKeyHash(scope.spaceId, normalized);

    const cached = await findCachedLinkPreview(deps.prisma, scope.spaceId, keyHash, now);
    if (cached) {
      const refused = cached.source === "restricted";
      const device = refused ? await findOwnDeviceRead(deps, scope, normalized, now) : null;
      if (device) return { preview: resolvedOf(device), deviceReadable: false, refused };
      return {
        preview: cached.status === "ok" ? resolvedOf(cached) : null,
        deviceReadable: refused,
        refused,
      };
    }

    if (signal?.aborted) return NOTHING;
    const allowed = await reserveLinkPreviewRead(deps.prisma, {
      spaceId: scope.spaceId,
      userId: scope.userId,
      source: scope.source,
      now,
    });
    if (!allowed) return NOTHING;

    const read = deps.read ?? readLinkPreview;
    const result = await read(url, {
      ...deps.readDeps,
      ...(signal ? { signal } : {}),
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      // Host and reason only: the link can carry a token.
      log: (event) => getLogger().info("link preview read failed", event),
    });
    const refused = result.ok && result.kind === "refused";
    const source = refused ? ("restricted" as const) : undefined;
    const device = refused ? await findOwnDeviceRead(deps, scope, normalized, now) : null;
    const deviceReadable =
      refused || (!result.ok && result.transient && DEVICE_RETRY_REASONS.has(result.reason));
    const card = result.ok ? cardOf(result) : null;
    if (!card) {
      // Only a failure that describes the link is worth remembering; a slow or busy site is not.
      if (result.ok || !result.transient) {
        await storeEntry(
          deps,
          scope,
          keyHash,
          { status: "failed", ...(source ? { source } : {}) },
          now,
        );
      }
      if (device) return { preview: resolvedOf(device), deviceReadable: false, refused };
      return { preview: null, deviceReadable, refused };
    }
    const entry = await storeResult(deps, scope, keyHash, card, now);
    if (device) return { preview: resolvedOf(device), deviceReadable: false, refused };
    return entry ? { preview: resolvedOf(entry), deviceReadable, refused } : NOTHING;
  } catch (error) {
    // The error name only: Prisma and fetch errors can carry the request.
    getLogger().warn("link preview failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return NOTHING;
  }
}

/**
 * The preview of a link the site refuses the server, from the head of the page its sender's
 * device read. `pageHead` is untrusted and used only when the server itself is still refused for
 * this link (a fresh refusal in this space's cache, or a read that ends in one now): for a site
 * the server can read, an unsafe, secret or sign-in link, or an oversized head it is ignored and
 * the answer is the server's own. Parsed like a fetched page; the image is fetched and re-encoded
 * here. The result is cached for this person only (source `device`, their own key), so the job of
 * their message and a bot's later link in their own threads reuse it; the space's entry stays the
 * server's refusal, so no other member ever gets a card a device described. Never throws.
 */
export async function resolveLinkPreviewWithDeviceHead(
  deps: LinkPreviewServiceDeps,
  scope: LinkPreviewScope,
  url: string,
  pageHead: string,
  signal?: AbortSignal,
  pageHeadType?: string,
): Promise<LinkPreviewResolution> {
  const server = await resolveLinkPreviewDetailed(deps, scope, url, signal);
  try {
    if (!server.deviceReadable) return server;
    // An address that cannot be previewed never got this far; a sign-in page is refused here too.
    if (isAuthenticationDestination(url)) return NOTHING;
    if (pageHead.length === 0 || pageHead.length > MAX_HTML_BYTES || BEYOND_LATIN1.test(pageHead)) {
      return server;
    }
    const normalized = normalizePreviewUrl(url);
    if (!normalized || signal?.aborted) return server;
    const now = deps.now?.() ?? new Date();
    const allowed = await reserveLinkPreviewRead(deps.prisma, {
      spaceId: scope.spaceId,
      userId: scope.userId,
      source: scope.source,
      now,
    });
    if (!allowed) return server;

    const readFromHead = deps.readFromHead ?? readLinkPreviewFromHead;
    const result = await readFromHead(
      url,
      Buffer.from(pageHead, "latin1"),
      {
        ...deps.readDeps,
        ...(signal ? { signal } : {}),
        log: (event) => getLogger().info("link preview read failed", event),
      },
      pageHeadType,
    );
    // A head that makes no card leaves the server's answer in place, uncached and unchanged.
    const card = result.ok ? cardOf(result) : null;
    if (!card) return server;
    const keyHash = linkPreviewDeviceKeyHash(scope.spaceId, scope.userId, normalized);
    // Only a refusal by the site itself lets a device-read card be remembered for this person: while
    // the site merely fails for now (429, 5xx) the card serves this draft and nothing else.
    const entry = await storeResult(deps, scope, keyHash, card, now, "device", server.refused);
    if (!entry) return server;
    return {
      preview: resolvedOf(entry),
      deviceReadable: false,
      refused: server.refused,
      ...(!server.refused && entry.image ? { ephemeralImageKey: entry.image.key } : {}),
    };
  } catch (error) {
    getLogger().warn("link preview failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return server;
  }
}

/** A character above U+00FF cannot be one byte of a page: the head is not what a device sends. */
const BEYOND_LATIN1 = /[\u0100-\uffff]/;

/** Stores the image bytes, then (unless `cache` is false) the cache entry. Null when the cache write fails. */
async function storeResult(
  deps: LinkPreviewServiceDeps,
  scope: LinkPreviewScope,
  keyHash: string,
  result: NonNullable<ReturnType<typeof cardOf<EncodedPreviewImage>>>,
  now: Date,
  source?: "device",
  cache = true,
): Promise<Extract<CachedLinkPreview, { status: "ok" }> | null> {
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
      ...(result.image.fit ? { fit: result.image.fit } : {}),
    };
  }
  const entry: Extract<CachedLinkPreview, { status: "ok" }> = {
    status: "ok",
    format: result.format,
    ...(result.title ? { title: result.title } : {}),
    ...(image ? { image } : {}),
    ...(result.format !== "photo" ? { article: true as const } : {}),
    ...(source ? { source } : {}),
  };
  if (cache && !(await storeEntry(deps, scope, keyHash, entry, now))) {
    if (image) await removePreviewBytes(deps.artifacts, scope, [image.key]);
    return null;
  }
  return entry;
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
