import { describe, expect, it } from "vitest";
import {
  createMarkdownHistory,
  insertMarkdownLink,
  prefixMarkdownLines,
  recordMarkdownHistory,
  redoMarkdownHistory,
  undoMarkdownHistory,
  wrapMarkdownCode,
  wrapMarkdownSelection,
} from "./markdown-editor.js";

describe("Markdown editor text operations", () => {
  it("wraps only the selected source", () => {
    expect(
      wrapMarkdownSelection("keep this", { selectionStart: 5, selectionEnd: 9 }, "**"),
    ).toEqual({
      text: "keep **this**",
      selectionStart: 7,
      selectionEnd: 11,
    });
  });

  it("prefixes every intersecting line without changing their content", () => {
    expect(
      prefixMarkdownLines("one\ntwo\nthree", { selectionStart: 1, selectionEnd: 7 }, "- "),
    ).toEqual({
      text: "- one\n- two\nthree",
      selectionStart: 3,
      selectionEnd: 11,
    });
  });

  it("selects the URL in an inserted link", () => {
    expect(insertMarkdownLink("", { selectionStart: 0, selectionEnd: 0 })).toEqual({
      text: "[link text](https://)",
      selectionStart: 12,
      selectionEnd: 20,
    });
  });

  it("uses a fenced block for multiline code without rewriting its source", () => {
    expect(wrapMarkdownCode("a\nb", { selectionStart: 0, selectionEnd: 3 }).text).toBe(
      "```\na\nb\n```",
    );
  });

  it("restores the source and selection around a formatting edit", () => {
    const initial = { text: "hello", selectionStart: 0, selectionEnd: 5 };
    const formatted = wrapMarkdownSelection(initial.text, initial, "**");
    const history = recordMarkdownHistory(createMarkdownHistory(initial), formatted);

    expect(undoMarkdownHistory(history).entries[0]).toEqual(initial);
    expect(redoMarkdownHistory(undoMarkdownHistory(history)).entries[1]).toEqual(formatted);
  });

  it("bounds history and drops redo entries after a new source change", () => {
    const initial = createMarkdownHistory({ text: "one", selectionStart: 3, selectionEnd: 3 });
    const two = recordMarkdownHistory(initial, { text: "two", selectionStart: 3, selectionEnd: 3 });
    const afterUndo = undoMarkdownHistory(two);
    const replacement = recordMarkdownHistory(afterUndo, {
      text: "three",
      selectionStart: 5,
      selectionEnd: 5,
    });
    const bounded = recordMarkdownHistory(
      replacement,
      {
        text: "four",
        selectionStart: 4,
        selectionEnd: 4,
      },
      2,
    );

    expect(replacement.entries.map((entry) => entry.text)).toEqual(["one", "three"]);
    expect(bounded.entries.map((entry) => entry.text)).toEqual(["three", "four"]);
  });
});
