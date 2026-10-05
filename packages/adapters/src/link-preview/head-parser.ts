import { isPreviewableUrl } from "@rakazo/contracts";
import { sanitizePreviewTitle } from "@rakazo/core";
import { JSDOM } from "jsdom";

const CHARSET_SNIFF_BYTES = 4096;

export interface LinkPreviewHead {
  title?: string;
  imageUrl?: string;
}

/**
 * Title and image of an HTML head. Nothing runs and nothing loads: JSDOM is used as a parser
 * only (no `runScripts`, no `resources`), so scripts, images, frames, stylesheets and
 * `<meta http-equiv=refresh>` stay inert. `og:url` and `og:site_name` are never read.
 * `url` is the final URL of the page, the base for a relative image.
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
      return { ...(title ? { title } : {}), ...(imageUrl ? { imageUrl } : {}) };
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
