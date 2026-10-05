export const PAGE_HEAD_USER_AGENT: string;
export const PAGE_HEAD_ACCEPT: string;
export const PAGE_HEAD_MAX_BYTES: number;
export const PAGE_HEAD_TIMEOUT_MS: number;
export const PAGE_HEAD_MAX_REDIRECTS: number;

export function isPrivateHostLiteral(hostname: string): boolean;
/** True when an address a name resolved to is public; anything unclear is not. */
export function isPublicAddress(address: string): boolean;
/** True when a link leads to a sign-in page, which never gets a preview. */
export function isAuthenticationDestination(url: string): boolean;
/** The address a device may read (http(s), default port, no credentials, public host), or undefined. */
export function devicePageUrl(raw: unknown): string | undefined;

export interface PageHeadCollector {
  /** True once nothing more is needed (`</head` seen, or the byte cap reached). */
  push(chunk: Uint8Array): boolean;
  /** Everything kept so far, one character per byte. */
  text(): string;
}
export function createPageHeadCollector(): PageHeadCollector;

export interface PageHeadRead {
  /** The start of the page, one character per byte. */
  head: string;
  /** The response's Content-Type, so the server can honor its charset. */
  contentType: string;
}

export interface PageHeadFetchInit {
  method: "GET";
  credentials: "omit";
  redirect: "manual";
  headers: Record<string, string>;
  signal: AbortSignal;
}

/**
 * Reads the start of a page with the shell's own `fetch` (no cookies, no redirect followed by the
 * client, every hop checked, a sign-in page stops the read). The head as latin1 text with the
 * response's Content-Type, or undefined for any failure.
 */
export function readPageHead(
  rawUrl: string,
  options: {
    fetch: (url: string, init: PageHeadFetchInit) => Promise<Response>;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<PageHeadRead | undefined>;
