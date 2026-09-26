/** A text edit expressed against a textarea's single Markdown source. */
export type MarkdownTextEdit = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

export type MarkdownSelection = Pick<MarkdownTextEdit, "selectionStart" | "selectionEnd">;

/** A bounded source history used when formatting changes a controlled textarea. */
export type MarkdownHistory = {
  entries: MarkdownTextEdit[];
  index: number;
};

export function createMarkdownHistory(entry: MarkdownTextEdit): MarkdownHistory {
  return { entries: [entry], index: 0 };
}

/** Records content changes while retaining the current cursor for an unchanged source. */
export function recordMarkdownHistory(
  history: MarkdownHistory,
  entry: MarkdownTextEdit,
  limit = 100,
): MarkdownHistory {
  const current = history.entries[history.index];
  if (current?.text === entry.text) {
    return {
      entries: history.entries.map((value, index) => (index === history.index ? entry : value)),
      index: history.index,
    };
  }
  const entries = [...history.entries.slice(0, history.index + 1), entry];
  const bounded = entries.slice(-limit);
  return { entries: bounded, index: bounded.length - 1 };
}

export function undoMarkdownHistory(history: MarkdownHistory): MarkdownHistory {
  return { ...history, index: Math.max(0, history.index - 1) };
}

export function redoMarkdownHistory(history: MarkdownHistory): MarkdownHistory {
  return { ...history, index: Math.min(history.entries.length - 1, history.index + 1) };
}

function selected(text: string, selection: MarkdownSelection): string {
  return text.slice(selection.selectionStart, selection.selectionEnd);
}

/** Wraps the selected text without parsing or normalising the surrounding Markdown. */
export function wrapMarkdownSelection(
  text: string,
  selection: MarkdownSelection,
  before: string,
  after = before,
  placeholder = "text",
): MarkdownTextEdit {
  const value = selected(text, selection) || placeholder;
  const replacement = `${before}${value}${after}`;
  const selectionStart = selection.selectionStart + before.length;
  return {
    text: `${text.slice(0, selection.selectionStart)}${replacement}${text.slice(selection.selectionEnd)}`,
    selectionStart,
    selectionEnd: selectionStart + value.length,
  };
}

/** Adds a prefix to each selected line, retaining exact line endings and content. */
export function prefixMarkdownLines(
  text: string,
  selection: MarkdownSelection,
  prefix: string,
): MarkdownTextEdit {
  const lineStart = text.lastIndexOf("\n", Math.max(0, selection.selectionStart - 1)) + 1;
  const lineEnd = text.indexOf("\n", selection.selectionEnd);
  const end = lineEnd === -1 ? text.length : lineEnd;
  const source = text.slice(lineStart, end);
  const replacement = source
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
  const addedBeforeSelection =
    prefix.length * source.slice(0, selection.selectionStart - lineStart).split("\n").length;
  const lineCount = source.split("\n").length;
  return {
    text: `${text.slice(0, lineStart)}${replacement}${text.slice(end)}`,
    selectionStart: selection.selectionStart + addedBeforeSelection,
    selectionEnd: selection.selectionEnd + prefix.length * lineCount,
  };
}

/** Inserts a safe, editable Markdown link template at the current selection. */
export function insertMarkdownLink(text: string, selection: MarkdownSelection): MarkdownTextEdit {
  const label = selected(text, selection) || "link text";
  const replacement = `[${label}](https://)`;
  const selectionStart = selection.selectionStart + label.length + 3;
  return {
    text: `${text.slice(0, selection.selectionStart)}${replacement}${text.slice(selection.selectionEnd)}`,
    selectionStart,
    selectionEnd: selectionStart + "https://".length,
  };
}

/** Uses a fenced block for multiline text so existing inline backticks remain literal. */
export function wrapMarkdownCode(text: string, selection: MarkdownSelection): MarkdownTextEdit {
  const value = selected(text, selection) || "code";
  return value.includes("\n") || value.includes("`")
    ? wrapMarkdownSelection(text, selection, "```\n", "\n```", "code")
    : wrapMarkdownSelection(text, selection, "`", "`", "code");
}
