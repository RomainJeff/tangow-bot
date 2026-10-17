import { LINK_PREVIEW_IMAGE_FIT } from "@rakazo/contracts";
import type { LinkFacts } from "@rakazo/db";
import { isTransientReason, LinkPreviewError, type LinkPreviewFailureReason } from "./errors.js";
import type { LinkPreviewHead } from "./head-parser.js";
import { parseLinkPreviewHead } from "./head-parser.js";
import {
  type EncodedPreviewImage,
  encodePreviewImage,
  type ImageEncodeOptions,
  MAX_ICON_WIDTH,
} from "./image.js";
import {
  fetchLinkPreviewResource,
  LINK_PREVIEW_IMAGE_TIMEOUT_MS,
  LINK_PREVIEW_PAGE_TIMEOUT_MS,
  type LinkPreviewFetchOptions,
  type LinkPreviewResource,
  type LinkPreviewResourceFetcher,
} from "./safe-fetch.js";
import { sameSite } from "./site.js";

export type LinkPreviewFormat = "large" | "photo" | "compact";

const LARGE_MIN_WIDTH = 600;
const LARGE_MIN_RATIO = 1.3;
/** The icon is only worth a request when this much of the job's budget is left to read it. */
export const LINK_PREVIEW_ICON_MIN_BUDGET_MS = 3_000;

/**
 * The card format, or null when the link gets no card. Only a photo (a direct image) and an
 * article get one. The size comes from what was really downloaded, never from what the page declares.
 */
export function decideLinkPreviewFormat(input: {
  kind: "html" | "image";
  article?: boolean;
  title?: string;
  image?: { width: number; height: number };
}): LinkPreviewFormat | null {
  const { kind, article, title, image } = input;
  if (kind === "image") return image ? "photo" : null;
  if (!article || !title) return null;
  if (image && image.width >= LARGE_MIN_WIDTH && image.width / image.height >= LARGE_MIN_RATIO) {
    return "large";
  }
  return "compact";
}

/** What one read of a link learned, its pictures as re-encoded bytes, or why nothing was learned. */
export type LinkPreviewReadResult =
  | ({ ok: true } & LinkFacts<EncodedPreviewImage, EncodedPreviewImage>)
  | { ok: false; reason: LinkPreviewFailureReason; transient: boolean };

/** The card a read makes, or null: only a photo, or an article with its title, gets one. */
export function cardOf<Img extends { width: number; height: number }>(
  read: LinkFacts<Img, unknown>,
): { format: LinkPreviewFormat; title?: string; image?: Img & { fit?: "contain" } } | null {
  if (read.kind === "photo") return { format: "photo", image: read.image };
  if (read.kind !== "page" || !read.article || !read.title) return null;
  const { title, image } = read;
  // An icon standing in for the page image never makes a large card.
  const format = decideLinkPreviewFormat({
    kind: "html",
    article: true,
    title,
    image: image?.fit ? undefined : image,
  });
  return format && { format, title, ...(image ? { image } : {}) };
}

export interface LinkPreviewReadDeps
  extends Pick<LinkPreviewFetchOptions, "resolveHostname" | "signal" | "limiter"> {
  /** Tests only (`createLinkPreviewFetcherForTests`): production composition never sets it. */
  fetchResource?: LinkPreviewResourceFetcher;
  pageTimeoutMs?: number;
  imageTimeoutMs?: number;
  /** When the job's budget ends (epoch ms). Without it the icon is always tried. */
  deadlineAt?: number;
  encode?: ImageEncodeOptions;
  /** Receives the host of the link and a reason, never the full URL. */
  log?: (event: {
    host: string;
    stage: "page" | "image" | "icon";
    reason: LinkPreviewFailureReason;
  }) => void;
}

type Fail = (stage: "page" | "image" | "icon", error: unknown) => LinkPreviewReadResult;
type CutShort = (reason: "aborted" | "timeout") => LinkPreviewReadResult;

/**
 * Read a link: one page request, an article's page image, and the site icon the page names (for
 * a refused page: its home page, then that page's icon), redirects aside, a single attempt. Never
 * throws. Transient failures (timeout, 429, 5xx, network, caps) must not be cached; definitive
 * ones describe the link and may be.
 */
