import { describe, expect, it } from "vitest";
import { applyTextEdit } from "./file-text.js";

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
