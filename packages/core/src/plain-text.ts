/** A notification or a preview shows a line or two: reading further only costs time. */
const PLAIN_TEXT_INPUT_CHARS = 4000;

/** A link or image target, allowing one level of parentheses as in `Foo_(bar)` URLs. */
const TARGET = String.raw`\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)`;
const IMAGE = new RegExp(String.raw`!\[([^\]\n]*)\]${TARGET}`, "g");
const LINK = new RegExp(String.raw`\[([^\]\n]+)\]${TARGET}`, "g");

/**
 * Markdown → one plain line, for places that cannot render it: notifications and conversation
 * previews. Keeps the words a reader would see (link and image text, code, table cells) and drops
 * the syntax around them. Bare addresses stay as they are. Reads the first 4,000 characters.
 */
export function plainText(markdown: string): string {
  // Code is kept verbatim: set aside before the syntax passes, put back after them.
  const code: string[] = [];
  const setAside = (_match: string, text: string) => `\uE000${code.push(text) - 1}\uE000`;
  return markdown
    .slice(0, PLAIN_TEXT_INPUT_CHARS)
    .replace(/\uE000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, setAside)
    .replace(/~~~[^\n]*\n?([\s\S]*?)(?:~~~|$)/g, setAside)
    .replace(/`([^`\n]+)`/g, setAside)
    .replace(IMAGE, "$1")
    .replace(LINK, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/^(?=[^\n]*\|)(?=[^\n]*-)[ \t|:-]+$/gm, "")
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row: string) => row.split("|").join(" "))
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>(?:[ \t]+|$)/gm, "")
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/^\[[ xX]\][ \t]+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[^\w*\\])(\*|_)([^\s*_\\]|[^\s*_][^*_\n]*?[^\s*_\\])\2(?![\w*])/g, "$1$3")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/<\/?[a-z][^>\n]*>/gi, " ")
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1")
    .replace(/\uE000(\d+)\uE000/g, (_m, index: string) => code[Number(index)] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** At most `max` characters, cut on a word when one ends late enough, then "…". */
export function clipText(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > head.length / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}
