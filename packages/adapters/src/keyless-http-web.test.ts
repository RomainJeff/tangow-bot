import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { FakeWebProvider } from "./fake-web.js";
import {
  extractPageLinks,
  extractReadableText,
  KeylessHttpWebProvider,
  MAX_PAGE_LINKS,
  parseDuckDuckGoResults,
} from "./keyless-http-web.js";
import { clampMaxChars, clampMaxResults } from "./web-limits.js";
import { createWebProvider, resolveWebProviderKind } from "./web-provider-factory.js";
import { webFetchFromTool, webSearchFromTool } from "./web-tools.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const publicResolver = async () => [{ address: "8.8.8.8", family: 4 as const }];

describe("web provider factory", () => {
  it("defaults to keyless-http", () => {
    expect(resolveWebProviderKind({})).toBe("keyless-http");
    expect(createWebProvider().describe().id).toBe("keyless-http");
    expect(createWebProvider("fake").describe().id).toBe("fake");
  });
});

describe("keyless HTTP web provider", () => {
  it("searches via the HTML backend without a vendor API key", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fa">Alpha</a>
        <a class="result__snippet">Snippet A</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.test/b">Beta</a>
        <div class="result__snippet">Snippet B</div>
      </div>
    `;
    const fetchMock: typeof fetch = async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const provider = new KeylessHttpWebProvider({
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    const results = await provider.search({ query: "alpha", maxResults: 5 }, ctx);
    expect(results).toEqual([
      { title: "Alpha", url: "https://example.test/a", snippet: "Snippet A" },
      { title: "Beta", url: "https://example.test/b", snippet: "Snippet B" },
    ]);
  });

  it("fetches readable page text with truncation", async () => {
    const long = "word ".repeat(100);
    const html = `<html><head><title>Doc</title></head><body><article><p>${long}</p></article></body></html>`;
    const fetchMock: typeof fetch = async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const provider = new KeylessHttpWebProvider({
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    const result = await provider.fetch({ url: "https://example.test/doc", maxChars: 120 }, ctx);
    expect(result.title).toBeTruthy();
    expect(result.url).toBe("https://example.test/doc");
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith("[Content truncated]")).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(120 + "\n\n[Content truncated]".length);
  });

  it("collects the page links with the fetch, resolved, and returns the same text as without", async () => {
    const html = `<html><head><title>Home</title><base href="/news/"></head><body>
      <article><p>${"word ".repeat(80)}</p><a href="x/123_article">Story</a></article>
      <a href="https://other.test/y#frag">Other</a></body></html>`;
    const provider = new KeylessHttpWebProvider({
      fetch: async () =>
        new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
      resolveHostname: publicResolver,
    });
    const result = await provider.fetch({ url: "https://example.test/", maxChars: 8000 }, ctx);
    expect(result.links).toEqual([
      "https://example.test/news/x/123_article",
      "https://other.test/y",
    ]);
    expect(result.text).not.toContain("123_article");
  });

  describe("extractPageLinks", () => {
    const page = (body: string, head = "") =>
      `<html><head>${head}</head><body>${body}</body></html>`;

    it("resolves against the final URL, or a valid http(s) base", () => {
      const body = '<a href="/a">a</a><a href="b">b</a>';
      expect(extractPageLinks(page(body), "https://s.test/dir/page")).toEqual([
        "https://s.test/a",
        "https://s.test/dir/b",
      ]);
      expect(
        extractPageLinks(page(body, '<base href="https://cdn.test/root/">'), "https://s.test/p"),
      ).toEqual(["https://cdn.test/a", "https://cdn.test/root/b"]);
      expect(
        extractPageLinks(page(body, '<base href="javascript:void(0)">'), "https://s.test/dir/p"),
      ).toEqual(["https://s.test/a", "https://s.test/dir/b"]);
    });

    it("skips fragments, other schemes, credentials, unresolvable and over-long links, and dedupes", () => {
      const links = [
        "#top",
        "javascript:void(0)",
        "mailto:a@b.test",
        "tel:+33",
        "data:text/html,x",
        "https://u:p@s.test/c",
        "http://[bad",
        `/${"a".repeat(2100)}`,
        "/ok",
        "/ok#again",
        "",
      ];
      const anchors = links.map((href) => `<a href="${href}">l</a>`).join("");
      const body = `${anchors}<a>none</a>`;
      expect(extractPageLinks(page(body), "https://s.test/")).toEqual(["https://s.test/ok"]);
    });

    it("keeps at most 500 links", () => {
      const body = Array.from({ length: 600 }, (_, index) => `<a href="/p/${index}">l</a>`).join(
        "",
      );
      const links = extractPageLinks(page(body), "https://s.test/");
      expect(links).toHaveLength(MAX_PAGE_LINKS);
      expect(links[0]).toBe("https://s.test/p/0");
    });
  });

  it("falls back to HTML strip when Readability finds nothing", () => {
    const extracted = extractReadableText(
      "<html><title>Plain</title><body><div>just text here</div></body></html>",
      "https://example.test/",
    );
    expect(extracted.title).toBe("Plain");
    expect(extracted.text).toContain("just text here");
  });

  it("parses HTML search results with a cap", () => {
    const html = Array.from({ length: 12 }, (_, i) => {
      return `<div class="result"><a class="result__a" href="https://example.test/${i}">T${i}</a><div class="result__snippet">S${i}</div></div>`;
    }).join("");
    expect(parseDuckDuckGoResults(html, 3)).toHaveLength(3);
  });
});

describe("web tool apply with fake provider", () => {
  it("returns injected search and fetch results", async () => {
    const fake = new FakeWebProvider();
    fake.searchHits = [
      { title: "One", url: "https://example.test/1", snippet: "s1" },
      { title: "Two", url: "https://example.test/2", snippet: "s2" },
    ];
    fake.fetchResult = {
      url: "https://example.test/1",
      title: "One",
      text: "Body text",
      truncated: false,
    };

    await expect(webSearchFromTool(fake, ctx, { query: "q", maxResults: 1 })).resolves.toEqual({
      results: [{ title: "One", url: "https://example.test/1", snippet: "s1" }],
    });
    expect(fake.lastSearch?.query).toBe("q");

    await expect(
      webFetchFromTool(fake, ctx, { url: "https://example.test/1", maxChars: 100 }),
    ).resolves.toEqual({
      url: "https://example.test/1",
      title: "One",
      text: "Body text",
      truncated: false,
    });
  });

  it("hands the links over out of band, and returns the same tool output with or without them", async () => {
    const base = {
      url: "https://example.test/1",
      title: "One",
      text: "Body text",
      truncated: false,
    };
    const without = new FakeWebProvider();
    without.fetchResult = base;
    const withLinks = new FakeWebProvider();
    withLinks.fetchResult = { ...base, links: ["https://example.test/x/123_article"] };
    const seen: string[][] = [];
    const args = { url: base.url, maxChars: 100 };
    const plain = await webFetchFromTool(without, ctx, args, (links) => seen.push(links));
    const linked = await webFetchFromTool(withLinks, ctx, args, (links) => seen.push(links));
    expect(JSON.stringify(linked)).toBe(JSON.stringify(plain));
    expect(linked).not.toHaveProperty("links");
    expect(seen).toEqual([["https://example.test/x/123_article"]]);
  });

  it("surfaces provider errors as tool errors", async () => {
    const fake = new FakeWebProvider();
    fake.searchError = new Error("boom");
    await expect(webSearchFromTool(fake, ctx, { query: "q" })).resolves.toEqual({
      error: "boom",
    });
  });
});

describe("web tool clamps", () => {
  it("clamps maxResults and maxChars", () => {
    expect(clampMaxResults(undefined)).toBe(5);
    expect(clampMaxResults(100)).toBe(10);
    expect(clampMaxResults(0)).toBe(1);
    expect(clampMaxChars(undefined)).toBe(8_000);
    expect(clampMaxChars(10)).toBe(100);
    expect(clampMaxChars(999_999)).toBe(50_000);
  });
});
