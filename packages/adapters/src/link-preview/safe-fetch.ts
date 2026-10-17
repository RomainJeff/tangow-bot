import dns from "node:dns";
import { isIP } from "node:net";
import { LINK_PREVIEW_URL_MAX_LENGTH } from "@rakazo/contracts";
import { isAuthenticationDestination } from "@rakazo/core";
import { Agent } from "undici";
import {
  createAddressCheckedLookup,
  isPrivateAddress,
  type ResolvedAddress,
  type ResolveHostname,
} from "../network-address.js";
import { dispatcherFetch } from "../undici-fetch.js";
import { cancelResponseBody, isBlockedHostname, withAbort } from "../web-ssrf.js";
import { LinkPreviewError } from "./errors.js";
import { processReadLimiter, type ReadLimiter } from "./limits.js";
import { sameSite } from "./site.js";

export const LINK_PREVIEW_PAGE_TIMEOUT_MS = 8_000;
export const LINK_PREVIEW_IMAGE_TIMEOUT_MS = 8_000;
export const MAX_HTML_BYTES = 512 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ICON_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 5_000;
const DNS_TIMEOUT_MS = 3_000;
/** The longest the token waits for the HTTP client to close its sockets. */
const TEARDOWN_WAIT_MS = 1_000;
const HEAD_END = "</head";
/** Unauthorized, payment required, forbidden, unavailable for legal reasons. */
const ACCESS_DENIED_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 451]);
const ACCEPTED_ENCODINGS = new Set(["", "identity", "gzip", "x-gzip", "deflate", "br"]);
const TLS_ERROR_CODE = /^(ERR_TLS|ERR_SSL)|CERT|SELF_SIGNED|^UNABLE_TO_(VERIFY|GET)/;

/**
 * The only headers this code sets. The caller cannot add to them: no Cookie, Authorization or
 * Referer. The HTTP client itself adds `accept-language: *` and `sec-fetch-mode: cors` on top;
 * neither identifies the person, the space or the page, so they are accepted as they are.
 */
const FIXED_HEADERS = {
  "user-agent": "Mozilla/5.0 (compatible; RakazoLinkPreview/1.0)",
  "accept-encoding": "gzip, deflate, br",
};
const ACCEPT = {
  page: "text/html,application/xhtml+xml;q=0.9,image/*;q=0.8",
  image: "image/*",
  icon: "image/*",
};

/** `icon` is an image capped at 1 MiB that must stay on `site` at every hop. */
export type LinkPreviewFetchMode = "page" | "image" | "icon";

export type LinkPreviewResource =
  | { kind: "html"; url: string; bytes: Uint8Array; contentType: string }
  | { kind: "image"; url: string; bytes: Uint8Array; contentType: string };

export interface LinkPreviewFetchOptions {
  resolveHostname?: ResolveHostname;
  /** One deadline for connect, TLS, headers and body. */
  deadlineMs?: number;
  signal?: AbortSignal;
  limiter?: ReadLimiter;
  /**
   * A host whose site (`sameSite`) the URL and every redirect must stay on, else `off_site`.
   * Required in `icon` mode: an icon is only ever read from the site of its page.
   */
  site?: string;
}

/** Fetches one page or image: `fetchLinkPreviewResource`, or a stand-in a test injects. */
export type LinkPreviewResourceFetcher = (
  rawUrl: string,
  mode: LinkPreviewFetchMode,
  options?: LinkPreviewFetchOptions,
) => Promise<LinkPreviewResource>;

/**
 * Test seams. They live apart from `LinkPreviewFetchOptions` so that no production caller can
 * weaken the checks: only `createLinkPreviewFetcherForTests` reaches them, and this type and the
 * function that takes it are not exported from the package.
 */
export interface LinkPreviewFetchSeams {
  /** Replaces the HTTP client (the connect-time address check is then bypassed). */
  fetch?: typeof globalThis.fetch;
  /** Stands in for the client's connection pool (to watch when it is torn down). */
  dispatcher?: { destroy(): Promise<unknown> | unknown };
  /** Reaches a local server with the real client. */
  unsafeForTests?: { allowAnyPort?: boolean; isAddressAllowed?: (address: string) => boolean };
}

let caresResolver: dns.promises.Resolver | undefined;

/** Resolves through c-ares (own sockets, 3 s, one try) so a silent resolver cannot
 * occupy the libuv thread pool the way `getaddrinfo` does. */
