import { describe, expect, it } from "vitest";
import { parseLinkPreviewHead } from "./head-parser.js";

const PAGE = "https://example.test/articles/one";
const parse = (html: string | Uint8Array, contentType: string | null = "text/html") =>
  parseLinkPreviewHead(typeof html === "string" ? new TextEncoder().encode(html) : html, {
    contentType,
    url: PAGE,
  });
const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

describe("title", () => {
  it("prefers og:title, then twitter:title, then the document title", () => {
    const all = `<head><title>Doc</title><meta name="twitter:title" content="Tw"><meta property="og:title" content="Og"></head>`;
    expect(parse(all).title).toBe("Og");
    expect(parse(all.replace(/<meta property[^>]*>/, "")).title).toBe("Tw");
    expect(parse(all.replace(/<meta[^>]*>/g, "")).title).toBe("Doc");
  });

  it("falls through empty or blank candidates", () => {
    expect(
      parse(
        `<head><meta property="og:title" content="  "><meta name="twitter:title" content="Tw"></head>`,
      ).title,
    ).toBe("Tw");
    expect(
      parse(`<head><meta property="og:title" content="​‮"><title>Doc</title></head>`).title,
    ).toBe("Doc");
  });

  it("reads og:title written with name= and any case", () => {
    expect(parse(`<head><meta NAME="OG:Title" content="Named"></head>`).title).toBe("Named");
  });

  it("decodes entities and collapses whitespace", () => {
    expect(
      parse(`<title>  Tom &amp; Jerry &eacute;t&eacute;
        &#8217;s   &lt;b&gt;&nbsp;x </title>`).title,
    ).toBe("Tom & Jerry été ’s <b> x");
  });

  it("ignores the title of an SVG", () => {
    const withBoth = `<body><svg><title>Icon</title></svg></body><head></head>`;
    expect(
      parse(`<head><title>Real</title></head><body><svg><title>Icon</title></svg>`).title,
    ).toBe("Real");
    expect(parse(withBoth).title).toBeUndefined();
    expect(
      parse(`<svg xmlns="http://www.w3.org/2000/svg"><title>Icon</title></svg>`).title,
    ).toBeUndefined();
  });

  it("strips control, bidirectional and zero-width characters", () => {
    expect(parse("<title>pay‮pal‬​.com\u0007⁦x⁩﻿</title>").title).toBe("paypal.comx");
    expect(parse("<title>a\tb\nc\u0007d</title>").title).toBe("a b cd");
  });

  it("caps the title at 300 characters", () => {
    const title = parse(`<title>${"é".repeat(500)}</title>`).title;
    expect(title).toHaveLength(300);
    const emoji = parse(`<title>${"a".repeat(299)}😀😀</title>`).title ?? "";
    expect(emoji).toBe("a".repeat(299));
  });

  it("returns nothing for a page without title", () => {
    expect(parse("<html><head></head><body>hello</body></html>")).toEqual({ article: false });
    expect(parse("")).toEqual({ article: false });
  });
});

describe("charset", () => {
  const cafe = (page: string) => latin1(page.replace("{é}", "\xe9"));

  it("uses the charset of the Content-Type header", () => {
    expect(parse(cafe("<title>Caf{é}</title>"), "text/html; charset=iso-8859-1").title).toBe(
      "Café",
    );
    expect(parse(cafe("<title>Caf{é}</title>"), 'text/html; charset="ISO-8859-1"').title).toBe(
      "Café",
    );
  });

  it("uses <meta charset> and the http-equiv form without a header charset", () => {
    expect(parse(cafe('<meta charset="windows-1252"><title>Caf{é}</title>')).title).toBe("Café");
    expect(
      parse(
        cafe(
          '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><title>Caf{é}</title>',
        ),
      ).title,
    ).toBe("Café");
  });

  it("lets the header win over the meta", () => {
    expect(
      parse(cafe('<meta charset="utf-8"><title>Caf{é}</title>'), "text/html; charset=latin1").title,
    ).toBe("Café");
  });

  it("decodes Shift_JIS", () => {
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode("<title>"),
      0x93,
      0xfa,
      0x96,
      0x7b,
      ...new TextEncoder().encode("</title>"),
    ]);
    expect(parse(bytes, "text/html; charset=shift_jis").title).toBe("日本");
  });

  it("defaults to UTF-8 and honours a byte order mark", () => {
    expect(parse("<title>Café ☕</title>").title).toBe("Café ☕");
    const bom = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode("<title>Café</title>"),
    ]);
    expect(parse(bom, "text/html; charset=iso-8859-1").title).toBe("Café");
  });

  it("falls back to UTF-8 on an unknown label", () => {
    expect(parse("<title>Café</title>", "text/html; charset=nope-9").title).toBe("Café");
    expect(parse('<meta charset="utf-16"><title>Café</title>').title).toBe("Café");
  });
});

