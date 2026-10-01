import { describe, expect, it } from "vitest";
import {
  closeUnterminatedFence,
  hasMarkdownTable,
  linkHref,
  linkifyText,
  nativeImagePolicy,
  repairMarkdownTables,
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
  it("upgrades a www. address to https and keeps other scheme-less targets dead", () => {
    expect(linkHref("www.example.com/docs")).toBe("https://www.example.com/docs");
    expect(linkHref("README.md")).toBeUndefined();
    expect(linkHref("setup.py")).toBeUndefined();
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

describe("hasMarkdownTable", () => {
  it("finds a table by its header separator row", () => {
    expect(hasMarkdownTable("Options:\n\n| # | Club |\n|---|---|\n| 1 | Palmyre |")).toBe(true);
    expect(hasMarkdownTable("| a | b |\n| :--- | ---: |")).toBe(true);
  });

  it("ignores prose with pipes or a horizontal rule", () => {
    expect(hasMarkdownTable("keep | later | out")).toBe(false);
    expect(hasMarkdownTable("Intro\n\n---\n\nOutro")).toBe(false);
  });
});

describe("repairMarkdownTables", () => {
  it("adds the separator row a bot left out, and the blank line before it", () => {
    expect(repairMarkdownTables("Positions:\nLine | Qty | Value\nNVDA | 42 | 8 295 €")).toBe(
      "Positions:\n\nLine | Qty | Value\n| --- | --- | --- |\nNVDA | 42 | 8 295 €",
    );
  });

  it("keeps a proper table as it is", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    expect(repairMarkdownTables(table)).toBe(table);
  });

  it("leaves a lone pipe line, uneven rows and code fences alone", () => {
    expect(repairMarkdownTables("a | b | c")).toBe("a | b | c");
    expect(repairMarkdownTables("a | b\nc | d | e")).toBe("a | b\nc | d | e");
    const fenced = "```\na | b\nc | d\n```";
    expect(repairMarkdownTables(fenced)).toBe(fenced);
  });

  it("ignores pipes inside inline code and escaped pipes", () => {
    const code = "Run `ls | wc -l`\nthen `cat a | sort`";
    expect(repairMarkdownTables(code)).toBe(code);
    expect(repairMarkdownTables("a \\| b | c\nd | e")).toBe("a \\| b | c\n| --- | --- |\nd | e");
    const escapedMismatch = "a \\| b | c\nd | e | f";
    expect(repairMarkdownTables(escapedMismatch)).toBe(escapedMismatch);
  });

  it("leaves blockquotes and lists alone", () => {
    const quote = "> a | b\n> c | d";
    expect(repairMarkdownTables(quote)).toBe(quote);
    const list = "- a | b\n- c | d";
    expect(repairMarkdownTables(list)).toBe(list);
    const numbered = "1. a | b\n2. c | d";
    expect(repairMarkdownTables(numbered)).toBe(numbered);
  });

  it("only closes a fence with the same marker, at least as long", () => {
    const backtick = "```\n~~~\na | b\nc | d\n```";
    expect(repairMarkdownTables(backtick)).toBe(backtick);
    const longer = "````\n```\na | b\nc | d\n````";
    expect(repairMarkdownTables(longer)).toBe(longer);
  });

  it("leaves prose with pipes alone when a real table starts right under it", () => {
    const markdown = "Options: A | B\n| x | y |\n|---|---|\n| 1 | 2 |";
    expect(repairMarkdownTables(markdown)).toBe(markdown);
  });

  it("lets hasMarkdownTable see a repaired table", () => {
    expect(hasMarkdownTable("A | B\n1 | 2")).toBe(true);
  });
});