export async function readLinkPreview(
  url: string,
  deps: LinkPreviewReadDeps = {},
): Promise<LinkPreviewReadResult> {
  const host = hostOf(url);
  const cutShort: CutShort = (reason) => ({ ok: false, reason, transient: true });
  const fail: Fail = (stage, error) => {
    const reason = error instanceof LinkPreviewError ? error.reason : "network";
    if (host) deps.log?.({ host, stage, reason });
    return { ok: false, reason, transient: isTransientReason(reason) };
  };

  try {
    let page: LinkPreviewResource;
    try {
      page = await fetchPage(url, deps);
    } catch (error) {
      if (error instanceof LinkPreviewError && error.reason === "access_denied") {
        return await readRefusedSite(url, deps, fail);
      }
      return fail("page", error);
    }

    if (page.kind === "image") {
      try {
        return {
          ok: true,
          kind: "photo",
          image: await encodePreviewImage(page.bytes, deps.encode),
        };
      } catch (error) {
        return fail("image", error);
      }
    }

    return await previewFromHead(
      parseLinkPreviewHead(page.bytes, { contentType: page.contentType, url: page.url }),
      { link: url, final: page.url },
      deps,
      fail,
      cutShort,
    );
  } catch (error) {
    return fail("page", error);
  }
}

/**
 * The facts of a parsed page head, `final` being where the read of `link` ended: its title, its
 * 64 px site icon, and for an article that can make a card its page image, else its icon kept
 * whole as the card's picture (never a large card). Shared by the server's own read and by a head
 * the sender's device read.
 */
async function previewFromHead(
  head: LinkPreviewHead,
  { link, final }: { link: string; final: string },
  deps: LinkPreviewReadDeps,
  fail: Fail,
  cutShort: CutShort,
): Promise<LinkPreviewReadResult> {
  const at = new URL(link);
  const title = namesItsSite(head, at) ? undefined : head.title;
  const crossSite = !sameSite(at.hostname, new URL(final).hostname);
  // The page image costs a request: not worth it for a page that gets no card.
  const card = head.article && title !== undefined;
  let image: (EncodedPreviewImage & { fit?: typeof LINK_PREVIEW_IMAGE_FIT }) | undefined =
    card && head.imageUrl ? await readImage(head.imageUrl, deps, fail) : undefined;
  if (card && head.imageUrl && !image && deps.signal?.aborted) return cutShort("aborted");
  let icon: EncodedPreviewImage | undefined;
  if (head.iconUrl) {
    const standsIn = card && !image;
    if (!hasBudgetForIcon(deps)) {
      if (standsIn) return cutShort("timeout");
    } else {
      const bytes = await readIcon(head.iconUrl, final, deps, fail);
      // Only an icon standing in for the card's picture is worth a retry; otherwise it is optional.
      if (standsIn && !bytes && deps.signal?.aborted) return cutShort("aborted");
      if (bytes) {
        icon = await encodeIcon(bytes, deps, fail, MAX_ICON_WIDTH);
        const whole = standsIn ? await encodeIcon(bytes, deps, fail) : undefined;
        if (whole) image = { ...whole, fit: LINK_PREVIEW_IMAGE_FIT };
      }
    }
  }
  return {
    ok: true,
    kind: "page",
    article: head.article,
    ...(title ? { title } : {}),
    ...(crossSite ? { crossSite: true } : {}),
    ...(image ? { image } : {}),
    ...(icon ? { icon } : {}),
  };
}

/**
 * A page that gives a site root as its own address while the link has a path is the site's
 * generic shell (a private document read anonymously): its title names the site, not the page.
 */
function namesItsSite(head: LinkPreviewHead, link: URL): boolean {
  const canonical = head.canonicalUrl ? URL.parse(head.canonicalUrl) : null;
  return canonical?.pathname === "/" && canonical.search === "" && link.pathname !== "/";
}

/**
 * The read of a page whose head the sender's device read, for a link the site refuses the
 * server. The head is untrusted: it goes through the same parser as a fetched page (title
 * sanitized, image and icon resolved against the link and a valid `<base>`), and the server
 * fetches and re-encodes the pictures itself, so nothing remote ever reaches a reader. The device's
 * Content-Type, when it gave one, supplies the charset as it would for a page fetched here. Never
 * throws.
 */