export const caresResolveHostname: ResolveHostname = async (hostname) => {
  const literal = isIP(hostname);
  if (literal) return [{ address: hostname, family: literal }];
  caresResolver ??= new dns.promises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  const resolver = caresResolver;
  const [v4, v6] = await Promise.allSettled([
    resolver.resolve4(hostname),
    resolver.resolve6(hostname),
  ]);
  const addresses: ResolvedAddress[] = [
    ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 })) : []),
    ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 })) : []),
  ];
  if (addresses.length === 0) throw new Error("DNS resolution failed");
  return addresses;
};

/** Fetch one page or image for a link preview. Throws only `LinkPreviewError`. */
export const fetchLinkPreviewResource: LinkPreviewResourceFetcher = (rawUrl, mode, options = {}) =>
  fetchLinkPreviewResourceWithSeams(rawUrl, mode, options, {});

/** The one implementation; the package exports it only through `createLinkPreviewFetcherForTests`. */
export async function fetchLinkPreviewResourceWithSeams(
  rawUrl: string,
  mode: LinkPreviewFetchMode,
  options: LinkPreviewFetchOptions,
  seams: LinkPreviewFetchSeams,
): Promise<LinkPreviewResource> {
  const policy = seams.unsafeForTests ?? {};
  const isAddressAllowed =
    policy.isAddressAllowed ?? ((address: string) => !isPrivateAddress(address));
  if (mode === "icon" && !options.site) throw new LinkPreviewError("unsafe_url");
  const parseHop = (raw: string, base?: string) =>
    parseHopUrl(raw, base, mode, options.site, policy.allowAnyPort);
  const first = parseHop(rawUrl);
  const release = (options.limiter ?? processReadLimiter).tryAcquire(first.hostname);
  if (!release) throw new LinkPreviewError("busy");

  const resolve = options.resolveHostname ?? caresResolveHostname;
  const assertPublic = (addresses: ResolvedAddress[]) => {
    if (addresses.length === 0) throw new LinkPreviewError("network");
    if (addresses.some((entry) => !isAddressAllowed(entry.address))) {
      throw new LinkPreviewError("blocked_address");
    }
  };
  const deadline = AbortSignal.timeout(options.deadlineMs ?? LINK_PREVIEW_PAGE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const dispatcher =
    seams.dispatcher ??
    new Agent({
      connect: {
        lookup: createAddressCheckedLookup(resolve, assertPublic),
        timeout: CONNECT_TIMEOUT_MS,
      },
    });
  const fetchHop = seams.fetch ?? dispatcherFetch;

  try {
    let url = first;
    for (let redirects = 0; ; redirects += 1) {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (isBlockedHostname(host)) throw new LinkPreviewError("blocked_address");
      if (!isIP(host)) assertPublic(await withAbort(resolve(host), signal));
      const response = await withAbort(
        fetchHop(url.href, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: { ...FIXED_HEADERS, accept: ACCEPT[mode] },
          dispatcher,
        } as RequestInit & { dispatcher: unknown }),
        signal,
      );
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await cancelResponseBody(response, signal);
        if (!location) throw new LinkPreviewError("http_error");
        if (redirects >= MAX_REDIRECTS) throw new LinkPreviewError("too_many_redirects");
        url = parseHop(location, url.href);
        continue;
      }
      return await readResource(response, url.href, mode, signal);
    }
  } catch (error) {
    throw toPreviewError(error, options.signal, deadline);
  } finally {
    // The Agent is destroyed on every path; the token returns only once teardown is done. The
    // wait must not follow the read's own signal: when the deadline sounded, that signal is
    // already aborted and the token would come back while sockets are still closing.
    try {
      await settleWithin(Promise.resolve(dispatcher.destroy()), TEARDOWN_WAIT_MS);
    } finally {
      release();
    }
  }
}