describe("image", () => {
  const image = (head: string) => parse(`<head>${head}</head>`).imageUrl;

  it("prefers og:image over twitter:image", () => {
    expect(
      image(
        `<meta name="twitter:image" content="https://cdn.test/tw.png"><meta property="og:image" content="https://cdn.test/og.png">`,
      ),
    ).toBe("https://cdn.test/og.png");
    expect(image(`<meta name="twitter:image" content="https://cdn.test/tw.png">`)).toBe(
      "https://cdn.test/tw.png",
    );
  });

  it("resolves relative and protocol-relative URLs against the final URL", () => {
    expect(image(`<meta property="og:image" content="/img/a.png">`)).toBe(
      "https://example.test/img/a.png",
    );
    expect(image(`<meta property="og:image" content="a.png">`)).toBe(
      "https://example.test/articles/a.png",
    );
    expect(image(`<meta property="og:image" content="//cdn.test/a.png">`)).toBe(
      "https://cdn.test/a.png",
    );
  });

  it("resolves against <base href> when it is http(s)", () => {
    expect(
      image(`<base href="https://static.test/assets/"><meta property="og:image" content="a.png">`),
    ).toBe("https://static.test/assets/a.png");
    expect(image(`<base href="/root/"><meta property="og:image" content="a.png">`)).toBe(
      "https://example.test/root/a.png",
    );
  });

  it("ignores a <base href> that is not http(s)", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/",
      "ftp://x.test/",
    ]) {
      expect(image(`<base href="${href}"><meta property="og:image" content="a.png">`)).toBe(
        "https://example.test/articles/a.png",
      );
    }
  });

  it("rejects images that are not http(s) or carry credentials", () => {
    for (const content of [
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:pw@cdn.test/a.png",
      `https://cdn.test/${"a".repeat(2100)}.png`,
    ]) {
      expect(image(`<meta property="og:image" content="${content}">`)).toBeUndefined();
    }
  });

  it("falls to twitter:image when og:image is unusable", () => {
    expect(
      image(
        `<meta property="og:image" content="data:image/png;base64,AAAA"><meta name="twitter:image" content="https://cdn.test/tw.png">`,
      ),
    ).toBe("https://cdn.test/tw.png");
  });
});

describe("inert parsing", () => {
  it("runs no script, ignores refresh and og:site_name, and keeps og:url only as the page's address", () => {
    const result = parse(`<head>
      <title>Real</title>
      <script>document.title = "pwned"</script>
      <meta http-equiv="refresh" content="0;url=https://evil.test/">
      <meta property="og:url" content="https://evil.test/canonical">
      <meta property="og:site_name" content="Evil Site">
      <meta property="og:description" content="never kept">
      <link rel="stylesheet" href="https://evil.test/a.css">
    </head><body><img src="https://evil.test/p.png"><iframe src="https://evil.test/f"></iframe></body>`);
    expect(result).toEqual({
      article: false,
      title: "Real",
      canonicalUrl: "https://evil.test/canonical",
    });
  });

  it("takes the page's address from its canonical link first, resolved, and only an http(s) one", () => {
    expect(
      parse(
        `<head><meta property="og:url" content="https://example.test/og"><link rel="alternate canonical" href="/doc"></head>`,
      ).canonicalUrl,
    ).toBe("https://example.test/doc");
    expect(
      parse(`<head><link rel="canonical" href="javascript:alert(1)"></head>`).canonicalUrl,
    ).toBeUndefined();
  });

  it("copes with a truncated document and garbage", () => {
    expect(
      parse(`<html><head><title>Cut</title><meta property="og:image" content="/a.png"></head`),
    ).toEqual({
      article: false,
      title: "Cut",
      imageUrl: "https://example.test/a.png",
    });
    expect(parse(new Uint8Array([0, 255, 254, 1, 2, 3]))).toEqual({ article: false });
  });
});

