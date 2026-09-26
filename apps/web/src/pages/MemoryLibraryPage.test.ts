import { describe, expect, it } from "vitest";
import { hasMemoryDraftChanges } from "../lib/memory-draft";

describe("hasMemoryDraftChanges", () => {
  it("does not warn for an untouched draft", () => {
    expect(hasMemoryDraftChanges(undefined, "", "")).toBe(false);
    expect(hasMemoryDraftChanges({ title: "Title", content: "body" }, "Title", "body")).toBe(false);
  });

  it("warns before text or title can be abandoned", () => {
    expect(hasMemoryDraftChanges({ title: "Title", content: "body" }, "Changed", "body")).toBe(
      true,
    );
    expect(hasMemoryDraftChanges({ title: "Title", content: "body" }, "Title", "changed")).toBe(
      true,
    );
  });

  it("warns before classification, dates, or a source excerpt selection can be abandoned", () => {
    const original = { title: "Title", content: "body" };
    expect(hasMemoryDraftChanges(original, "Title", "body", "metadata", "changed")).toBe(true);
    expect(hasMemoryDraftChanges(original, "Title", "body", "false", "true")).toBe(true);
  });
});
