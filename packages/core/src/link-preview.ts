import { isPreviewableUrl, LINK_PREVIEW_TITLE_MAX_LENGTH } from "@rakazo/contracts";
import { extractLinksFromText } from "./search.js";

/** Query parameter names that mark a link as a secret: never read, cached or logged. */
const SECRET_PARAM_NAMES: ReadonlySet<string> = new Set([
  "token",
  "key",
  "secret",
  "sig",
  "signature",
  "code",
  "password",
  "auth",
  "session",
  "magic",
  "reset",
  "unsubscribe",
]);

/** The one link a message may preview: its first eligible http(s) link, outside code. */
export function firstEligibleLink(text: string): string | undefined {
  return extractLinksFromText(text).find(isPreviewableUrl);
}

/** Blocks that make a message a card of its own: no link preview is ever put under it. */
const PREVIEW_HOST_EXCLUDED_KINDS: ReadonlySet<string> = new Set([
  "ask",
  "computer",
  "handoff",
  "bot_message_sent",
  "bot_message_received",
  "channel_message",
  "meta",
  "routine_run",
  "subagent",
  "child_bot",
  "cloud_agent",
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

/** True when the message is nothing but this link: bare, in `<>`, or a link labelled with itself. */
export function isLinkOnlyMessage(text: string, url: string): boolean {
  const value = text.trim();
  return value === url || value === `<${url}>` || value === `[${url}](${url})`;
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

/** True when a query parameter is named like a secret (case-insensitive). */
export function hasSecretParam(url: string): boolean {
  try {
    for (const name of new URL(url).searchParams.keys()) {
      if (SECRET_PARAM_NAMES.has(name.toLowerCase())) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const AUTHENTICATION_HOSTS: ReadonlySet<string> = new Set(["accounts.google.com"]);
const AUTHENTICATION_HOST_LABELS: ReadonlySet<string> = new Set([
  "auth",
  "authenticate",
  "authentication",
  "authenticator",
  "idp",
  "identity",
  "login",
  "oauth",
  "signin",
  "sso",
]);
const AUTHENTICATION_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "auth",
  "authenticate",
  "authorize",
  "login",
  "saml",
  "sign-in",
  "sign_in",
  "signin",
  "sso",
]);

/**
 * True when a link leads to a sign-in page, which never gets a preview: Google's account host,
 * a host label that names authentication (`login.example.com`), or a final path segment that does
 * (`/sso`, `/a/sign-in`). A path that merely contains such a word (`/blog/login-tips`) is a
 * normal page. Applied to the link as written and to every redirect hop of the server read.
 */
export function isAuthenticationDestination(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.toLowerCase();
    if (AUTHENTICATION_HOSTS.has(host)) return true;
    if (host.split(".").some((label) => AUTHENTICATION_HOST_LABELS.has(label))) return true;
    const last = pathname.split("/").filter(Boolean).at(-1);
    return (
      last !== undefined && AUTHENTICATION_PATH_SEGMENTS.has(decodeURIComponent(last).toLowerCase())
    );
  } catch {
    return false;
  }
}

/**
 * A page title made safe to render: control, bidirectional, zero-width and tag characters are
 * removed (all of them are format or control characters), whitespace is collapsed, and the
 * result is capped without splitting a surrogate pair.
 */
export function sanitizePreviewTitle(title: string): string {
  // Format characters go first (the BOM counts as whitespace, so it would otherwise leave a gap),
  // then whitespace collapses (tab and newline are controls too), then any other control goes.
  // ZWNJ and ZWJ stay: emoji sequences and several scripts need them to render correctly.
  const clean = title
    .replace(/(?![\u200C\u200D])\p{Cf}/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();
  if (clean.length <= LINK_PREVIEW_TITLE_MAX_LENGTH) return clean;
  const cut = clean.slice(0, LINK_PREVIEW_TITLE_MAX_LENGTH);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  return (lastUnit >= 0xd800 && lastUnit <= 0xdbff ? cut.slice(0, -1) : cut).trimEnd();
}
