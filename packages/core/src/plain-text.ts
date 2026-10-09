/** A notification or a preview shows a line or two: reading further only costs time. */
const PLAIN_TEXT_INPUT_CHARS = 4000;

/** A link or image target, allowing one level of parentheses as in `Foo_(bar)` URLs. */
const TARGET = String.raw`\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)`;
const IMAGE = new RegExp(String.raw`!\[([^\]\n]*)\]${TARGET}`, "g");
const LINK = new RegExp(String.raw`\[([^\]\n]+)\]${TARGET}`, "g");

/** Tags a model writes in markdown; anything else in angle brackets is text, like `Array<string>`. */
const HTML_TAG =
  /<\/?(?:a|b|blockquote|br|code|del|details|div|em|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|s|small|span|strong|sub|summary|sup|table|tbody|td|th|thead|tr|u|ul)\b[^<>\n]*>/gi;

/**
 * Markdown → one plain line, for places that cannot render it: notifications and conversation
 * previews. Keeps the words a reader would see (link and image text, code, table cells) and drops
 * the syntax around them. Bare addresses stay as they are. Reads the first 4,000 characters.
 *
 * Separate from `speakable`, which rewrites for a voice (it names code blocks and replaces
 * addresses with "a link") where this keeps the written words.
 */
export function plainText(markdown: string): string {
  // Code and bare addresses are kept verbatim: set aside before the syntax passes, put back after.
  const kept: string[] = [];
  const setAside = (text: string) => `\uE000${kept.push(text) - 1}\uE000`;
  return (
    markdown
      .slice(0, PLAIN_TEXT_INPUT_CHARS)
      .replace(/\uE000/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, (_m, code: string) => setAside(code))
      .replace(/~~~[^\n]*\n?([\s\S]*?)(?:~~~|$)/g, (_m, code: string) => setAside(code))
      .replace(/`([^`\n]+)`/g, (_m, code: string) => setAside(code))
      .replace(/<((?:https?:\/\/|mailto:)[^>\s]+|[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>/g, "$1")
      .replace(/\bhttps?:\/\/[^\s<>()]+/g, (url) => setAside(url))
      .replace(IMAGE, "$1")
      .replace(LINK, "$1")
      .replace(/^(?=[^\n]*\|)(?=[^\n]*-)[ \t|:-]+$/gm, "")
      .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row: string) => row.split("|").join(" "))
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]*>(?:[ \t]+|$)/gm, "")
      .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
      .replace(/^\[[ xX]\][ \t]+/gm, "")
      // Emphasis only where its markers are not inside a word or a file name, so `2**3`,
      // `setup__main__` and `__init__.py` keep theirs.
      .replace(/(^|[^\w\\])(\*\*|__)(?=\S)((?:(?!\2).)*?\S)\2(?!\w|\.\w)/g, "$1$3")
      .replace(/(^|\s)(?:\*\*|__)(?=\s|$)/g, "$1")
      .replace(/(^|[^\w*\\])(\*|_)([^\s*_\\]|[^\s*_][^*_\n]*?[^\s*_\\])\2(?![\w*]|\.\w)/g, "$1$3")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(HTML_TAG, " ")
      .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1")
      .replace(/\uE000(\d+)\uE000/g, (_m, index: string) => kept[Number(index)] ?? "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** At most `max` characters, cut on a word when one ends late enough, then "…". */
export function clipText(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > head.length / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** What a notification shows of a message: its plain words, short enough for a lock screen. */
export function notificationBody(markdown: string): string {
  return clipText(plainText(markdown), 180);
}
