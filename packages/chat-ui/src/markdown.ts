export type ChatMarkdownProps = {
  children: string;
  streaming?: boolean;
  /** When false, images are never rendered and no remote image request is made
   * (any `![]()` node is dropped, whatever its URL). Default true keeps normal
   * bot-message rendering. Set false for untrusted background content such as a
   * routine digest (threat model S-R1). */
  allowImages?: boolean;
};

/** Cap untrusted markdown before rendering. A markdown parser walks the whole
 * string, and some sources (e.g. a routine `digest`) are unbounded in the
 * contract, so a pathological payload could jank the render thread (threat
 * model S-R4). Cuts on a line boundary near the limit and marks the truncation. */
export function truncateMarkdownForRender(markdown: string, maxChars = 12000): string {
  if (markdown.length <= maxChars) return markdown;
  const cut = markdown.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf("\n");
  const body = lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut;
  return `${body.trimEnd()}\n\n…`;
}

/** Image-loading policy for the native markdown renderer
 * (`react-native-markdown-display`). When images are blocked, neutralising the
 * handler allowlist is NOT enough: the library's `defaultImageHandler` defaults
 * to `'https://'` and would re-prefix and load a scheme-less URL, so it must be
 * set to `null` too. `blockImages` also drives a render rule that drops the
 * image node outright — the robust guard on top of the handler config (threat
 * model S-R1). Kept here, in the RN-free module, so it is unit-testable. */
export function nativeImagePolicy(allowImages: boolean): {
  allowedImageHandlers: string[];
  defaultImageHandler: string | null;
  blockImages: boolean;
} {
  return allowImages
    ? {
        allowedImageHandlers: ["https://", "http://"],
        defaultImageHandler: "https://",
        blockImages: false,
      }
    : { allowedImageHandlers: [], defaultImageHandler: null, blockImages: true };
}

const protocolPattern = /^([a-z][a-z\d+.-]*):/i;
const safeProtocols = new Set(["http", "https", "mailto", "tel"]);

export function sanitizeMarkdownUrl(url: string, allowRelative = false): string | undefined {
  const value = url.trim();
  const protocol = value.match(protocolPattern)?.[1]?.toLowerCase();

  if (protocol) return safeProtocols.has(protocol) ? value : undefined;
  if (
    allowRelative &&
    (value.startsWith("/") ||
      value.startsWith("./") ||
      value.startsWith("../") ||
      value.startsWith("#"))
  ) {
    return value;
  }
  return undefined;
}

export function closeUnterminatedFence(markdown: string): string {
  let openFence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of markdown.split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match?.[1]) continue;

    const marker = match[1][0] as "`" | "~";
    if (!openFence) {
      openFence = { marker, length: match[1].length };
      continue;
    }

    if (
      marker === openFence.marker &&
      match[1].length >= openFence.length &&
      (match[2] ?? "").trim() === ""
    ) {
      openFence = undefined;
    }
  }

  return openFence ? `${markdown}\n${openFence.marker.repeat(openFence.length)}` : markdown;
}
