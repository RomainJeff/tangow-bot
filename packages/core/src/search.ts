const CODE_MASK = "\u0000";
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// A markdown link opener, a bare URL, or a bare `www.` address (the thread linkifier's rule). The
// opener comes first so `[https://a.tld](https://b.tld)` is the link to b.tld, and the label is
// never read as a second URL.
const LINK_TOKEN_SOURCE = `\\[[^\\]\\n]*\\]\\(|(?:https?://|\\bwww\\.)[^\\s<>"${CODE_MASK}]+`;
const URL_STOP = new RegExp(`[\\s<>"${CODE_MASK}]`);
const URL_START = /^https?:\/\//i;
const TRAILING_PUNCTUATION = /[.,;:!?'"*_~]+$/;
const CLOSING_BRACKETS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

const occurrences = (value: string, char: string) => value.split(char).length - 1;

/** Overwrites fenced and inline code with NULs, keeping offsets, so links inside never match. */
function maskCode(text: string): string {
  let masked = "";
  let fence: { marker: string; length: number } | undefined;
  for (const line of text.split("\n")) {
    const opener = line.match(FENCE_OPEN);
    const marker = opener?.[1]?.[0];
    if (fence) {
      const closes =
        opener &&
        marker === fence.marker &&
        opener[1]!.length >= fence.length &&
        !opener[2]?.trim();
      if (closes) fence = undefined;
      masked += `${CODE_MASK.repeat(line.length)}\n`;
    } else if (opener && marker && !(marker === "`" && opener[2]?.includes("`"))) {
      fence = { marker, length: opener[1]!.length };
      masked += `${CODE_MASK.repeat(line.length)}\n`;
    } else {
      masked += `${line}\n`;
    }
  }
  return maskInlineCode(masked.slice(0, -1));
}

function maskInlineCode(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`") {
      result += text[index++];
      continue;
    }
    let end = index;
    while (text[end] === "`") end++;
    const run = text.slice(index, end);
    // A code span closes on a backtick run of exactly the same length.
    let close = text.indexOf(run, end);
    while (close >= 0 && (text[close - 1] === "`" || text[close + run.length] === "`")) {
      close = text.indexOf(run, close + 1);
    }
    if (close < 0) {
      result += run;
      index = end;
    } else {
      result += CODE_MASK.repeat(close + run.length - index);
      index = close + run.length;
    }
  }
  return result;
}

// Sentence punctuation and a bracket the URL did not open belong to the prose.
function trimUrlEnd(url: string): string {
  let end = url.replace(TRAILING_PUNCTUATION, "");
  for (let close = end.at(-1); close; close = end.at(-1)) {
    const open = CLOSING_BRACKETS[close];
    if (!open || occurrences(end, open) >= occurrences(end, close)) break;
    end = end.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
  }
  return end;
}

/** The URL of a markdown link ends at the `)` that closes the destination, parentheses balanced. */
function markdownDestination(text: string, start: number): string {
  let depth = 0;
  let end = start;
  while (end < text.length && !URL_STOP.test(text[end]!)) {
    if (text[end] === "(") depth++;
    else if (text[end] === ")" && depth-- === 0) break;
    end++;
  }
  return text.slice(start, end);
}

/**
 * A scheme-less `www.` address as the https link it stands for, or undefined. Other scheme-less
 * text stays no link: `README.md` or `setup.py` look like domains (.md and .py are real TLDs) but
 * are files, and so is a bare `lemonde.fr`. The one rule for which bare text counts as a link.
 */
export function wwwLinkHref(value: string): string | undefined {
  const text = value.trim();
  return /^www\.[a-z\d-]+(?:\.[a-z\d-]+)+(?:[/?#:]|$)/i.test(text) ? `https://${text}` : undefined;
}

/** A link found in text: its target and where it sits in the text. */
export interface LinkOccurrence {
  href: string;
  start: number;
  end: number;
}

/**
 * Every http(s) link in the text, in order and with its position: bare URLs, bare `www.`
 * addresses (as `https://www.…`) and the destination of markdown links, never inside fenced or
 * inline code. `end` is where the link stops, trailing punctuation excluded.
 */
export function extractLinkOccurrences(
  text: string,
  options: { includeCode?: boolean } = {},
): LinkOccurrence[] {
  const masked = options.includeCode ? text : maskCode(text);
  const token = new RegExp(LINK_TOKEN_SOURCE, "gi");
  const links: LinkOccurrence[] = [];
  for (let match = token.exec(masked); match; match = token.exec(masked)) {
    if (!match[0].startsWith("[")) {
      const url = trimUrlEnd(match[0]);
      const href = URL_START.test(url) ? url : wwwLinkHref(url);
      if (href) links.push({ href, start: match.index, end: match.index + url.length });
      continue;
    }
    // A markdown link counts by its destination; a destination that is not http(s) counts for nothing.
    const start = token.lastIndex;
    if (!URL_START.test(masked.slice(start, start + 8))) continue;
    const destination = markdownDestination(masked, start);
    const href = trimUrlEnd(destination);
    links.push({ href, start, end: start + href.length });
    token.lastIndex = start + destination.length;
  }
  return links;
}

/**
 * Every http(s) link in the text, in order and deduplicated: bare URLs, bare `www.` addresses
 * (as `https://www.…`) and the destination of markdown links, never inside fenced or inline
 * code. Parentheses stay balanced (`…/Foo_(bar)`), apostrophes are kept, and trailing sentence
 * punctuation is dropped. With `includeCode`, code is read like any other text (for page text,
 * where backticks mean nothing).
 */
export function extractLinksFromText(
  text: string,
  options: { includeCode?: boolean } = {},
): string[] {
  return [...new Set(extractLinkOccurrences(text, options).map((link) => link.href))];
}

export function matchesSearchQuery(
  query: string,
  ...fields: Array<string | undefined | null>
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return fields.some((field) => field?.toLowerCase().includes(q));
}

export function snippetAroundMatch(text: string, query: string, maxLen = 120): string {
  const q = query.trim().toLowerCase();
  if (!q) return text.slice(0, maxLen);
  const lower = text.toLowerCase();
  const index = lower.indexOf(q);
  if (index < 0) return text.slice(0, maxLen);
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, start + maxLen);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

export type SearchThreadTarget =
  | { botId: string; groupId?: undefined }
  | { groupId: string; botId?: undefined };

export function searchHitThreadTarget(hit: {
  botId?: string;
  groupId?: string;
}): SearchThreadTarget {
  if (Boolean(hit.botId) === Boolean(hit.groupId)) {
    throw new Error("Search hit must target exactly one of a bot or group");
  }
  return hit.groupId ? { groupId: hit.groupId } : { botId: hit.botId! };
}
