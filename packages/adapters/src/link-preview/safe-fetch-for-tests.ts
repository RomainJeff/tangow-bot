import {
  fetchLinkPreviewResourceWithSeams,
  type LinkPreviewFetchSeams,
  type LinkPreviewResourceFetcher,
} from "./safe-fetch.js";

export type { LinkPreviewFetchSeams };

/**
 * A fetcher for tests only: the real checks (URL policy, redirects, caps) around a stand-in HTTP
 * client, a stub connection pool, or the real client pointed at a local server. It is the one
 * way to reach those seams, so nothing in production code can weaken `fetchLinkPreviewResource`.
 * Inject it as `LinkPreviewReadDeps.fetchResource`.
 */
export function createLinkPreviewFetcherForTests(
  seams: LinkPreviewFetchSeams,
): LinkPreviewResourceFetcher {
  return (rawUrl, mode, options = {}) =>
    fetchLinkPreviewResourceWithSeams(rawUrl, mode, options, seams);
}
