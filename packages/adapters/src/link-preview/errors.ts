/** Why a link preview could not be produced. Transient reasons are retried by a later
 * read and never cached; definitive ones describe the link itself and may be cached. */
export type LinkPreviewFailureReason =
  | "unsafe_url"
  | "blocked_address"
  | "login_page"
  | "off_site"
  | "too_many_redirects"
  | "http_error"
  | "access_denied"
  | "unsupported_type"
  | "too_large"
  | "tls_error"
  | "timeout"
  | "network"
  | "rate_limited"
  | "server_error"
  | "busy"
  | "aborted";

const TRANSIENT_REASONS: ReadonlySet<LinkPreviewFailureReason> = new Set([
  "timeout",
  "network",
  "rate_limited",
  "server_error",
  "busy",
  "aborted",
]);

export function isTransientReason(reason: LinkPreviewFailureReason): boolean {
  return TRANSIENT_REASONS.has(reason);
}

/** Carries only a reason: never a URL, never a cause, because both can hold the full link. */
export class LinkPreviewError extends Error {
  constructor(readonly reason: LinkPreviewFailureReason) {
    super(`Link preview failed: ${reason}`);
    this.name = "LinkPreviewError";
  }
}
