import { isPreviewableUrl } from "@tangow/contracts";
import { sanitizePreviewTitle } from "@tangow/core";
import { JSDOM } from "jsdom";

const CHARSET_SNIFF_BYTES = 4096;

export interface LinkPreviewHead {
  /** The page declares itself an article in its head (see `declaresArticle`): the only HTML page that gets a card. */
  article: boolean;
  title?: string;
  imageUrl?: string;
  /** The best site icon the head declares (see `pickIconUrl`). */
  iconUrl?: string;
  /**
   * The address the page gives for itself, `<link rel=canonical>` else `og:url`, only ever
   * compared with the link (a site root for a page with a path means the page read is not the
   * page asked for). Never fetched.
   */
  canonicalUrl?: string;
}

/** An icon smaller than this (declared `sizes`) is a favicon, too small for a 56 pt thumbnail. */
const MIN_ICON_SIZE = 64;

/**
 * Title and image of an HTML head. Nothing runs and nothing loads: JSDOM is used as a parser
 * only (no `runScripts`, no `resources`), so scripts, images, frames, stylesheets and
 * `<meta http-equiv=refresh>` stay inert. `og:site_name` is never read.
 * `url` is the final URL of the page, the base for a relative image or icon.
 */
export function parseLinkPreviewHead(
  bytes: Uint8Array,
  options: { contentType?: string | null; url: string },
): LinkPreviewHead {
  try {
    const dom = new JSDOM(decodeHtml(bytes, options.contentType));
    try {
      const doc = dom.window.document;
      const title = firstClean([
        metaContent(doc, "og:title"),
        metaContent(doc, "twitter:title"),
        doc.title,
      ]);
      const base = baseUrl(doc, options.url);
      const imageUrl = [metaContent(doc, "og:image"), metaContent(doc, "twitter:image")]
        .map((raw) => resolveHttpUrl(raw, base))
        .find((resolved) => resolved !== undefined);
      const iconUrl = pickIconUrl(doc, base);
      const canonicalUrl = resolveHttpUrl(canonicalHref(doc) ?? metaContent(doc, "og:url"), base);
      return {
        article: declaresArticle(doc),
        ...(title ? { title } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        ...(iconUrl ? { iconUrl } : {}),
        ...(canonicalUrl ? { canonicalUrl } : {}),
      };
    } finally {
      dom.window.close();
    }
  } catch {
    return { article: false };
  }
}

const ARTICLE_TYPES: ReadonlySet<string> = new Set([
  "Article",
  "NewsArticle",
  "BlogPosting",
  "Report",
  "ScholarlyArticle",
  "TechArticle",
  "AnalysisNewsArticle",
  "OpinionNewsArticle",
  "ReportageNewsArticle",
  "LiveBlogPosting",
]);
const MAX_JSON_LD_SCRIPTS = 8;
const MAX_JSON_LD_SCRIPT_CHARS = 64 * 1024;
const MAX_JSON_LD_TOTAL_CHARS = 256 * 1024;

/** An article says so in its head: `og:type=article`, an `article:published_time`, or a schema.org article type in JSON-LD. */
function declaresArticle(doc: Document): boolean {
  return (
    metaContent(doc, "og:type")?.toLowerCase() === "article" ||
    metaContent(doc, "article:published_time") !== undefined ||
    jsonLdDeclaresArticle(doc)
  );
}

/**
 * Reads nothing but `@type` from bounded JSON-LD: at most 8 scripts, 64 KB each, 256 KB in all, the
 * rest ignored. The page is untrusted, so the walk is flat (the root, the elements of a root array,
 * one level of `@graph`), a type is only compared with a fixed set, and the parsed value is never
 * merged into anything.
 */
function jsonLdDeclaresArticle(doc: Document): boolean {
  let scripts = 0;
  let total = 0;
  for (const script of doc.querySelectorAll("script")) {
    if (script.getAttribute("type")?.trim().toLowerCase() !== "application/ld+json") continue;
    scripts += 1;
    if (scripts > MAX_JSON_LD_SCRIPTS) return false;
    const text = script.textContent ?? "";
    if (text.length > MAX_JSON_LD_SCRIPT_CHARS) continue;
    total += text.length;
    if (total > MAX_JSON_LD_TOTAL_CHARS) return false;
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch {
      continue;
    }
    for (const node of Array.isArray(root) ? root : [root]) {
      if (hasArticleType(node)) return true;
      const graph = isRecord(node) ? node["@graph"] : undefined;
      if (Array.isArray(graph) && graph.some(hasArticleType)) return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasArticleType(node: unknown): boolean {
  if (!isRecord(node)) return false;
  const type = node["@type"];
  return Array.isArray(type)
    ? type.some((entry) => typeof entry === "string" && ARTICLE_TYPES.has(entry))
    : typeof type === "string" && ARTICLE_TYPES.has(type);
}

function firstClean(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    const clean = candidate ? sanitizePreviewTitle(candidate) : "";
    if (clean) return clean;
  }
  return undefined;
}

function metaContent(doc: Document, key: string): string | undefined {
  for (const meta of doc.querySelectorAll("meta")) {
    const names = [meta.getAttribute("property"), meta.getAttribute("name")];
    if (names.some((name) => name?.trim().toLowerCase() === key)) {
      const content = meta.getAttribute("content")?.trim();
      if (content) return content;
    }
  }
  return undefined;
}

/** `<base href>` counts only when it is itself an http(s) URL. */
function baseUrl(doc: Document, pageUrl: string): string {
  const href = doc.querySelector("base[href]")?.getAttribute("href");
  if (!href) return pageUrl;
  try {
    const base = new URL(href, pageUrl);
    return base.protocol === "http:" || base.protocol === "https:" ? base.href : pageUrl;
  } catch {
    return pageUrl;
  }
}

function canonicalHref(doc: Document): string | undefined {
  for (const link of doc.querySelectorAll("link[href]")) {
    if ((link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) {
      return link.getAttribute("href")?.trim() || undefined;
    }
  }
  return undefined;
}

type IconCandidate = { href: string; size: number; order: number };

/**
 * The site icon to fall back on, resolved like `og:image`: the largest `apple-touch-icon`
 * (`sizes` absent counts as unknown, the smallest), else the largest `rel~="icon"` that declares
 * 64 px or more and is a png, webp or jpeg (by `type`, or by extension when there is none). Never
 * an SVG (`mask-icon` included), never an ICO, and never a guessed `/favicon.ico`: only what the
 * page itself names.
 */
function pickIconUrl(doc: Document, base: string): string | undefined {
  const touch: IconCandidate[] = [];
  const plain: IconCandidate[] = [];
  let order = 0;
  for (const link of doc.querySelectorAll("link[href]")) {
    order += 1;
    const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    const isTouch =
      rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed");
    if (!isTouch && !rel.includes("icon")) continue;
    const href = resolveHttpUrl(link.getAttribute("href")?.trim(), base);
    if (!href || isVectorOrIco(href, link.getAttribute("type"))) continue;
    const size = declaredSize(link.getAttribute("sizes"));
    if (isTouch) {
      touch.push({ href, size, order });
    } else if (size >= MIN_ICON_SIZE && isRasterIcon(href, link.getAttribute("type"))) {
      plain.push({ href, size, order });
    }
  }
  const best = (list: IconCandidate[]) =>
    [...list].sort((a, b) => b.size - a.size || a.order - b.order)[0]?.href;
  return best(touch) ?? best(plain);
}

/** The largest side a `sizes` attribute declares (`180x180`, `16x16 32x32`); 0 when none or `any`. */
function declaredSize(sizes: string | null): number {
  let largest = 0;
  for (const match of (sizes ?? "").toLowerCase().matchAll(/(\d+)x(\d+)/g)) {
    largest = Math.max(largest, Math.min(Number(match[1]), Number(match[2])));
  }
  return largest;
}

function pathExtension(href: string): string {
  try {
    return /\.([a-z0-9]+)$/i.exec(new URL(href).pathname)?.[1]?.toLowerCase() ?? "";
  } catch {
    return "";
  }
}

function isVectorOrIco(href: string, type: string | null): boolean {
  const mime = (type ?? "").trim().toLowerCase();
  // `image/x-icon` and `image/vnd.microsoft.icon` both contain "ico".
  return (
    mime.includes("svg") ||
    mime.includes("ico") ||
    ["svg", "svgz", "ico", "cur"].includes(pathExtension(href))
  );
}

function isRasterIcon(href: string, type: string | null): boolean {
  const mime = (type ?? "").trim().toLowerCase();
  if (mime) return ["image/png", "image/webp", "image/jpeg", "image/jpg"].includes(mime);
  return ["png", "webp", "jpg", "jpeg"].includes(pathExtension(href));
}

function resolveHttpUrl(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  try {
    const href = new URL(raw, base).href;
    return isPreviewableUrl(href) ? href : undefined;
  } catch {
    return undefined;
  }
}

/** Charset precedence: byte order mark, then the response header, then `<meta>`, then UTF-8. */
function decodeHtml(bytes: Uint8Array, contentType: string | null | undefined): string {
  const label = bomLabel(bytes) ?? headerCharset(contentType) ?? metaCharset(bytes) ?? "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function bomLabel(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return undefined;
}

function headerCharset(contentType: string | null | undefined): string | undefined {
  return /;\s*charset\s*=\s*"?([^\s;"]+)/i.exec(contentType ?? "")?.[1];
}

/** The charset the page declares in its first bytes, read from a throwaway parse of ASCII. */
function metaCharset(bytes: Uint8Array): string | undefined {
  const head = new JSDOM(new TextDecoder("latin1").decode(bytes.subarray(0, CHARSET_SNIFF_BYTES)));
  try {
    for (const meta of head.window.document.querySelectorAll("meta")) {
      const charset = meta.getAttribute("charset");
      if (charset) return asciiSafe(charset.trim());
      if (meta.getAttribute("http-equiv")?.toLowerCase() === "content-type") {
        const declared = headerCharset(`;${meta.getAttribute("content") ?? ""}`);
        if (declared) return asciiSafe(declared);
      }
    }
    return undefined;
  } finally {
    head.window.close();
  }
}

/** The prescan reads ASCII bytes, so a meta that claims UTF-16 can only mean UTF-8. */
function asciiSafe(label: string): string {
  return label.toLowerCase().startsWith("utf-16") ? "utf-8" : label;
}
