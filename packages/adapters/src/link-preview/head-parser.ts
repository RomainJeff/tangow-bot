import { isPreviewableUrl } from "@rakazo/contracts";
import { sanitizePreviewTitle } from "@rakazo/core";
import { JSDOM } from "jsdom";

const CHARSET_SNIFF_BYTES = 4096;

export interface LinkPreviewHead {
  title?: string;
  imageUrl?: string;
  /** The best site icon the head declares (see `pickIconUrl`), for a page with no usable image. */
  iconUrl?: string;
}

/** An icon smaller than this (declared `sizes`) is a favicon, too small for a 56 pt thumbnail. */
const MIN_ICON_SIZE = 64;

/**
 * Title and image of an HTML head. Nothing runs and nothing loads: JSDOM is used as a parser
 * only (no `runScripts`, no `resources`), so scripts, images, frames, stylesheets and
 * `<meta http-equiv=refresh>` stay inert. `og:url` and `og:site_name` are never read.
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
        .map((raw) => resolveImage(raw, base))
        .find((resolved) => resolved !== undefined);
      const iconUrl = pickIconUrl(doc, base);
      return {
        ...(title ? { title } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        ...(iconUrl ? { iconUrl } : {}),
      };
    } finally {
      dom.window.close();
    }
  } catch {
    return {};
  }
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
    const href = resolveImage(link.getAttribute("href")?.trim(), base);
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

function resolveImage(raw: string | undefined, base: string): string | undefined {
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
