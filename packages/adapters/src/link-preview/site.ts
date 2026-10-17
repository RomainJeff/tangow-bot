import { getDomain } from "tldts";

/**
 * Whether two hosts belong to one site: the same registrable domain by the public suffix list,
 * private suffixes included, so `static.figma.com` is `figma.com`'s while `a.github.io` and
 * `b.github.io` are two sites. A host without a registrable domain (an IP, `localhost`, a one-label
 * intranet name) is only its own site.
 */
export function sameSite(a: string, b: string): boolean {
  const siteA = getDomain(a, { allowPrivateDomains: true });
  const siteB = getDomain(b, { allowPrivateDomains: true });
  return siteA && siteB ? siteA === siteB : a.toLowerCase() === b.toLowerCase();
}