/** Waits for `work` to end, or for `ms`, whichever comes first; never rejects, leaves no timer. */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([work.catch(() => undefined), elapsed]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scheme, credentials, port and length checks, applied to the first URL and every redirect. A page
 * that is a sign-in page is refused as well, and so is a hop off the required site, at the first
 * URL and at each hop.
 */
function parseHopUrl(
  raw: string,
  base: string | undefined,
  mode: LinkPreviewFetchMode,
  site: string | undefined,
  allowAnyPort = false,
): URL {
  if (raw.length > LINK_PREVIEW_URL_MAX_LENGTH) throw new LinkPreviewError("unsafe_url");
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new LinkPreviewError("unsafe_url");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    (url.port !== "" && !allowAnyPort) ||
    url.href.length > LINK_PREVIEW_URL_MAX_LENGTH
  ) {
    throw new LinkPreviewError("unsafe_url");
  }
  if (mode === "page" && isAuthenticationDestination(url.href)) {
    throw new LinkPreviewError("login_page");
  }
  if (site !== undefined && !sameSite(url.hostname, site)) throw new LinkPreviewError("off_site");
  return url;
}

async function readResource(
  response: Response,
  url: string,
  mode: LinkPreviewFetchMode,
  signal: AbortSignal,
): Promise<LinkPreviewResource> {
  if (!response.ok) {
    await cancelResponseBody(response, signal);
    if (response.status === 429) throw new LinkPreviewError("rate_limited");
    if (response.status === 408 || response.status >= 500)
      throw new LinkPreviewError("server_error");
    // A site that refuses an unknown reader (paywall, bot wall): the page is not read; the
    // caller may let the sender's device read it. Only the page: a refused image is just missing.
    if (mode === "page" && ACCESS_DENIED_STATUSES.has(response.status)) {
      throw new LinkPreviewError("access_denied");
    }
    throw new LinkPreviewError("http_error");
  }
  const encodings = (response.headers.get("content-encoding") ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase());
  const contentType = response.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const kind =
    mediaType === "text/html" || mediaType === "application/xhtml+xml"
      ? "html"
      : mediaType.startsWith("image/")
        ? "image"
        : undefined;
  if (
    encodings.length > 1 ||
    !ACCEPTED_ENCODINGS.has(encodings[0] ?? "") ||
    !kind ||
    (mode !== "page" && kind !== "image")
  ) {
    await cancelResponseBody(response, signal);
    throw new LinkPreviewError("unsupported_type");
  }
  // Content-Length can lie: it only lets an honest oversized image fail early. The byte caps
  // below apply to decoded bytes, whatever the header says.
  const imageCap = mode === "icon" ? MAX_ICON_BYTES : MAX_IMAGE_BYTES;
  if (kind === "image" && Number(response.headers.get("content-length")) > imageCap) {
    await cancelResponseBody(response, signal);
    throw new LinkPreviewError("too_large");
  }
  const bytes = await readBody(response, kind, imageCap, signal);
  return { kind, url, bytes, contentType };
}

/** HTML is cut at `</head` or 512 KiB without error; an image over its cap is an error. */
async function readBody(
  response: Response,
  kind: "html" | "image",
  imageCap: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let tail = Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      if (!value?.byteLength) continue;
      if (kind === "image") {
        total += value.byteLength;
        if (total > imageCap) throw new LinkPreviewError("too_large");
        chunks.push(value);
        continue;
      }
      const chunk = value.subarray(0, MAX_HTML_BYTES - total);
      const window = Buffer.concat([tail, chunk]);
      const end = window.toString("latin1").toLowerCase().indexOf(HEAD_END);
      if (end >= 0) {
        chunks.push(chunk.subarray(0, Math.max(0, end + HEAD_END.length - tail.length)));
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total >= MAX_HTML_BYTES) break;
      tail = window.subarray(Math.max(0, window.length - (HEAD_END.length - 1)));
    }
  } finally {
    // Stops a decoded-bytes bomb at the cap; never awaited so a stuck stream cannot outlive the deadline.
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

function toPreviewError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  deadline: AbortSignal,
): LinkPreviewError {
  if (error instanceof LinkPreviewError) return error;
  if (callerSignal?.aborted) return new LinkPreviewError("aborted");
  if (deadline.aborted) return new LinkPreviewError("timeout");
  let cause: unknown = error;
  for (let depth = 0; depth < 5 && cause instanceof Error; depth += 1) {
    if (cause instanceof LinkPreviewError) return cause;
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") {
      if (TLS_ERROR_CODE.test(code)) return new LinkPreviewError("tls_error");
      if (code.endsWith("TIMEOUT") || code === "ETIMEDOUT") return new LinkPreviewError("timeout");
    }
    cause = cause.cause;
  }
  return new LinkPreviewError("network");
}
