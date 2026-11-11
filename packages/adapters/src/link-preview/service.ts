import type { AdapterContext, ArtifactStore } from "@tangow/adapter-kit";
import { isEligibleLink, normalizePreviewUrl } from "@tangow/core";
import {
  type CachedLinkRead,
  findCachedLinkPreview,
  type LinkPreviewReadSource,
  linkPreviewDeviceKeyHash,
  linkPreviewKeyHash,
  type PrismaClient,
  reserveLinkPreviewRead,
  storeLinkPreviewCache,
} from "@tangow/db";
import { getLogger } from "@tangow/logging";
import type { LinkPreviewFailureReason } from "./errors.js";
import type { EncodedPreviewImage } from "./image.js";
import {
  cardOf,
  type IconReads,
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
  /** What the space's own read knows of the page (a mention's only source), or null. */
  read: CachedLinkRead | null;
  /** The space's read quota said no: nothing was read or cached. */
  limited?: true;
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

const NOTHING: LinkPreviewResolution = {
  preview: null,
  read: null,
  deviceReadable: false,
  refused: false,
};

/** How deep a link is read: a mention never needs the page image. */
export interface LinkReadOptions {
  mention?: true;
  icons?: IconReads;
}

/**
 * The card this person's own device read for a link the site refuses the server, if one is still
 * fresh. Only ever theirs: another member's head never reaches this person's messages.
 */
async function findOwnDeviceCard(
  deps: LinkPreviewServiceDeps,
  scope: LinkPreviewScope,
  normalized: string,
  now: Date,
): Promise<ResolvedLinkPreview | null> {
  const keyHash = linkPreviewDeviceKeyHash(scope.spaceId, scope.userId, normalized);
  const cached = await findCachedLinkPreview(deps.prisma, scope.spaceId, keyHash, now);
  return cached?.source === "device" ? cardOfCached(cached) : null;
}

function cardOfCached(entry: CachedLinkRead): ResolvedLinkPreview | null {
  return entry.kind === "unreadable" ? null : cardOf(entry);
}

/**
 * One link, from the cache or from the page: the single path the job and the composer share. A
 * link `isEligibleLink` refuses is never read, cached or logged. `preview` is null whenever there
 * is no card: a refusal, a failed read, a page that is no article, or a limit (a limit caches
 * nothing, so the link is tried again later). Also says whether the sender's device may read what
 * the server could not. Never throws.
 */
export async function resolveLinkPreviewDetailed(
  deps: LinkPreviewServiceDeps,
  scope: LinkPreviewScope,
  url: string,
  signal?: AbortSignal,
  deadlineAt?: number,
  options: LinkReadOptions = {},
): Promise<LinkPreviewResolution> {
  try {
    if (!isEligibleLink(url)) return NOTHING;
    const normalized = normalizePreviewUrl(url);
    if (!normalized) return NOTHING;
    const now = deps.now?.() ?? new Date();
    const keyHash = linkPreviewKeyHash(scope.spaceId, normalized);

    const cached = await findCachedLinkPreview(deps.prisma, scope.spaceId, keyHash, now);
    // An article read for a mention lacks what its card needs: read it again for one.
    if (cached && (options.mention || cached.kind !== "page" || cached.article !== "unread")) {
      const refused = cached.kind === "refused";
      const device = refused ? await findOwnDeviceCard(deps, scope, normalized, now) : null;
      if (device) return { preview: device, read: cached, deviceReadable: false, refused };
      return { preview: cardOfCached(cached), read: cached, deviceReadable: refused, refused };
    }

    if (signal?.aborted) return NOTHING;
    const allowed = await reserveLinkPreviewRead(deps.prisma, {
      spaceId: scope.spaceId,
      userId: scope.userId,
      source: scope.source,
      now,
    });
    if (!allowed) return { ...NOTHING, limited: true };

    const read = deps.read ?? readLinkPreview;
    const result = await read(url, {
      ...deps.readDeps,
      ...(signal ? { signal } : {}),
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      ...(options.mention ? { pageImage: false as const } : {}),
      ...(options.icons ? { icons: options.icons } : {}),
      // Host and reason only: the link can carry a token.
      log: (event) => getLogger().info("link preview read failed", event),
    });
    if (!result.ok) {
      // Only a failure that describes the link is worth remembering; a slow or busy site is not.
      if (!result.transient) await storeEntry(deps, scope, keyHash, { kind: "unreadable" }, now);
      const deviceReadable = result.transient && DEVICE_RETRY_REASONS.has(result.reason);
      return { preview: null, read: null, deviceReadable, refused: false };
    }
    const refused = result.kind === "refused";
    const device = refused ? await findOwnDeviceCard(deps, scope, normalized, now) : null;
    const entry = await storeResult(deps, scope, keyHash, result, now);
    if (device) return { preview: device, read: entry, deviceReadable: false, refused };
    const preview = entry ? cardOfCached(entry) : null;
    return { preview, read: entry, deviceReadable: refused, refused };
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
    // A link that is not eligible never got this far.
    if (!server.deviceReadable) return server;
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
    if (!result.ok || !cardOf(result)) return server;
    const keyHash = linkPreviewDeviceKeyHash(scope.spaceId, scope.userId, normalized);
    // Only a refusal by the site itself lets a device-read card be remembered for this person: while
    // the site merely fails for now (429, 5xx) the card serves this draft and nothing else.
    const read = server.refused ? result : { ...result, icon: undefined };
    const entry = await storeResult(deps, scope, keyHash, read, now, "device", server.refused);
    const preview = entry && cardOfCached(entry);
    if (!preview) return server;
    return {
      preview,
      read: server.read,
      deviceReadable: false,
      refused: server.refused,
      ...(!server.refused && preview.image ? { ephemeralImageKey: preview.image.key } : {}),
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

/** Stores a read's pictures, then (unless `cache` is false) its cache entry. Null when the cache write fails. */
async function storeResult(
  deps: LinkPreviewServiceDeps,
  scope: LinkPreviewScope,
  keyHash: string,
  { ok: _, ...read }: Extract<LinkPreviewReadResult, { ok: true }>,
  now: Date,
  source: "server" | "device" = "server",
  cache = true,
): Promise<CachedLinkRead | null> {
  const keys: string[] = [];
  const put = async (image: EncodedPreviewImage & { fit?: "contain" }) => {
    const stored = await deps.artifacts.put(
      { name: "link-preview.webp", mimeType: "image/webp", bytes: image.bytes },
      previewStoreContext(scope, "link-preview:cache"),
    );
    keys.push(stored.id);
    return {
      key: stored.id,
      width: image.width,
      height: image.height,
      bytes: image.bytes.byteLength,
      ...(image.fit ? { fit: image.fit } : {}),
    };
  };
  // An icon is optional: failing to store it leaves the card without one, not without a card.
  const putIcon = async (icon: EncodedPreviewImage | undefined) => {
    if (!icon) return undefined;
    try {
      return { key: (await put(icon)).key, bytes: icon.bytes.byteLength };
    } catch {
      return undefined;
    }
  };
  let entry: CachedLinkRead;
  try {
    if (read.kind === "photo") {
      entry = { ...read, image: await put(read.image), source };
    } else if (read.kind === "refused") {
      entry = { ...read, icon: await putIcon(read.icon), source };
    } else {
      const image = read.image && (await put(read.image));
      entry = { ...read, image, icon: await putIcon(read.icon), source };
    }
  } catch (error) {
    await removePreviewBytes(deps.artifacts, scope, keys);
    throw error;
  }
  if (!cache || (await storeEntry(deps, scope, keyHash, entry, now))) return entry;
  await removePreviewBytes(deps.artifacts, scope, keys);
  return null;
}

async function storeEntry(
  deps: LinkPreviewServiceDeps,
  scope: LinkPreviewScope,
  keyHash: string,
  entry: CachedLinkRead,
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
