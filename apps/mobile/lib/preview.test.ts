import { describe, expect, it } from "vitest";
import { previewSnippet } from "./preview.js";

describe("previewSnippet", () => {
  it("keeps a short last message as a single plain line", () => {
    expect(previewSnippet("venue booked, contract sent")).toBe("venue booked, contract sent");
  });

  it("strips markdown and collapses a long last message to the first words", () => {
    const lastMessage = [
      "Done! ✅",
      "",
      "The inbox is **completely empty** and those drafts were **permanently deleted**.",
      "",
      "- 🗓️ **alex@example.com**",
      "- follow-up parked",
      "",
      "No data was lost.",
    ].join("\n");

    expect(previewSnippet(lastMessage)).toBe(
      "Done! ✅ The inbox is completely empty and those drafts were permanently",
    );
  });

  it("turns links, lists, and headings into readable words", () => {
    expect(previewSnippet("# Status\n- see [the report](https://example.com)")).toBe(
      "Status see the report",
    );
  });

  it("keeps a greater-than sign that does not open a quote", () => {
    expect(previewSnippet("Signed up\n>100 users today")).toBe("Signed up >100 users today");
  });

  it("returns an empty snippet when there is no message text", () => {
    expect(previewSnippet("")).toBe("");
    expect(previewSnippet("   **  **   ")).toBe("");
  });
});
