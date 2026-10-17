import {
  isAuthenticationDestination,
  isPreviewableUrl,
  LINK_PREVIEW_TITLE_MAX_LENGTH,
} from "@rakazo/contracts";
import { extractLinkOccurrences, wwwLinkHref } from "./search.js";

/**
 * Words that mark a query parameter as a secret when its name holds one (`access_token`,
 * `apiKey`, `X-Goog-Signature`): the link is never read, cached or logged.
 */
const SECRET_PARAM_WORDS: ReadonlySet<string> = new Set([
  "token",
  "key",
  "secret",
  "sig",
  "signature",
  "password",
  "auth",
  "session",
  "magic",
  "reset",
  "unsubscribe",
  "apikey",
  "credential",
  "jwt",
  "otp",
  "ticket",
]);

/** Prefixes of presigned cloud storage links (S3, GCS): every such parameter belongs to one. */
const SECRET_PARAM_PREFIXES = ["x-amz-", "x-goog-"];

/**
 * Whole path segments that mark a one-shot or invitation link (`/invite/…`, `/reset/…`): compared
 * whole after decoding and lowercasing, so `/blog/how-to-reset-password` is still read.
 */
const SECRET_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "unsubscribe",
  "optout",
  "opt-out",
  "confirm",
  "verify",
  "activate",
  "reset",
  "invite",
  "accept",
  "magic",
  "token",
  "redeem",
  "claim",
  "approve",
  "shared_invite",
]);

function hasSecretPath(url: string): boolean {
  return new URL(url).pathname.split("/").some((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // A malformed escape is compared as written.
    }
    return SECRET_PATH_SEGMENTS.has(decoded.toLowerCase());
  });
}

/**
 * The one identity of a link, for the server that reads it, the cache that remembers it and the
 * renderers that match it to its block: a bare `www.` form as its https link, then
 * `normalizePreviewUrl` (fragment dropped). Null when it is no http(s) URL.
 */
export function linkKey(href: string): string | null {
  const key = normalizePreviewUrl(wwwLinkHref(href) ?? href);
  return key && isPreviewableUrl(key) ? key : null;
}

/**
 * Whether a link may be read at all: http(s), bounded and without credentials, no secret in its
 * query or path, not a sign-in page. Every link of a message passes it before any counting.
 */
export function isEligibleLink(url: string): boolean {
  return (
    isPreviewableUrl(url) &&
    !hasSecretParam(url) &&
    !hasSecretPath(url) &&
    !isAuthenticationDestination(url)
  );
}

export const LINK_MENTIONS_PER_MESSAGE = 5;

/** A link a message may show as a mention: its identity and the URL as first written. */
export interface LinkCandidate {
  key: string;
  url: string;
}

/**
 * The links of a text that may become mentions: the first five distinct keys in text order among
 * eligible links outside code. The first one is also the only one that may get a card.
 */
export function linkMentionCandidates(text: string): LinkCandidate[] {
  const candidates = new Map<string, LinkCandidate>();
  for (const { href } of extractLinkOccurrences(text)) {
    if (candidates.size === LINK_MENTIONS_PER_MESSAGE) break;
    const key = linkKey(href);
    if (key && !candidates.has(key) && isEligibleLink(href)) {
      candidates.set(key, { key, url: href });
    }
  }
  return [...candidates.values()];
}

/** Blocks that make a message a card of its own: no link preview is ever put under it. */
const PREVIEW_HOST_EXCLUDED_KINDS: ReadonlySet<string> = new Set([
  "ask",
  "computer",
  "handoff",
  "channel_message",
  "meta",
  "routine_run",
  "child_bot",
  "mcp_approval",
]);

/**
 * Whether a message may carry a link preview at all: the one rule the server uses to decide
 * what to read, and web and iOS use to decide what to draw. A message that is itself a card (an
 * ask, a routine run, a handoff, a message between bots or from a channel, a computer or
 * sub-agent block, an approval) or a choice not yet answered never does, and neither does a
 * system message.
 */
export function messageHostsLinkPreview(message: {
  role: string;
  blocks: readonly unknown[];
}): boolean {
  if (message.role === "system") return false;
  for (const block of message.blocks) {
    const { kind, answerId } = (block && typeof block === "object" ? block : {}) as {
      kind?: unknown;
      answerId?: unknown;
    };
    if (typeof kind !== "string") continue;
    if (PREVIEW_HOST_EXCLUDED_KINDS.has(kind)) return false;
    if (kind === "choice" && !answerId) return false;
  }
  return true;
}

/**
 * True when the message is nothing but this link: bare (a `www.` address included, for the
 * https link it stands for), in `<>`, or a link labelled with itself.
 */
export function isLinkOnlyMessage(text: string, url: string): boolean {
  const value = text.trim();
  const isLink = (form: string) => form === url || wwwLinkHref(form) === url;
  return (
    isLink(value) ||
    (value.startsWith("<") && value.endsWith(">") && isLink(value.slice(1, -1))) ||
    value === `[${url}](${url})`
  );
}

/**
 * The form a link is cached in: `new URL(x).href` without the fragment. Scheme and host are
 * lowercased, IDN becomes punycode and a default port goes away; path, query, `%xx` escapes and a
 * trailing slash are never touched. Null when the text is not a URL.
 */