export async function readLinkPreviewFromHead(
  url: string,
  headBytes: Uint8Array,
  deps: LinkPreviewReadDeps = {},
  contentType?: string,
): Promise<LinkPreviewReadResult> {
  const host = hostOf(url);
  const cutShort: CutShort = (reason) => ({ ok: false, reason, transient: true });
  const fail: Fail = (stage, error) => {
    const reason = error instanceof LinkPreviewError ? error.reason : "network";
    if (host) deps.log?.({ host, stage, reason });
    return { ok: false, reason, transient: isTransientReason(reason) };
  };
  try {
    return await previewFromHead(
      parseLinkPreviewHead(headBytes, { url, contentType }),
      { link: url, final: url },
      deps,
      fail,
      cutShort,
    );
  } catch (error) {
    return fail("page", error);
  }
}

/**
 * A site that refuses the server (401, 402, 403, 451): nothing about the page can be known, so
 * only the icon its home page names is read, from the home page's own site. Without the time for
 * those two requests, or when either fails or is cut short, the refusal is recorded without an icon.
 */
async function readRefusedSite(
  url: string,
  deps: LinkPreviewReadDeps,
  fail: Fail,
): Promise<LinkPreviewReadResult> {
  const refused: LinkPreviewReadResult = { ok: true, kind: "refused" };
  if (!hasBudgetForIcon(deps)) return refused;
  let home: LinkPreviewResource;
  try {
    home = await fetchPage(new URL("/", url).href, deps);
  } catch (error) {
    fail("icon", error);
    return refused;
  }
  const iconUrl =
    home.kind === "html"
      ? parseLinkPreviewHead(home.bytes, { contentType: home.contentType, url: home.url }).iconUrl
      : undefined;
  if (!iconUrl || !hasBudgetForIcon(deps)) return refused;
  const bytes = await readIcon(iconUrl, home.url, deps, fail);
  const icon = bytes && (await encodeIcon(bytes, deps, fail, MAX_ICON_WIDTH));
  return icon ? { ok: true, kind: "refused", icon } : refused;
}

function hasBudgetForIcon(deps: LinkPreviewReadDeps): boolean {
  return (
    deps.deadlineAt === undefined || deps.deadlineAt - Date.now() >= LINK_PREVIEW_ICON_MIN_BUDGET_MS
  );
}

function fetchPage(url: string, deps: LinkPreviewReadDeps): Promise<LinkPreviewResource> {
  return (deps.fetchResource ?? fetchLinkPreviewResource)(url, "page", {
    ...fetchOptionsOf(deps),
    deadlineMs: deps.pageTimeoutMs ?? LINK_PREVIEW_PAGE_TIMEOUT_MS,
  });
}

/** An image that cannot be had leaves a compact card without thumbnail, not a failure. */
async function readImage(
  imageUrl: string,
  deps: LinkPreviewReadDeps,
  fail: (stage: "image", error: unknown) => unknown,
): Promise<EncodedPreviewImage | undefined> {
  try {
    const resource = await (deps.fetchResource ?? fetchLinkPreviewResource)(imageUrl, "image", {
      ...fetchOptionsOf(deps),
      deadlineMs: deps.imageTimeoutMs ?? LINK_PREVIEW_IMAGE_TIMEOUT_MS,
    });
    return await encodePreviewImage(resource.bytes, deps.encode);
  } catch (error) {
    fail("image", error);
    return undefined;
  }
}

/** The bytes of the icon a page names, read only from that page's own site, every redirect included. */
async function readIcon(
  iconUrl: string,
  pageUrl: string,
  deps: LinkPreviewReadDeps,
  fail: Fail,
): Promise<Uint8Array | undefined> {
  try {
    const resource = await (deps.fetchResource ?? fetchLinkPreviewResource)(iconUrl, "icon", {
      ...fetchOptionsOf(deps),
      deadlineMs: deps.imageTimeoutMs ?? LINK_PREVIEW_IMAGE_TIMEOUT_MS,
      site: new URL(pageUrl).hostname,
    });
    return resource.bytes;
  } catch (error) {
    fail("icon", error);
    return undefined;
  }
}

async function encodeIcon(
  bytes: Uint8Array,
  deps: LinkPreviewReadDeps,
  fail: Fail,
  maxWidth?: number,
): Promise<EncodedPreviewImage | undefined> {
  try {
    return await encodePreviewImage(bytes, deps.encode, maxWidth);
  } catch (error) {
    fail("icon", error);
    return undefined;
  }
}

function fetchOptionsOf(deps: LinkPreviewReadDeps): LinkPreviewFetchOptions {
  return {
    ...(deps.resolveHostname ? { resolveHostname: deps.resolveHostname } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.limiter ? { limiter: deps.limiter } : {}),
  };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
