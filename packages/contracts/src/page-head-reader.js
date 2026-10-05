/**
 * The device side of a link preview: how a sender's own device reads the start of a page the
 * server was refused. One implementation for every native shell (iOS, desktop main process); each
 * shell injects only its own `fetch`. Plain JavaScript on purpose: the Electron main process loads
 * it without a build step.
 *
 * What the device may do, and nothing more: GET one http(s) page on its default port, no cookies,
 * no credentials, no referrer, the preview reader's User-Agent, 8 seconds in all, never a script
 * and never a sub-resource (no image, no icon, no stylesheet). Only the text up to `</head>` (or
 * 512 KiB) is kept, one character per byte, and handed to the server, which treats it as untrusted.
 */

export const PAGE_HEAD_USER_AGENT = "Mozilla/5.0 (compatible; RakazoLinkPreview/1.0)";
export const PAGE_HEAD_ACCEPT = "text/html,application/xhtml+xml;q=0.9";
export const PAGE_HEAD_MAX_BYTES = 512 * 1024;
export const PAGE_HEAD_TIMEOUT_MS = 8_000;
export const PAGE_HEAD_MAX_REDIRECTS = 5;
const PAGE_HEAD_URL_MAX_LENGTH = 2048;
const HEAD_END = "</head";

/** @param {number} a @param {number} b @param {number} c */
function isReservedIpv4(a, b, c) {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/**
 * True for a host the device must never be asked to reach: `localhost`, `.localhost`, `.local`
 * and `.internal` names, a reserved or private IPv4 literal, and any IPv6 literal that is not in
 * the global unicast block (so loopback, link-local, unique-local, IPv4-mapped and NAT64 forms
 * all refuse). A name that only looks numeric but is not a plain dotted address refuses too.
 * @param {string} hostname as `URL.hostname` gives it (IPv6 in brackets)
 */
export function isPrivateHostLiteral(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || host === "localhost") return true;
  if (/\.(localhost|local|internal|lan|localdomain|home|corp|intranet|test)$/.test(host))
    return true;
  if (host.endsWith(".home.arpa")) return true;
  if (host.startsWith("[")) return !isGlobalIpv6(host.slice(1, -1));
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (quad) {
    const parts = quad.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return true;
    return isReservedIpv4(parts[0], parts[1], parts[2]);
  }
  // A single label (`router`, `nas`) is a name of the local network, never a public site.
  if (!host.includes(".")) return true;
  // `2130706433`, `0177.0.0.1`, `0x7f.1`: an IPv4 in disguise, refused whatever it points to.
  return /^(0x[0-9a-f]*|\d+)$/.test(host.slice(host.lastIndexOf(".") + 1));
}

/**
 * True when an address a name resolved to is public. Anything unclear (an IPv4-mapped IPv6 in
 * dotted form, an unparsable text) counts as not public.
 * @param {string} address as `dns.lookup` or `session.resolveHost` gives it
 */
export function isPublicAddress(address) {
  const bare = address.replace(/^\[|\]$/g, "");
  return !isPrivateHostLiteral(bare.includes(":") ? `[${bare}]` : bare);
}

const AUTHENTICATION_HOSTS = new Set(["accounts.google.com"]);
const AUTHENTICATION_HOST_LABELS = new Set([
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
const AUTHENTICATION_PATH_SEGMENTS = new Set([
  "auth",
  "authenticate",
  "authorize",
  "login",
  "saml",
  "sign-in",
  "sign_in",
  "signin",
  "sso",
  "wp-login",
]);
const AUTHENTICATION_PATH_ENDINGS = new Set(["session/new", "sessions/new"]);
const SINGLE_USE_PATH_SEGMENTS = new Set([
  "activate",
  "activation",
  "confirm",
  "confirmation",
  "invitation",
  "invite",
  "magic-link",
  "magic_link",
  "magiclink",
  "password-reset",
  "password_reset",
  "reset-password",
  "reset_password",
  "unsubscribe",
  "verify",
  "verification",
]);

/**
 * True when a link leads to a sign-in page or spends itself when opened, which never gets a
 * preview: Google's account host, a host label that names authentication (`login.example.com`), a
 * final path segment that does (`/sso`, `/a/sign-in`, `/wp-login.php`, `/session/new`), or any
 * path segment of a single-use link (`/magic-link/<token>`, `/verify/<token>`, `/invite/<code>`).
 * A path that merely contains such a word (`/blog/login-tips`) is a normal page. Applied to the
 * link as written and to every redirect hop of a server or device read.
 * @param {string} url
 */
export function isAuthenticationDestination(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.toLowerCase();
    if (AUTHENTICATION_HOSTS.has(host)) return true;
    if (host.split(".").some((label) => AUTHENTICATION_HOST_LABELS.has(label))) return true;
    const segments = pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodePathSegment(segment).toLowerCase());
    if (segments.some((segment) => SINGLE_USE_PATH_SEGMENTS.has(segment))) return true;
    if (AUTHENTICATION_PATH_ENDINGS.has(segments.slice(-2).join("/"))) return true;
    const last = segments.at(-1)?.replace(/\.(?:html?|php|aspx?|jsp)$/, "");
    return last !== undefined && AUTHENTICATION_PATH_SEGMENTS.has(last);
  } catch {
    return false;
  }
}

