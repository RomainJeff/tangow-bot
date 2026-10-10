import { describe, expect, it } from "vitest";
import { previewSnippet } from "./preview.js";

describe("previewSnippet", () => {
  it("keeps a short preview as a single line", () => {
    expect(previewSnippet("venue booked, contract sent")).toBe("venue booked, contract sent");
  });

  it("collapses a long preview to its first words", () => {
    expect(
      previewSnippet(
        "Done! ✅ The inbox is completely empty and those drafts were permanently deleted.",
      ),
    ).toBe("Done! ✅ The inbox is completely empty and those drafts were permanently");
  });

  it("leaves the server's plain text as it is, markdown-like markers included", () => {
    expect(previewSnippet("Run __main__ now", 40)).toBe("Run __main__ now");
  });

  it("returns an empty snippet when there is no preview", () => {
    expect(previewSnippet("")).toBe("");
    expect(previewSnippet("   ")).toBe("");
  });
});