describe("site icon", () => {
  const icon = (links: string, base = "") => parse(`<head><title>T</title>${base}${links}</head>`);

  it("prefers the largest apple-touch-icon, resolved against the page", () => {
    const head = icon(
      `<link rel="apple-touch-icon" sizes="120x120" href="/a120.png">
       <link rel="apple-touch-icon-precomposed" sizes="180x180" href="/a180.png">
       <link rel="icon" sizes="512x512" type="image/png" href="/i512.png">`,
    );
    expect(head.iconUrl).toBe("https://example.test/a180.png");
  });

  it("takes an apple-touch-icon without sizes, and the first of equal ones", () => {
    expect(icon(`<link rel="apple-touch-icon" href="touch.png">`).iconUrl).toBe(
      "https://example.test/articles/touch.png",
    );
    expect(
      icon(
        `<link rel="apple-touch-icon" href="/one.png"><link rel="apple-touch-icon" href="/two.png">`,
      ).iconUrl,
    ).toBe("https://example.test/one.png");
  });

  it("falls back to the largest rel=icon of 64 px or more in png, webp or jpeg", () => {
    expect(
      icon(
        `<link rel="icon" sizes="32x32" type="image/png" href="/i32.png">
         <link rel="shortcut icon" sizes="64x64" type="image/png" href="/i64.png">
         <link rel="icon" sizes="192x192" href="/i192.webp">`,
      ).iconUrl,
    ).toBe("https://example.test/i192.webp");
  });

  it("refuses rel=icon without a declared size of 64 or more, or of another type", () => {
    for (const link of [
      `<link rel="icon" href="/i.png">`,
      `<link rel="icon" sizes="32x32" href="/i.png">`,
      `<link rel="icon" sizes="any" href="/i.png">`,
      `<link rel="icon" sizes="128x128" type="image/gif" href="/i.gif">`,
      `<link rel="icon" sizes="128x128" href="/i.gif">`,
      `<link rel="icon" sizes="128x128" href="/i">`,
    ]) {
      expect(icon(link).iconUrl, link).toBeUndefined();
    }
  });

  it("never takes an SVG, a mask-icon, an ICO, or a guessed favicon", () => {
    for (const link of [
      `<link rel="icon" sizes="any" type="image/svg+xml" href="/i.svg">`,
      `<link rel="icon" sizes="128x128" href="/i.svg">`,
      `<link rel="apple-touch-icon" sizes="180x180" href="/a.svg">`,
      `<link rel="apple-touch-icon" type="image/svg+xml" href="/a.png">`,
      `<link rel="mask-icon" href="/mask.svg" color="#000">`,
      `<link rel="mask-icon" sizes="128x128" href="/mask.png">`,
      `<link rel="icon" sizes="256x256" type="image/x-icon" href="/favicon.ico">`,
      `<link rel="icon" sizes="256x256" href="/favicon.ico">`,
    ]) {
      expect(icon(link).iconUrl, link).toBeUndefined();
    }
    expect(icon("").iconUrl).toBeUndefined();
  });

  it("skips an SVG apple-touch-icon and keeps a raster one", () => {
    expect(
      icon(
        `<link rel="apple-touch-icon" sizes="512x512" href="/a.svg"><link rel="apple-touch-icon" sizes="180x180" href="/a.png">`,
      ).iconUrl,
    ).toBe("https://example.test/a.png");
  });

  it("resolves against <base href> and refuses non-http(s) or credentialed hrefs", () => {
    expect(
      icon(
        `<link rel="apple-touch-icon" href="a.png">`,
        `<base href="https://cdn.example.test/x/">`,
      ).iconUrl,
    ).toBe("https://cdn.example.test/x/a.png");
    expect(
      icon(`<link rel="apple-touch-icon" href="data:image/png;base64,AAAA">`).iconUrl,
    ).toBeUndefined();
    expect(
      icon(`<link rel="apple-touch-icon" href="javascript:alert(1)">`).iconUrl,
    ).toBeUndefined();
    expect(
      icon(`<link rel="apple-touch-icon" href="https://u:p@c.test/a.png">`).iconUrl,
    ).toBeUndefined();
  });
});