/** @param {string} segment */
function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** @param {string} literal an IPv6 address without brackets */
function isGlobalIpv6(literal) {
  const hextets = expandIpv6(literal);
  if (!hextets) return false;
  const first = hextets[0];
  if (first < 0x2000 || first > 0x3fff) return false;
  // Documentation (2001:db8::/32), Teredo (2001::/32) and 6to4 (2002::/16, an IPv4 inside).
  if (first === 0x2001 && (hextets[1] === 0x0db8 || hextets[1] === 0)) return false;
  return first !== 0x2002;
}

/** @param {string} literal @returns {number[] | undefined} eight 16-bit groups */
function expandIpv6(literal) {
  // A dotted IPv4 tail never comes out of `URL.hostname` (it is rewritten in hex): refuse it.
  if (!/^[0-9a-f:]+$/.test(literal)) return undefined;
  const halves = literal.split("::");
  if (halves.length > 2) return undefined;
  /** @param {string} part */
  const groups = (part) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const all = [...head, ...tail];
  const missing = 8 - all.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const filled =
    halves.length === 2
      ? [...all.slice(0, head.length), ...new Array(missing).fill("0"), ...all.slice(head.length)]
      : all;
  if (filled.length !== 8) return undefined;
  const numbers = filled.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : -1));
  return numbers.some((n) => n < 0) ? undefined : numbers;
}

/**
 * The address the device may read, or undefined: http(s) only, no credentials, the scheme's
 * default port only, a public host (see `isPrivateHostLiteral`) and not a sign-in page. The
 * fragment is dropped. A name is only checked as written; where it resolves is the shell's check.
 * @param {unknown} raw
 * @returns {string | undefined}
 */
export function devicePageUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > PAGE_HEAD_URL_MAX_LENGTH) {
    return undefined;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password || url.port) return undefined;
  if (isPrivateHostLiteral(url.hostname)) return undefined;
  // A sign-in page never gets a preview: the read stops there, on the first address or a redirect.
  if (isAuthenticationDestination(url.href)) return undefined;
  url.hash = "";
  return url.href;
}

/** @param {Uint8Array} bytes */
function latin1(bytes) {
  let out = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    out += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return out;
}

/**
 * Collects the start of a page: feed it the body chunks, it keeps up to the first `</head` or
 * `PAGE_HEAD_MAX_BYTES` and says when it has enough. The text is latin1 (one character per byte)
 * so the server can rebuild the exact bytes and decode them like a page it fetched itself.
 */
export function createPageHeadCollector() {
  /** @type {string[]} */
  const parts = [];
  let bytes = 0;
  let tail = "";
  let done = false;
  return {
    /** @param {Uint8Array} chunk @returns {boolean} true once nothing more is needed */
    push(chunk) {
      if (done) return true;
      const piece = latin1(chunk.subarray(0, PAGE_HEAD_MAX_BYTES - bytes));
      const window = tail + piece;
      const end = window.toLowerCase().indexOf(HEAD_END);
      if (end >= 0) {
        parts.push(piece.slice(0, Math.max(0, end + HEAD_END.length - tail.length)));
        done = true;
        return true;
      }
      parts.push(piece);
      bytes += piece.length;
      tail = window.slice(Math.max(0, window.length - (HEAD_END.length - 1)));
      done = bytes >= PAGE_HEAD_MAX_BYTES;
      return done;
    },
    text: () => parts.join(""),
  };
}

/**
 * Reads the start of the page at `rawUrl` with the shell's own `fetch`. Returns the head as latin1
 * text with the response's Content-Type (for its charset), or undefined for anything that is not a plain HTML page read in time: a refused address,
 * a redirect to one (every hop is checked, five at most), a status other than 2xx, another content
 * type, a timeout, a network error. Never throws and never reports why.
 *
 * The `fetch` must follow no redirect itself (`redirect: "manual"`) and send no cookie
 * (`credentials: "omit"`); this function asks for both and refuses a response that followed one.
 * @param {string} rawUrl
 * @param {{
 *   fetch: (url: string, init: Record<string, unknown>) => Promise<Response>,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{ head: string, contentType: string } | undefined>}
 */
export async function readPageHead(rawUrl, options) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, options.timeoutMs ?? PAGE_HEAD_TIMEOUT_MS);
  try {
    if (options.signal?.aborted) return undefined;
    let target = devicePageUrl(rawUrl);
    for (let hop = 0; target && hop <= PAGE_HEAD_MAX_REDIRECTS; hop += 1) {
      const response = await options.fetch(target, {
        method: "GET",
        credentials: "omit",
        redirect: "manual",
        headers: { "user-agent": PAGE_HEAD_USER_AGENT, accept: PAGE_HEAD_ACCEPT },
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        void response.body?.cancel().catch(() => undefined);
        target = location ? devicePageUrl(new URL(location, target).href) : undefined;
        continue;
      }
      if (response.status < 200 || response.status >= 300 || response.redirected) return undefined;
      const contentType = response.headers.get("content-type") ?? "";
      if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
        void response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const head = await readHead(response, controller.signal);
      return head === undefined ? undefined : { head, contentType: contentType.slice(0, 200) };
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
    controller.abort();
  }
}

/** @param {Response} response @param {AbortSignal} signal */
async function readHead(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const collector = createPageHeadCollector();
  try {
    for (;;) {
      if (signal.aborted) return undefined;
      const { done, value } = await reader.read();
      if (done || collector.push(value)) break;
    }
  } finally {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  }
  const text = collector.text();
  return text === "" ? undefined : text;
}
