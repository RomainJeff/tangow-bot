import { isTransientReason, LinkPreviewError, type LinkPreviewFailureReason } from "./errors.js";
import { parseLinkPreviewHead } from "./head-parser.js";
import { type EncodedPreviewImage, encodePreviewImage, type ImageEncodeOptions } from "./image.js";
import {
  fetchLinkPreviewResource,
  LINK_PREVIEW_IMAGE_TIMEOUT_MS,
  LINK_PREVIEW_PAGE_TIMEOUT_MS,
  type LinkPreviewFetchOptions,
  type LinkPreviewResource,
  type LinkPreviewResourceFetcher,
} from "./safe-fetch.js";

export type LinkPreviewFormat = "large" | "photo" | "compact";

const LARGE_MIN_WIDTH = 600;
const LARGE_MIN_RATIO = 1.3;

/** The card format, decided from what was really downloaded and never from what the page declares. */
export function decideLinkPreviewFormat(input: {
  kind: "html" | "image";
  title?: string;
  image?: { width: number; height: number };
}): LinkPreviewFormat | null {
  const { kind, title, image } = input;
  if (kind === "image") return image ? "photo" : null;
  if (!title) return null;
  if (image && image.width >= LARGE_MIN_WIDTH && image.width / image.height >= LARGE_MIN_RATIO) {
    return "large";
  }
  return "compact";
}

export type LinkPreviewReadResult =
  | { ok: true; format: LinkPreviewFormat; title?: string; image?: EncodedPreviewImage }
  | { ok: false; reason: LinkPreviewFailureReason; transient: boolean };

export interface LinkPreviewReadDeps
  extends Pick<LinkPreviewFetchOptions, "resolveHostname" | "signal" | "limiter"> {
  /** Tests only (`createLinkPreviewFetcherForTests`): production composition never sets it. */
  fetchResource?: LinkPreviewResourceFetcher;
  pageTimeoutMs?: number;
  imageTimeoutMs?: number;
  encode?: ImageEncodeOptions;
  /** Receives the host of the link and a reason, never the full URL. */
  log?: (event: {
    host: string;
    stage: "page" | "image";
    reason: LinkPreviewFailureReason;
  }) => void;
}

/**
 * Read a link for a preview card: one page request and at most one image request (redirects
 * aside), a single attempt. Never throws. Transient failures (timeout, 429, 5xx, network, caps)
 * must not be cached; definitive ones describe the link and may be.
 */
export async function readLinkPreview(
  url: string,
  deps: LinkPreviewReadDeps = {},
): Promise<LinkPreviewReadResult> {
  const host = hostOf(url);
  const fail = (stage: "page" | "image", error: unknown): LinkPreviewReadResult => {
    const reason = error instanceof LinkPreviewError ? error.reason : "network";
    if (host) deps.log?.({ host, stage, reason });
    return { ok: false, reason, transient: isTransientReason(reason) };
  };

  try {
    let page: LinkPreviewResource;
    try {
      page = await (deps.fetchResource ?? fetchLinkPreviewResource)(url, "page", {
        ...fetchOptionsOf(deps),
        deadlineMs: deps.pageTimeoutMs ?? LINK_PREVIEW_PAGE_TIMEOUT_MS,
      });
    } catch (error) {
      return fail("page", error);
    }

    if (page.kind === "image") {
      try {
        return {
          ok: true,
          format: "photo",
          image: await encodePreviewImage(page.bytes, deps.encode),
        };
      } catch (error) {
        return fail("image", error);
      }
    }

    const head = parseLinkPreviewHead(page.bytes, { contentType: page.contentType, url: page.url });
    if (!head.title) return fail("page", new LinkPreviewError("no_title"));
    const image = head.imageUrl ? await readPageImage(head.imageUrl, deps, fail) : undefined;
    const format = decideLinkPreviewFormat({ kind: "html", title: head.title, image });
    if (!format) return fail("page", new LinkPreviewError("no_title"));
    return { ok: true, format, title: head.title, ...(image ? { image } : {}) };
  } catch (error) {
    return fail("page", error);
  }
}

/** A page image that cannot be had leaves a compact card without thumbnail, not a failure. */
async function readPageImage(
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
