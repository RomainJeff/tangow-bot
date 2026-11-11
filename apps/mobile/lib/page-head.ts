import type { PageHeadRead } from "@tangow/contracts";
import { readPageHead } from "@tangow/contracts";
import { fetch } from "expo/fetch";

/**
 * The start of the page at `url`, read by this phone for a link the server was refused (a site
 * that blocks datacenter addresses), as WhatsApp does from the sender's phone. The rules (public
 * http(s) host on its default port, no cookies or credentials, the preview reader's User-Agent,
 * 8 seconds, only up to `</head>` or 512 KiB, no image or other sub-resource, no redirect to a
 * sign-in page) live in `readPageHead`, shared with the desktop app; this only supplies the fetch.
 *
 * It is `expo/fetch` on purpose, not the global one: only it honors `redirect: "manual"` (the
 * reader checks every hop itself), streams the body, and keeps cookies out with `credentials:
 * "omit"`. React Native's own polyfill follows redirects on its own and has no body stream.
 *
 * Known residual: the phone has no API to resolve a name before connecting, so a name that
 * resolves to a private address on this phone's network is not caught here (only IP literals and
 * local names are). Only the sanitized title of what it returns reaches a card, and only for a
 * link its own sender pasted. The desktop app, which can resolve first, does check.
 */
export function readPageHeadOnDevice(
  url: string,
  signal?: AbortSignal,
): Promise<PageHeadRead | null> {
  return readPageHead(url, {
    fetch: (target, init) => fetch(target, init) as unknown as Promise<Response>,
    ...(signal ? { signal } : {}),
  }).then((page) => page ?? null);
}
