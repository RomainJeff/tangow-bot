import { describe, expect, it } from "vitest";
import { clipText, plainText } from "./plain-text.js";

describe("plainText", () => {
  it("keeps the words of emphasis, headings, lists, quotes and links", () => {
    const message = [
      "# Status",
      "",
      "The inbox is **completely empty** and _nothing_ was ~~lost~~ kept.",
      "- see [the report](https://example.test/report)",
      "1. call back",
      "> quoted",
      "- [x] done",
      "---",
    ].join("\n");

    expect(plainText(message)).toBe(
      "Status The inbox is completely empty and nothing was lost kept. see the report call back quoted done",
    );
  });

  it("keeps code, image text and table cells as words", () => {
    const message = [
      "Run `pnpm test` then:",
      "```sh",
      "pnpm build",
      "```",
      "![the chart](https://example.test/chart.png)",
      "| City | Days |",
      "| --- | :-: |",
      "| Lima | 3 |",
    ].join("\n");

    expect(plainText(message)).toBe("Run pnpm test then: pnpm build the chart City Days Lima 3");
  });

  it("leaves bare addresses, snake_case words and redaction marks alone", () => {
    expect(plainText("read https://example.test/a_b_c and my_file_name, key [redacted]")).toBe(
      "read https://example.test/a_b_c and my_file_name, key [redacted]",
    );
    expect(plainText("<https://example.test>")).toBe("https://example.test");
  });

  it("unescapes escaped markers instead of treating them as emphasis", () => {
    expect(plainText("2 \\* 3 = 6 and \\*not bold\\*")).toBe("2 * 3 = 6 and *not bold*");
    expect(plainText("2 * 3 * 4 is *x*")).toBe("2 * 3 * 4 is x");
  });

  it("keeps code verbatim, even when it looks like markdown", () => {
    expect(plainText("Run `ls *.ts` on `src/**/*.ts` and `__init__.py`")).toBe(
      "Run ls *.ts on src/**/*.ts and __init__.py",
    );
  });

  it("keeps a link's text when its address has parentheses", () => {
    expect(plainText("see [Foo](https://example.test/wiki/Foo_(bar)) now")).toBe("see Foo now");
  });

  it("keeps a greater-than sign that does not open a quote", () => {
    expect(plainText("a\n>100 users\n> quoted")).toBe("a >100 users quoted");
  });

  it("stays fast on long runs of blank lines or unclosed syntax", () => {
    const started = performance.now();
    for (const input of [
      "\n".repeat(20_000),
      "  \n".repeat(8000),
      "[a".repeat(10_000),
      "<a ".repeat(10_000),
    ]) {
      plainText(input);
    }
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("returns an empty string when only syntax remains", () => {
    expect(plainText("")).toBe("");
    expect(plainText("   **  **   ")).toBe("");
  });
});

describe("clipText", () => {
  it("keeps text that fits", () => {
    expect(clipText("short enough", 20)).toBe("short enough");
  });

  it("cuts on a word and ends with an ellipsis", () => {
    expect(clipText("the quick brown fox jumps", 18)).toBe("the quick brown…");
  });

  it("cuts inside a word when no word ends late enough", () => {
    expect(clipText("supercalifragilistic", 10)).toBe("supercali…");
  });

  it("never splits an emoji", () => {
    expect(clipText("🎉🎉🎉🎉", 3)).toBe("🎉🎉…");
  });
});
