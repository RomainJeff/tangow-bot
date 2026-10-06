import { describe, expect, it } from "vitest";
import { applyTextEdit, readLineWindow } from "./file-text.js";

describe("applyTextEdit", () => {
  it("replaces a unique match", () => {
    expect(
      applyTextEdit("one\ntwo\nthree\n", { oldText: "two", newText: "2", replaceAll: false }),
    ).toEqual({ ok: true, content: "one\n2\nthree\n", replacements: 1 });
  });

  it("fails when the text is absent", () => {
    expect(applyTextEdit("one", { oldText: "two", newText: "2", replaceAll: false })).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("fails on several matches and reports the count", () => {
    expect(applyTextEdit("a a a", { oldText: "a", newText: "b", replaceAll: false })).toEqual({
      ok: false,
      error: "ambiguous",
      matches: 3,
    });
  });

  it("replaces every match with replaceAll", () => {
    expect(applyTextEdit("a-a-a", { oldText: "a", newText: "b", replaceAll: true })).toEqual({
      ok: true,
      content: "b-b-b",
      replacements: 3,
    });
  });

  it("keeps replacement patterns literal", () => {
    expect(
      applyTextEdit("price: X", { oldText: "X", newText: "$& $1 $$", replaceAll: false }),
    ).toEqual({ ok: true, content: "price: $& $1 $$", replacements: 1 });
  });

  it("rejects an empty old text", () => {
    expect(applyTextEdit("abc", { oldText: "", newText: "x", replaceAll: true })).toEqual({
      ok: false,
      error: "empty_old_text",
    });
  });
});

describe("readLineWindow", () => {
  const text = "l1\nl2\nl3\nl4\nl5\n";

  it("returns a small file whole", () => {
    expect(readLineWindow(text, { offset: 1, maxBytes: 1000 })).toEqual({
      ok: true,
      content: text,
      startLine: 1,
      endLine: 5,
      totalLines: 5,
    });
  });

  it("returns a middle window with the next offset", () => {
    expect(readLineWindow(text, { offset: 2, limit: 2, maxBytes: 1000 })).toEqual({
      ok: true,
      content: "l2\nl3\n",
      startLine: 2,
      endLine: 3,
      totalLines: 5,
      nextOffset: 4,
    });
  });

  it("omits the next offset on the last window", () => {
    expect(readLineWindow(text, { offset: 4, limit: 10, maxBytes: 1000 })).toEqual({
      ok: true,
      content: "l4\nl5\n",
      startLine: 4,
      endLine: 5,
      totalLines: 5,
    });
  });

  it("does not count a final newline as an extra line", () => {
    expect(readLineWindow("a\nb", { offset: 1, maxBytes: 1000 })).toMatchObject({
      totalLines: 2,
      content: "a\nb",
    });
    expect(readLineWindow("a\nb\n", { offset: 3, maxBytes: 1000 })).toEqual({
      ok: false,
      error: "offset_out_of_range",
      totalLines: 2,
    });
  });

  it("cuts at a line boundary when the byte cap is reached", () => {
    expect(readLineWindow(text, { offset: 1, maxBytes: 7 })).toEqual({
      ok: true,
      content: "l1\nl2\n",
      startLine: 1,
      endLine: 2,
      totalLines: 5,
      nextOffset: 3,
    });
  });

  it("counts UTF-8 bytes, not characters", () => {
    expect(readLineWindow("éé\nab\n", { offset: 1, maxBytes: 6 })).toEqual({
      ok: true,
      content: "éé\n",
      startLine: 1,
      endLine: 1,
      totalLines: 2,
      nextOffset: 2,
    });
  });

  it("fails when the first line alone exceeds the byte cap", () => {
    expect(readLineWindow("abcdefgh\nz\n", { offset: 1, maxBytes: 4 })).toEqual({
      ok: false,
      error: "line_too_long",
      totalLines: 2,
    });
  });

  it("fails when the offset is past the end", () => {
    expect(readLineWindow(text, { offset: 6, maxBytes: 1000 })).toEqual({
      ok: false,
      error: "offset_out_of_range",
      totalLines: 5,
    });
  });

  it("reads an empty file at offset 1", () => {
    expect(readLineWindow("", { offset: 1, maxBytes: 1000 })).toEqual({
      ok: true,
      content: "",
      startLine: 1,
      endLine: 0,
      totalLines: 0,
    });
    expect(readLineWindow("", { offset: 2, maxBytes: 1000 })).toEqual({
      ok: false,
      error: "offset_out_of_range",
      totalLines: 0,
    });
  });
});