export function normalizePreviewUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * The site shown on a card: the host of the link as sent, one leading `www.` removed, punycode
 * kept (never Unicode, so a lookalike host stays visible as one). The caller must not truncate it.
 */
export function previewSiteLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * The letter a card without a picture shows in its thumbnail: the first letter or digit of the site
 * (`previewSiteLabel`), uppercased. Empty when the site has none.
 */
export function previewSiteInitial(url: string): string {
  return (
    previewSiteLabel(url)
      .match(/[\p{L}\p{N}]/u)?.[0]
      ?.toUpperCase() ?? ""
  );
}

/**
 * The message text without the lines that are only the previewed link (bare, in `<>`, a markdown
 * link labelled with itself or a bare `www.` form of it; see `isLinkOnlyMessage`), for a bubble
 * whose card already shows that link. A link inside a sentence, in a list or a quote, indented as
 * code or in a fenced block stays. The blank line a removal leaves is dropped and the text is
 * trimmed of the blank lines around it; text with no such line comes back unchanged and an empty
 * result means nothing was left to say. Stored, copied and searched text is never this one.
 */
export function textWithoutPreviewedLinkLine(text: string, url: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let fence: string | undefined;
  let removed = false;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    } else if (marker) {
      fence = marker;
    } else if (!/^(?: {4}|\t)/.test(line) && line.trim() && isLinkOnlyMessage(line, url)) {
      removed = true;
      continue;
    } else if (removed && !line.trim() && !kept.at(-1)?.trim()) {
      // The blank line that followed a removal, next to another blank line or the start.
      continue;
    }
    kept.push(line);
  }
  if (!removed) return text;
  while (kept.length > 0 && !kept[0]?.trim()) kept.shift();
  while (kept.length > 0 && !kept.at(-1)?.trim()) kept.pop();
  return kept.join("\n");
}

function isSecretParamName(name: string): boolean {
  const lower = name.toLowerCase();
  // An OAuth grant is `code` alone; `country_code` or `lang_code` are ordinary.
  if (lower === "code") return true;
  if (SECRET_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => SECRET_PARAM_WORDS.has(word));
}

/** True when a query parameter is named like a secret, by any word of its name (case-insensitive). */
export function hasSecretParam(url: string): boolean {
  try {
    for (const name of new URL(url).searchParams.keys()) {
      if (isSecretParamName(name)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// One implementation, in contracts: the desktop main process (which cannot import this package)
// applies the same rule to the pages its device reads.
export { isAuthenticationDestination };

/**
 * A page title made safe to render: control, bidirectional, zero-width and tag characters are
 * removed (all of them are format or control characters), whitespace is collapsed, and the
 * result is capped at `max` without splitting a surrogate pair.
 */
export function sanitizePreviewTitle(title: string, max = LINK_PREVIEW_TITLE_MAX_LENGTH): string {
  // Format characters go first (the BOM counts as whitespace, so it would otherwise leave a gap),
  // then whitespace collapses (tab and newline are controls too), then any other control goes.
  // ZWNJ and ZWJ stay: emoji sequences and several scripts need them to render correctly.
  const clean = title
    .replace(/(?![\u200C\u200D])\p{Cf}/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  return (lastUnit >= 0xd800 && lastUnit <= 0xdbff ? cut.slice(0, -1) : cut).trimEnd();
}

/** A single-letter article or `qu` before a vowel or `h`, which French elides (`j ai` is `j'ai`). */
const SLUG_ELISION = /(^|\s)(qu|[jldnsmtc]) (?=[aeiouàâäéèêëîïôöùûüœæh])/giu;

const SLUG_EXTENSION = /\.(?:html?|php)$/i;
const SLUG_TRAILING_ID = /(?:[-_]\d+)+$/;
/** A trailing UUID or hexadecimal id of 16 characters or more (`Roadmap-3f9a2c7e81d04b5f`, a Notion page). */
const SLUG_HEX_ID =
  /(?:^|[-_])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

/**
 * A title drawn from the address alone: the last non-empty path segment, percent-decoded, without
 * extension (`.html`, `.htm`, `.php`), trailing UUID or long hexadecimal id, or trailing numeric id
 * (`_6788472_3210`, `-12345`), dashes and underscores as spaces, French elisions restored (`j ai`
 * gives `j'ai`; accents are never guessed), first letter capitalised. Null unless two words with a
 * letter remain, or one when an id was cut from it (`Roadmap-<id>` is a document's name; a bare
 * `edit` or `politique` names a section, not a page).
 */
export function previewTitleFromUrl(url: string): string | null {
  let segment: string | undefined;
  try {
    segment = new URL(url).pathname.split("/").filter(Boolean).at(-1);
  } catch {
    return null;
  }
  if (!segment) return null;
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape stays as written.
  }
  const named = decoded.replace(SLUG_EXTENSION, "");
  const withoutId = named.replace(SLUG_HEX_ID, "");
  const title = sanitizePreviewTitle(withoutId.replace(SLUG_TRAILING_ID, "").replace(/[-_]+/g, " "))
    .replace(SLUG_ELISION, "$1$2'")
    .replace(/^\p{L}/u, (first) => first.toUpperCase());
  const words = title.split(" ").filter((word) => /\p{L}/u.test(word)).length;
  return words >= (withoutId === named ? 2 : 1) ? title : null;
}