describe("article", () => {
  const article = (head: string) => parse(`<head>${head}</head>`).article;
  const ldJson = (json: string) => `<script type="application/ld+json">${json}</script>`;

  it("is declared by og:type=article, whatever the case", () => {
    expect(article(`<meta property="og:type" content="article">`)).toBe(true);
    expect(article(`<meta name="OG:Type" content=" Article ">`)).toBe(true);
  });

  it("is declared by article:published_time", () => {
    expect(article(`<meta property="article:published_time" content="2026-10-16T08:00:00Z">`)).toBe(
      true,
    );
  });

  it.each([
    ["a string type", `{"@type":"NewsArticle"}`],
    ["an array of types", `{"@type":["WebPage","BlogPosting"]}`],
    ["a root array", `[{"@type":"Organization"},{"@type":"TechArticle"}]`],
    [
      "one level of @graph",
      `{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"Report"}]}`,
    ],
  ])("is declared by JSON-LD with %s", (_name, json) => {
    expect(article(ldJson(json))).toBe(true);
  });

  it("is not declared by a home page or a document page", () => {
    // The Notion-style private page measured on 2026-10-16.
    expect(
      article(
        `<title>Notion</title><meta property="og:type" content="website"><meta property="og:url" content="https://app.notion.com"><meta property="og:title" content="Notion | Where teams and agents work together"><meta property="og:image" content="https://app.notion.com/og.png">`,
      ),
    ).toBe(false);
    expect(article(ldJson(`{"@type":["WebSite","Organization","Product"]}`))).toBe(false);
  });

  it("is not declared by a type nested deeper than @graph", () => {
    expect(article(ldJson(`{"mainEntity":{"@type":"Article"}}`))).toBe(false);
    expect(article(ldJson(`{"@graph":[{"@graph":[{"@type":"Article"}]}]}`))).toBe(false);
  });

  it("survives hostile JSON-LD without declaring an article or throwing", () => {
    const hostile = [
      "[".repeat(64 * 1024 - 1),
      `{"__proto__":{"@type":"Article"}}`,
      `{"@type":"constructor"}`,
      `{"@type":["toString","__proto__","hasOwnProperty"]}`,
      `{"@type":[${Array.from({ length: 10_000 }, () => '"x"').join(",")}]}`,
      `{"@type":`,
    ];
    const real = ldJson(`{"@type":"Article"}`);
    for (const json of hostile) {
      expect(article(ldJson(json))).toBe(false);
      expect(article(`${ldJson(json)}${real}`)).toBe(true);
    }
  });

  it("reads at most 8 scripts, 64 KB each and 256 KB in all", () => {
    const real = ldJson(`{"@type":"Article"}`);
    expect(article(`${ldJson("{}").repeat(7)}${real}`)).toBe(true);
    expect(article(`${ldJson("{}").repeat(8)}${real}`)).toBe(false);
    expect(article(ldJson(`{"@type":"Article","pad":"${"x".repeat(65 * 1024)}"}`))).toBe(false);
    expect(article(ldJson("{}").repeat(1000))).toBe(false);
    const heavy = `{"pad":"${"x".repeat(60 * 1024)}"}`;
    expect(article(`${ldJson(heavy).repeat(5)}${real}`)).toBe(false);
    const oversized = `{"pad":"${"x".repeat(200 * 1024)}"}`;
    expect(article(`${ldJson(oversized)}${ldJson(heavy)}${real}`)).toBe(true);
  });
});
