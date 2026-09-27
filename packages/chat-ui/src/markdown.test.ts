import { describe, expect, it } from "vitest";
import {
  closeUnterminatedFence,
  linkHref,
  linkifyText,
  nativeImagePolicy,
  sanitizeMarkdownUrl,
  truncateMarkdownForRender,
} from "./markdown";

describe("sanitizeMarkdownUrl", () => {
  it("allows normal external links and optionally allows local links", () => {
    expect(sanitizeMarkdownUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(sanitizeMarkdownUrl("mailto:hello@example.com")).toBe("mailto:hello@example.com");
    expect(sanitizeMarkdownUrl("/docs", true)).toBe("/docs");
    expect(sanitizeMarkdownUrl("#section", true)).toBe("#section");
  });

  it("rejects executable and embedded-data URLs", () => {
    expect(sanitizeMarkdownUrl("javascript:alert(1)", true)).toBeUndefined();
    expect(sanitizeMarkdownUrl("data:text/html,<script>alert(1)</script>", true)).toBeUndefined();
    expect(sanitizeMarkdownUrl("/docs")).toBeUndefined();
  });
});

describe("linkHref", () => {
  it("upgrades a bare domain to https and keeps unsafe targets dead", () => {
    expect(linkHref("example.com/docs")).toBe("https://example.com/docs");
    expect(linkHref("www.example.com")).toBe("https://www.example.com");
    expect(linkHref("https://example.com")).toBe("https://example.com");
    expect(linkHref("javascript:alert(1)")).toBeUndefined();
    expect(linkHref("notes")).toBeUndefined();
  });
});

describe("linkifyText", () => {
  it("links every URL in plain text and leaves the prose around it", () => {
    expect(linkifyText("See https://example.com/a, and www.example.org.")).toEqual([
      { text: "See " },
      { text: "https://example.com/a", href: "https://example.com/a" },
      { text: ", and " },
      { text: "www.example.org", href: "https://www.example.org" },
      { text: "." },
    ]);
  });

  it("keeps balanced brackets in the URL and drops the one around it", () => {
    expect(linkifyText("(https://en.wikipedia.org/wiki/Rust_(language))")).toEqual([
      { text: "(" },
      {
        text: "https://en.wikipedia.org/wiki/Rust_(language)",
        href: "https://en.wikipedia.org/wiki/Rust_(language)",
      },
      { text: ")" },
    ]);
  });

  it("returns text without URLs as a single segment", () => {
    expect(linkifyText("no links here")).toEqual([{ text: "no links here" }]);
  });
});

describe("closeUnterminatedFence", () => {
  it("temporarily closes a partial streaming code fence", () => {
    expect(closeUnterminatedFence("Before\n```ts\nconst value = 1;")).toBe(
      "Before\n```ts\nconst value = 1;\n```",
    );
  });

  it("leaves complete markdown unchanged", () => {
    const markdown = "```ts\nconst value = 1;\n```\n\nDone";
    expect(closeUnterminatedFence(markdown)).toBe(markdown);
  });
});

describe("truncateMarkdownForRender", () => {
  it("leaves short markdown untouched", () => {
    const markdown = "**Faits**\n- Spot 45,80 €";
    expect(truncateMarkdownForRender(markdown)).toBe(markdown);
  });

  it("caps an oversized digest and marks the truncation", () => {
    const huge = `${"a".repeat(50000)}`;
    const out = truncateMarkdownForRender(huge, 12000);
    expect(out.length).toBeLessThanOrEqual(12010);
    expect(out.endsWith("…")).toBe(true);
  });

  it("prefers cutting on a line boundary near the limit", () => {
    const lines = `${"x".repeat(11990)}\n${"y".repeat(2000)}`;
    const out = truncateMarkdownForRender(lines, 12000);
    expect(out).not.toContain("y");
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("nativeImagePolicy", () => {
  it("allows images and keeps the default handler when enabled", () => {
    expect(nativeImagePolicy(true)).toEqual({
      allowedImageHandlers: ["https://", "http://"],
      defaultImageHandler: "https://",
      blockImages: false,
    });
  });

  it("neutralises BOTH the allowlist and the default handler when blocking", () => {
    // Regression guard for threat model S-R1: an empty allowlist alone is not
    // enough — the library's default handler ('https://') would still reload a
    // scheme-less URL, so defaultImageHandler must be null and images dropped.
    expect(nativeImagePolicy(false)).toEqual({
      allowedImageHandlers: [],
      defaultImageHandler: null,
      blockImages: true,
    });
  });
});
