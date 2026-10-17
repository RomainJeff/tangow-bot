import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createReadLimiter } from "./limits.js";
import {
  cardOf,
  decideLinkPreviewFormat,
  type IconReads,
  type LinkPreviewReadDeps,
  type LinkPreviewReadResult,
  mentionOf,
  readLinkPreview,
  readLinkPreviewFromHead,
} from "./read-link-preview.js";
import { createLinkPreviewFetcherForTests } from "./safe-fetch-for-tests.js";

describe("decideLinkPreviewFormat", () => {
  it.each([
    // [input, expected]
    [{ kind: "html", article: true, title: "T", image: { width: 600, height: 460 } }, "large"],
    [{ kind: "html", article: true, title: "T", image: { width: 650, height: 500 } }, "large"],
    [{ kind: "html", article: true, title: "T", image: { width: 1200, height: 630 } }, "large"],
    [{ kind: "html", article: true, title: "T", image: { width: 600, height: 462 } }, "compact"],
    [{ kind: "html", article: true, title: "T", image: { width: 599, height: 200 } }, "compact"],
    [{ kind: "html", article: true, title: "T", image: { width: 800, height: 800 } }, "compact"],
    [{ kind: "html", article: true, title: "T", image: { width: 400, height: 400 } }, "compact"],
    [{ kind: "html", article: true, title: "T" }, "compact"],
    [{ kind: "html", article: true, image: { width: 1200, height: 630 } }, null],
    [{ kind: "html", article: true, title: "", image: { width: 1200, height: 630 } }, null],
    [{ kind: "html", article: true }, null],
    [{ kind: "html", article: false, title: "T", image: { width: 1200, height: 630 } }, null],
    [{ kind: "html", article: false, title: "T" }, null],
    [{ kind: "html", title: "T", image: { width: 1200, height: 630 } }, null],
    [{ kind: "image", image: { width: 10, height: 10 } }, "photo"],
    [{ kind: "image", title: "ignored", image: { width: 2000, height: 100 } }, "photo"],
    [{ kind: "image" }, null],
  ] as const)("%j gives %s", (input, expected) => {
    expect(decideLinkPreviewFormat(input)).toBe(expected);
  });
});

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#cc3366" } })
    .png()
    .toBuffer();
const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];
const page = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const imageResponse = (bytes: BodyInit, type = "image/png") =>
  new Response(bytes, { headers: { "content-type": type } });

type Route = (url: string) => Response | Promise<Response>;
function deps(route: Route, extra: LinkPreviewReadDeps = {}) {
  const requests: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    requests.push(String(input));
    return route(String(input));
  });
  return {
    requests,
    fetchMock,
    deps: {
      fetchResource: createLinkPreviewFetcherForTests({ fetch: fetchMock }),
      resolveHostname: publicResolver,
      limiter: createReadLimiter(),
      ...extra,
    } satisfies LinkPreviewReadDeps,
  };
}

const ARTICLE = "https://news.example.test/story";
const ART = '<meta property="og:type" content="article">';
const asArticle = (html: string) => html.replace("<head>", `<head>${ART}`);
const articleHead = (image: string) =>
  `<head>${ART}<title>Doc title</title><meta property="og:title" content="Story &amp; more"><meta property="og:image" content="${image}"></head><body>x</body>`;

/** What a card caller gets: the card a read makes (null for none), or the read's failure. */
const cardFrom = (read: LinkPreviewReadResult) => (read.ok ? cardOf(read) : read);
const readCard = async (url: string, d: LinkPreviewReadDeps) =>
  cardFrom(await readLinkPreview(url, d));
const readCardFromHead = async (url: string, head: Uint8Array, d: LinkPreviewReadDeps) =>
  cardFrom(await readLinkPreviewFromHead(url, head, d));

describe("readLinkPreview: formats", () => {
  it("builds a large card from a downloaded 1200 x 630 image", async () => {
    const big = await png(1200, 630);
    const { deps: d, requests } = deps((url) =>
      url === ARTICLE ? page(articleHead("/og.png")) : imageResponse(big),
    );
    const result = await readCard(ARTICLE, d);
    expect(result).toMatchObject({
      format: "large",
      title: "Story & more",
      image: { width: 1200, height: 630 },
    });
    expect(requests).toEqual([ARTICLE, "https://news.example.test/og.png"]);
  });

  it("uses the downloaded size, not the declared one", async () => {
    const small = await png(300, 300);
    const { deps: d } = deps((url) =>
      url === ARTICLE
        ? page(
            `${articleHead("/og.png")}<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
          )
        : imageResponse(small),
    );
    const result = await readCard(ARTICLE, d);
    expect(result).toMatchObject({
      format: "compact",
      image: { width: 300, height: 300 },
    });
  });

  it("builds a compact card without thumbnail when the image cannot be downloaded", async () => {
    for (const failing of [
      () => new Response("gone", { status: 404 }),
      () => new Response("down", { status: 503 }),
      () => imageResponse(new Uint8Array([1, 2, 3, 4])),
      () => new Response("<html>", { headers: { "content-type": "text/html" } }),
      () => Response.redirect("http://127.0.0.1/a.png", 302),
    ]) {
      const { deps: d } = deps((url) =>
        url === ARTICLE ? page(articleHead("/og.png")) : failing(),
      );
      const result = await readCard(ARTICLE, d);
      expect(result).toEqual({ format: "compact", title: "Story & more" });
    }
  });

  it("builds a photo card from a direct image link, without title", async () => {
    const photo = await png(800, 600);
    const { deps: d } = deps(() => imageResponse(photo, "image/png"));
    const result = await readCard("https://img.example.test/a.png", d);
    expect(result).toMatchObject({ format: "photo", image: { width: 800, height: 600 } });
    expect(result).not.toHaveProperty("title");
  });

  it("follows the page to its final URL for a relative image", async () => {
    const image = await png(700, 400);
    const { deps: d, requests } = deps((url) => {
      if (url === "https://short.example.test/x")
        return Response.redirect("https://news.example.test/a/b/c", 301);
      if (url === "https://news.example.test/a/b/c") return page(articleHead("../og.png"));
      return imageResponse(image);
    });
    const result = await readCard("https://short.example.test/x", d);
    expect(result).toMatchObject({ format: "large" });
    expect(requests.at(-1)).toBe("https://news.example.test/a/og.png");
  });

  it("makes one page request and at most two image requests: the page's image, then the icon", async () => {
    const { deps: d, fetchMock } = deps((url) =>
      url === ARTICLE
        ? page(
            `<head>${ART}<title>Doc</title><meta property="og:image" content="/og.png"><link rel="apple-touch-icon" href="/t.png"><link rel="icon" sizes="128x128" type="image/png" href="/i.png"></head>`,
          )
        : new Response("x", { status: 500 }),
    );
    await readCard(ARTICLE, d);
    // The page, og.png, then only the first icon candidate: never a second icon.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reads no image when the page names none", async () => {
    const { deps: d, fetchMock } = deps(() => page(`<head>${ART}<title>Only title</title></head>`));
    expect(await readCard(ARTICLE, d)).toEqual({ format: "compact", title: "Only title" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("readLinkPreview: failures are classified", () => {
  const run = (route: Route, extra?: LinkPreviewReadDeps, url = ARTICLE) =>
    readCard(url, deps(route, extra).deps);

  it.each([
    [
      "plain text",
      () => new Response("hi", { headers: { "content-type": "text/plain" } }),
      "unsupported_type",
    ],
    [
      "a PDF",
      () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
      "unsupported_type",
    ],
    ["a 404", () => new Response("no", { status: 404 }), "http_error"],
    ["a 410", () => new Response("no", { status: 410 }), "http_error"],
    ["a broken direct image", () => imageResponse(new Uint8Array([9, 9, 9])), "unsupported_type"],
    [
      "an SVG",
      () =>
        imageResponse(
          new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
          "image/svg+xml",
        ),
      "unsupported_type",
    ],
    ["a redirect loop", () => Response.redirect(ARTICLE, 302), "too_many_redirects"],
  ] as const)("%s is definitive (%s)", async (_name, route, reason) => {
    expect(await run(route)).toEqual({ ok: false, reason, transient: false });
  });

  it("gives a page without title no card", async () => {
    expect(await run(() => page("<html><body>hi</body></html>"))).toBeNull();
  });

  it.each([
    "http://127.0.0.1/",
    "http://localhost/admin",
    "http://[::1]/",
    "http://169.254.169.254/latest",
    "https://example.test:8443/",
    "file:///etc/passwd",
    "gopher://example.test/",
    "http://user:pw@example.test/",
  ])("a blocked target %s is definitive", async (url) => {
    const result = await run(() => page("<title>x</title>"), undefined, url);
    expect(result).toMatchObject({ ok: false, transient: false });
    expect(["blocked_address", "unsafe_url"]).toContain((result as { reason: string }).reason);
  });

  it("flags a too large direct image as definitive", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    expect(await run(() => imageResponse(big))).toEqual({
      ok: false,
      reason: "too_large",
      transient: false,
    });
  });

  it.each([
    ["a 429", () => new Response("slow down", { status: 429 }), "rate_limited"],
    ["a 500", () => new Response("oops", { status: 500 }), "server_error"],
    ["a 503", () => new Response("oops", { status: 503 }), "server_error"],
    [
      "a network error",
      () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
        });
      },
      "network",
    ],
  ] as const)("%s is transient (%s)", async (_name, route, reason) => {
    expect(await run(route)).toEqual({ ok: false, reason, transient: true });
  });

  it("flags a timeout as transient", async () => {
    const result = await run(() => new Promise<Response>(() => undefined), { pageTimeoutMs: 60 });
    expect(result).toEqual({ ok: false, reason: "timeout", transient: true });
  });

  it("flags a saturated process as transient", async () => {
    const limiter = createReadLimiter({ total: 0, perHost: 1 });
    expect(await run(() => page("<title>x</title>"), { limiter })).toEqual({
      ok: false,
      reason: "busy",
      transient: true,
    });
  });

  it("flags a caller cancellation as transient", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await run(() => page("<title>x</title>"), { signal: controller.signal })).toEqual({
      ok: false,
      reason: "aborted",
      transient: true,
    });
  });

  it("never throws, whatever the dependencies do", async () => {
    const weird = [
      deps(() => {
        throw "a string, not an Error";
      }).deps,
      {
        ...deps(() => page("<title>x</title>")).deps,
        resolveHostname: async () => Promise.reject(new Error("dns")),
      },
      { ...deps(() => page("<title>x</title>")).deps, resolveHostname: () => undefined as never },
    ];
    for (const d of weird) {
      expect(await readCard(ARTICLE, d)).toMatchObject({ ok: false });
    }
    expect(await readCard("", deps(() => page("")).deps)).toMatchObject({ ok: false });
    expect(await readCard(undefined as never, deps(() => page("")).deps)).toMatchObject({
      ok: false,
    });
  });
});

describe("readLinkPreview: logs", () => {
  it("only ever logs the host, never path, query or fragment", async () => {
    const secretUrl = "https://h.tld/p/SECRETPATH?token=SECRET#f";
    const png1 = await png(50, 50);
    const routes: Route[] = [
      () => new Response("no", { status: 404 }),
      () => new Response("slow", { status: 429 }),
      () => Response.redirect("http://127.0.0.1/?token=SECRET", 302),
      () => Response.redirect("https://h.tld:8443/?token=SECRET", 302),
      () => Response.redirect(secretUrl, 302),
      () => page("<p>no title</p>"),
      () => imageResponse(new Uint8Array([1, 2, 3])),
      () => new Promise<Response>(() => undefined),
      () => {
        throw new TypeError(`fetch failed ${secretUrl}`, { cause: new Error(secretUrl) });
      },
      (url) =>
        url === secretUrl
          ? page(
              `${ART}<title>t</title><meta property="og:image" content="/img.png?token=SECRET#f">`,
            )
          : new Response("gone", { status: 404 }),
      (url) =>
        url === secretUrl
          ? page(
              `${ART}<title>t</title><meta property="og:image" content="/img.png?token=SECRET#f">`,
            )
          : imageResponse(new Uint8Array([1, 2, 3])),
      (url) =>
        url === secretUrl
          ? page(
              `${ART}<title>t</title><meta property="og:image" content="/img.png?token=SECRET#f">`,
            )
          : imageResponse(png1),
    ];
    const events: unknown[] = [];
    const results: unknown[] = [];
    for (const route of routes) {
      results.push(
        await readCard(secretUrl, {
          ...deps(route, { pageTimeoutMs: 40 }).deps,
          log: (event) => events.push(event),
        }),
      );
    }
    expect(events.length).toBeGreaterThan(8);
    for (const event of events) {
      expect(event).toEqual({
        host: "h.tld",
        stage: expect.any(String),
        reason: expect.any(String),
      });
    }
    const everything = JSON.stringify([events, results]);
    for (const leak of ["SECRET", "token", "/p/", "#f", "img.png", "?"]) {
      expect(everything).not.toContain(leak);
    }
  });
});

describe("readLinkPreview: site icon fallback (CA 61-63)", () => {
  const homeHead = (links: string, og = "") =>
    `<head>${ART}<title>Home</title>${og}${links}</head><body>x</body>`;

  it("uses the apple-touch-icon as the thumbnail of a compact card when the page has no image", async () => {
    const icon = await png(180, 180);
    const { deps: d, requests } = deps((url) =>
      url === ARTICLE
        ? page(homeHead(`<link rel="apple-touch-icon" sizes="180x180" href="/touch.png">`))
        : imageResponse(icon),
    );
    const result = await readCard(ARTICLE, d);
    expect(result).toMatchObject({
      format: "compact",
      title: "Home",
      image: { width: 180, height: 180, fit: "contain" },
    });
    expect(requests).toEqual([ARTICLE, "https://news.example.test/touch.png"]);
  });

  it("never makes a large card from an icon, however big it is", async () => {
    const huge = await png(1200, 600);
    const { deps: d } = deps((url) =>
      url === ARTICLE
        ? page(homeHead(`<link rel="apple-touch-icon" href="/touch.png">`))
        : imageResponse(huge),
    );
    const result = await readCard(ARTICLE, d);
    expect(result).toMatchObject({ format: "compact", image: { fit: "contain" } });
  });

  it("falls back to the icon when the page image cannot be downloaded", async () => {
    const icon = await png(128, 128);
    const { deps: d, requests } = deps((url) => {
      if (url === ARTICLE) {
        return page(
          homeHead(
            `<link rel="icon" sizes="128x128" type="image/png" href="/i.png">`,
            `<meta property="og:image" content="/og.png">`,
          ),
        );
      }
      return url.endsWith("/og.png") ? new Response("gone", { status: 404 }) : imageResponse(icon);
    });
    const result = await readCard(ARTICLE, d);
    expect(result).toMatchObject({ format: "compact", image: { fit: "contain" } });
    expect(requests).toEqual([
      ARTICLE,
      "https://news.example.test/og.png",
      "https://news.example.test/i.png",
    ]);
  });

  it("keeps a page image over the icon, cropped as before", async () => {
    const small = await png(300, 300);
    const { deps: d, requests } = deps((url) =>
      url === ARTICLE
        ? page(
            homeHead(
              `<link rel="apple-touch-icon" href="/touch.png">`,
              `<meta property="og:image" content="/og.png">`,
            ),
          )
        : imageResponse(small),
    );
    const result = await readCard(ARTICLE, d);
    expect(result).toEqual({
      format: "compact",
      title: "Home",
      image: expect.objectContaining({ width: 300, height: 300 }),
    });
    expect(requests).toEqual([
      ARTICLE,
      "https://news.example.test/og.png",
      "https://news.example.test/touch.png",
    ]);
  });

  it("gives a compact card without thumbnail and asks for no favicon when there is no usable icon", async () => {
    for (const links of [
      "",
      `<link rel="icon" sizes="any" type="image/svg+xml" href="/i.svg">`,
      `<link rel="mask-icon" href="/mask.svg">`,
      `<link rel="icon" href="/favicon.ico">`,
      `<link rel="icon" sizes="32x32" href="/small.png">`,
    ]) {
      const { deps: d, requests } = deps((url) =>
        url === ARTICLE ? page(homeHead(links)) : imageResponse(new Uint8Array([1])),
      );
      const result = await readCard(ARTICLE, d);
      expect(result, links).toEqual({ format: "compact", title: "Home" });
      expect(requests, links).toEqual([ARTICLE]);
    }
  });

  it("leaves a compact card without thumbnail when the icon cannot be used", async () => {
    for (const failing of [
      () => new Response("gone", { status: 404 }),
      () => imageResponse(new Uint8Array([1, 2, 3, 4])),
      () => imageResponse("<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml"),
    ]) {
      const { deps: d } = deps((url) =>
        url === ARTICLE ? page(homeHead(`<link rel="apple-touch-icon" href="/t.png">`)) : failing(),
      );
      expect(await readCard(ARTICLE, d)).toEqual({ format: "compact", title: "Home" });
    }
  });

  it("goes through the same checks as any image: a private address is refused", async () => {
    const { deps: d, requests } = deps((url) =>
      url === ARTICLE
        ? page(homeHead(`<link rel="apple-touch-icon" href="http://127.0.0.1/t.png">`))
        : imageResponse(new Uint8Array([1])),
    );
    expect(await readCard(ARTICLE, d)).toEqual({ format: "compact", title: "Home" });
    expect(requests).toEqual([ARTICLE]);
  });

  describe("the job's deadline", () => {
    const withIcon = (url: string) =>
      url === ARTICLE ? page(homeHead(`<link rel="apple-touch-icon" href="/t.png">`)) : undefined;

    it("does not try the icon when less than 3 s of the budget remain, and caches nothing", async () => {
      const { deps: d, requests } = deps(
        (url) => withIcon(url) ?? imageResponse(new Uint8Array([1])),
        { deadlineAt: Date.now() + 2_000 },
      );
      expect(await readCard(ARTICLE, d)).toEqual({
        ok: false,
        reason: "timeout",
        transient: true,
      });
      expect(requests).toEqual([ARTICLE]);
    });

    it("tries the icon when enough of the budget remains", async () => {
      const icon = await png(128, 128);
      const { deps: d, requests } = deps((url) => withIcon(url) ?? imageResponse(icon), {
        deadlineAt: Date.now() + 10_000,
      });
      expect(await readCard(ARTICLE, d)).toMatchObject({ image: { fit: "contain" } });
      expect(requests).toHaveLength(2);
    });

    it("is transient when the deadline cuts the icon read short, not a final card without thumbnail", async () => {
      const controller = new AbortController();
      const { deps: d } = deps(
        (url) => {
          const response = withIcon(url);
          if (response) return response;
          controller.abort();
          return new Response("late", { status: 500 });
        },
        { signal: controller.signal },
      );
      expect(await readCard(ARTICLE, d)).toEqual({
        ok: false,
        reason: "aborted",
        transient: true,
      });
    });

    it("keeps an article's card without the icon when the deadline cuts only the icon read short", async () => {
      const big = await png(1200, 630);
      const controller = new AbortController();
      const { deps: d } = deps(
        (url) => {
          if (url === ARTICLE) {
            return page(
              homeHead(
                `<link rel="apple-touch-icon" href="/t.png">`,
                '<meta property="og:image" content="/og.png">',
              ),
            );
          }
          if (url.endsWith("/og.png")) return imageResponse(big);
          controller.abort();
          return new Response("late", { status: 500 });
        },
        { signal: controller.signal },
      );
      expect(await readLinkPreview(ARTICLE, d)).toEqual({
        ok: true,
        kind: "page",
        article: true,
        title: "Home",
        image: expect.objectContaining({ width: 1200, height: 630 }),
      });
    });

    it("is transient when the deadline cuts the page image read short", async () => {
      const controller = new AbortController();
      const { deps: d } = deps(
        (url) => {
          if (url === ARTICLE) return page(articleHead("/og.png"));
          controller.abort();
          return new Response("late", { status: 500 });
        },
        { signal: controller.signal },
      );
      expect(await readCard(ARTICLE, d)).toMatchObject({ ok: false, transient: true });
    });
  });
});

describe("mentionOf", () => {
  const icon = { key: "icon-1" };
  const DOC = "https://app.notion.test/team/Roadmap-Q4-0123456789abcdef";

  it("takes the page title and icon", () => {
    expect(mentionOf(DOC, { kind: "page", article: false, title: "Roadmap", icon })).toEqual({
      title: "Roadmap",
      icon,
    });
  });

  it("falls back on the path label for a title from another site, none, or a refused page", () => {
    const fromElsewhere = {
      kind: "page",
      article: false,
      title: "Sign in",
      crossSite: true,
    } as const;
    expect(mentionOf(DOC, fromElsewhere)).toEqual({ title: "Roadmap Q4" });
    expect(mentionOf(DOC, { kind: "page", article: true })).toEqual({ title: "Roadmap Q4" });
    expect(mentionOf(DOC, { kind: "refused", icon })).toEqual({ title: "Roadmap Q4", icon });
  });

  it("still makes a mention when only the host is left, and caps a long title at 80", () => {
    expect(mentionOf("https://figma.test/file/x/edit", { kind: "page", article: false })).toEqual(
      {},
    );
    const long = mentionOf(DOC, { kind: "page", article: false, title: "a".repeat(200) });
    expect(long?.title).toBe("a".repeat(80));
  });

  it("leaves an unreadable link or a direct image plain", () => {
    expect(mentionOf(DOC, { kind: "unreadable" })).toBeNull();
    expect(mentionOf(DOC, { kind: "photo", image: { width: 1, height: 1 } })).toBeNull();
  });
});

describe("readLinkPreview: pages that are not articles", () => {
  const NOTION = "https://app.notion.test/workspace/Roadmap-0123456789abcdef";
  // The private Notion-style page measured on 2026-10-16: HTTP 200, a marketing title and image.
  const notionPage = () =>
    page(
      `<head><title>Notion</title><meta property="og:type" content="website"><meta property="og:url" content="https://app.notion.test"><meta property="og:title" content="Notion | Where teams and agents work together"><meta property="og:image" content="/og.png"></head>`,
    );

  it("gets no card, however good its image, and its image is never downloaded", async () => {
    const big = await png(1200, 630);
    const { deps: d, requests } = deps((url) =>
      url === NOTION ? notionPage() : imageResponse(big),
    );
    expect(await readCard(NOTION, d)).toBeNull();
    expect(requests).toEqual([NOTION]);
  });

  it("gets a card once it declares an article", async () => {
    const { deps: d } = deps(() =>
      page(
        `<head><title>Post</title><script type="application/ld+json">{"@graph":[{"@type":"BlogPosting"}]}</script></head>`,
      ),
    );
    expect(await readCard(NOTION, d)).toEqual({ format: "compact", title: "Post" });
  });

  it.each([401, 402, 403, 451])(
    "a site that answers %i gets no card: it cannot be known",
    async (status) => {
      const { deps: d, requests } = deps(
        () =>
          new Response("<head><title>Closed</title></head>", {
            status,
            headers: { "content-type": "text/html" },
          }),
      );
      expect(await readCard(`${ARTICLE}/a-long-readable-slug-title`, d)).toBeNull();
      // The page, then its home page for an icon, refused as well.
      expect(requests).toEqual([
        `${ARTICLE}/a-long-readable-slug-title`,
        "https://news.example.test/",
      ]);
    },
  );

  it("makes no card for a login page or a blocked address", async () => {
    const loginUrl = "https://login.monde.example.test/article/some-long-title-here";
    const login = deps(() => notionPage());
    expect(await readCard(loginUrl, login.deps)).toMatchObject({
      ok: false,
      reason: "login_page",
    });
    expect(login.requests).toEqual([]);
    const blocked = deps(() => notionPage());
    expect(await readCard("http://127.0.0.1/some-long-title-here", blocked.deps)).toMatchObject({
      ok: false,
      reason: "blocked_address",
    });
    expect(blocked.requests).toEqual([]);
  });
});

describe("readLinkPreviewFromHead: the head a device read", () => {
  const bytes = (text: string, encoding: "utf8" | "latin1" = "utf8") => Buffer.from(text, encoding);

  it("parses it like a fetched page and fetches the image itself, for a large card", async () => {
    const big = await png(1200, 630);
    const { deps: d, requests } = deps(() => imageResponse(big));
    const result = await readCardFromHead(ARTICLE, bytes(articleHead("/og.png")), d);
    expect(result).toMatchObject({ format: "large", title: "Story & more" });
    // One request, for the image the head names, resolved against the link: no page request.
    expect(requests).toEqual(["https://news.example.test/og.png"]);
  });

  it("resolves the image against a valid <base href>, and ignores one that is not http(s)", async () => {
    const small = await png(300, 300);
    const based = deps(() => imageResponse(small));
    await readCardFromHead(
      ARTICLE,
      bytes(
        asArticle(
          '<head><base href="https://cdn.example.test/assets/"><title>T</title><meta property="og:image" content="og.png"></head>',
        ),
      ),
      based.deps,
    );
    expect(based.requests).toEqual(["https://cdn.example.test/assets/og.png"]);
    const bad = deps(() => imageResponse(small));
    await readCardFromHead(
      ARTICLE,
      bytes(
        asArticle(
          '<head><base href="javascript:alert(1)"><title>T</title><meta property="og:image" content="og.png"></head>',
        ),
      ),
      bad.deps,
    );
    expect(bad.requests).toEqual(["https://news.example.test/og.png"]);
  });

  it("falls back to the icon the head names, drawn whole, and never makes it a large card", async () => {
    const icon = await png(180, 180);
    const { deps: d, requests } = deps(() => imageResponse(icon));
    const result = await readCardFromHead(
      ARTICLE,
      bytes(
        asArticle('<head><title>T</title><link rel="apple-touch-icon" href="/touch.png"></head>'),
      ),
      d,
    );
    expect(result).toMatchObject({ format: "compact", title: "T", image: { fit: "contain" } });
    expect(requests).toEqual(["https://news.example.test/touch.png"]);
  });

  it("decodes the charset the head declares, like the server does", async () => {
    const { deps: d } = deps(() => new Response("no", { status: 404 }));
    const result = await readCardFromHead(
      ARTICLE,
      bytes(
        asArticle('<head><meta charset="iso-8859-1"><title>Caf\u00e9 du jour</title></head>'),
        "latin1",
      ),
      d,
    );
    expect(result).toMatchObject({ format: "compact", title: "Café du jour" });
  });

  it("cleans the title the way a fetched title is cleaned", async () => {
    const { deps: d } = deps(() => new Response("no", { status: 404 }));
    const result = await readCardFromHead(
      ARTICLE,
      bytes(asArticle(`<head><title>  Hello \u202eevil\u200b \n  &amp; world  </title></head>`)),
      d,
    );
    expect(result).toMatchObject({ title: "Hello evil & world" });
  });

  it("gives a compact card without thumbnail when the image cannot be had, and nothing without a title", async () => {
    const { deps: d } = deps(() => new Response("gone", { status: 404 }));
    expect(await readCardFromHead(ARTICLE, bytes(articleHead("/og.png")), d)).toEqual({
      format: "compact",
      title: "Story & more",
    });
    expect(await readCardFromHead(ARTICLE, bytes(asArticle("<head></head>")), d)).toBeNull();
  });

  it("gives no card for a head that does not declare an article, and never reads its image", async () => {
    const { deps: d, requests } = deps(() => imageResponse(new Uint8Array([1])));
    const result = await readCardFromHead(
      ARTICLE,
      bytes(
        '<head><title>T</title><meta property="og:type" content="website"><meta property="og:image" content="/og.png"></head>',
      ),
      d,
    );
    expect(result).toBeNull();
    expect(requests).toEqual([]);
  });

  it("never asks for a private image address the device-supplied head names", async () => {
    const { deps: d, requests } = deps(() => imageResponse(new Uint8Array([1])));
    const result = await readCardFromHead(
      ARTICLE,
      bytes(
        asArticle(
          '<head><title>T</title><meta property="og:image" content="http://127.0.0.1/secret.png"></head>',
        ),
      ),
      d,
    );
    expect(result).toMatchObject({ format: "compact", title: "T" });
    expect(requests).toEqual([]);
  });
});

describe("readLinkPreview: the facts one read records", () => {
  const head = (inner: string) => page(`<head>${inner}</head><body>x</body>`);
  const icon64 = { width: 64, height: 64 };

  it("records the site icon of every page, re-encoded to 64 px, article or not", async () => {
    const icon = await png(180, 180);
    const { deps: d, requests } = deps((url) =>
      url === ARTICLE
        ? head(`<title>Doc</title><link rel="apple-touch-icon" href="/touch.png">`)
        : imageResponse(icon),
    );
    expect(await readLinkPreview(ARTICLE, d)).toEqual({
      ok: true,
      kind: "page",
      article: false,
      title: "Doc",
      icon: expect.objectContaining(icon64),
    });
    expect(requests).toEqual([ARTICLE, "https://news.example.test/touch.png"]);
  });

  it("reads an article for a mention without its page image, and records it unread", async () => {
    const icon = await png(180, 180);
    const { deps: d, requests } = deps((url) =>
      url === ARTICLE
        ? head(
            `${ART}<title>Doc</title><meta property="og:image" content="/og.png"><link rel="apple-touch-icon" href="/i.png">`,
          )
        : imageResponse(icon),
    );
    expect(await readLinkPreview(ARTICLE, { ...d, pageImage: false })).toEqual({
      ok: true,
      kind: "page",
      article: "unread",
      title: "Doc",
      icon: expect.objectContaining(icon64),
    });
    expect(requests).toEqual([ARTICLE, "https://news.example.test/i.png"]);
  });

  it("reads one icon per site for all the links of a job (CA 23)", async () => {
    const icon = await png(64, 64);
    const { deps: d, requests } = deps((url) =>
      url.endsWith(".png")
        ? imageResponse(icon)
        : head(`<title>${url.slice(-1)}</title><link rel="apple-touch-icon" href="/i.png">`),
    );
    const icons: IconReads = new Map();
    const first = await readLinkPreview("https://docs.example.test/a", { ...d, icons });
    const second = await readLinkPreview("https://docs.example.test/b", { ...d, icons });
    expect([first, second]).toMatchObject([
      { title: "a", icon: icon64 },
      { title: "b", icon: icon64 },
    ]);
    expect(requests).toEqual([
      "https://docs.example.test/a",
      "https://docs.example.test/i.png",
      "https://docs.example.test/b",
    ]);
  });

  it.each([
    ['<meta property="og:url" content="https://app.notion.test">', "og:url at the site root"],
    ['<link rel="Canonical" href="/">', "a canonical link to the site root"],
  ])("drops a title that names the site: %s (%s), for a link with a path", async (canonical) => {
    const link = "https://app.notion.test/workspace/Roadmap-0123456789abcdef";
    const { deps: d } = deps(() => head(`${ART}<title>Notion</title>${canonical}`));
    expect(await readLinkPreview(link, d)).toEqual({ ok: true, kind: "page", article: true });
  });

  it("keeps the title for the root link itself, and for a canonical address with a path or a query", async () => {
    const root = deps(() =>
      head(`<title>Notion</title><meta property="og:url" content="https://app.notion.test/">`),
    );
    expect(await readLinkPreview("https://app.notion.test/", root.deps)).toMatchObject({
      title: "Notion",
    });
    for (const canonical of ["https://app.notion.test/doc", "https://app.notion.test/?p=7"]) {
      const { deps: d } = deps(() =>
        head(`<title>Doc</title><link rel="canonical" href="${canonical}">`),
      );
      expect(await readLinkPreview(`${ARTICLE}/x`, d), canonical).toMatchObject({ title: "Doc" });
    }
  });

  it("keeps a shortened link's card, marks it cross-site, and reads the final site's own icon (CA 26)", async () => {
    const SHORT = "https://t.test/abc";
    const big = await png(1200, 630);
    const icon = await png(64, 64);
    const { deps: d, requests } = deps((url) => {
      if (url === SHORT) return Response.redirect("https://news.other.test/story", 302);
      if (url === "https://news.other.test/story") {
        return page(
          articleHead("/og.png").replace(
            "</head>",
            `<link rel="apple-touch-icon" href="https://static.other.test/i.png"></head>`,
          ),
        );
      }
      return imageResponse(url.endsWith("/og.png") ? big : icon);
    });
    const read = await readLinkPreview(SHORT, d);
    if (!read.ok) throw new Error(read.reason);
    expect(cardOf(read)).toMatchObject({ format: "large", title: "Story & more" });
    expect(read).toMatchObject({ crossSite: true, icon: icon64 });
    expect(requests).toEqual([
      SHORT,
      "https://news.other.test/story",
      "https://news.other.test/og.png",
      "https://static.other.test/i.png",
    ]);
  });

  it("does not mark a redirect that stays on the link's site as cross-site", async () => {
    const { deps: d } = deps((url) =>
      url === "https://www.trusted.test/a"
        ? Response.redirect("https://trusted.test/a/", 301)
        : head(`<title>Same site</title>`),
    );
    expect(await readLinkPreview("https://www.trusted.test/a", d)).toEqual({
      ok: true,
      kind: "page",
      article: false,
      title: "Same site",
    });
  });

  it("never reads an icon from another site than the page's (CA 25)", async () => {
    const { deps: d, requests } = deps(() =>
      head(`<title>T</title><link rel="apple-touch-icon" href="https://cdn.tracker.test/i.png">`),
    );
    expect(await readLinkPreview(ARTICLE, d)).toEqual({
      ok: true,
      kind: "page",
      article: false,
      title: "T",
    });
    expect(requests).toEqual([ARTICLE]);
  });

  describe("a site that refuses the server (401, 402, 403, 451)", () => {
    const LINK = "https://paywall.example.test/news/some-story";

    it("records the refusal and the icon its home page names", async () => {
      const icon = await png(180, 180);
      const { deps: d, requests } = deps((url) => {
        if (url === LINK) return new Response("no", { status: 403 });
        if (url === "https://paywall.example.test/") {
          return head(`<title>Home</title><link rel="apple-touch-icon" href="/touch.png">`);
        }
        return imageResponse(icon);
      });
      expect(await readLinkPreview(LINK, d)).toEqual({
        ok: true,
        kind: "refused",
        icon: expect.objectContaining(icon64),
      });
      expect(requests).toEqual([
        LINK,
        "https://paywall.example.test/",
        "https://paywall.example.test/touch.png",
      ]);
    });

    it("records no icon its home page takes from another site, nor one without the time", async () => {
      const elsewhere = deps((url) => {
        if (url === LINK) return new Response("no", { status: 451 });
        return head(`<link rel="apple-touch-icon" href="https://cdn.tracker.test/t.png">`);
      });
      expect(await readLinkPreview(LINK, elsewhere.deps)).toEqual({ ok: true, kind: "refused" });
      expect(elsewhere.requests).toEqual([LINK, "https://paywall.example.test/"]);

      const late = deps(() => new Response("no", { status: 401 }), {
        deadlineAt: Date.now() + 2_000,
      });
      expect(await readLinkPreview(LINK, late.deps)).toEqual({ ok: true, kind: "refused" });
      expect(late.requests).toEqual([LINK]);
    });

    it("records the refusal, not a passing failure, when the deadline cuts the home page or icon read short", async () => {
      for (const cut of [
        "https://paywall.example.test/",
        "https://paywall.example.test/touch.png",
      ]) {
        const controller = new AbortController();
        const stages: string[] = [];
        const { deps: d } = deps(
          (url) => {
            if (url === LINK) return new Response("no", { status: 403 });
            if (url === cut) {
              controller.abort();
              return new Response("late", { status: 500 });
            }
            return head(`<title>Home</title><link rel="apple-touch-icon" href="/touch.png">`);
          },
          { signal: controller.signal, log: (event) => stages.push(event.stage) },
        );
        expect(await readLinkPreview(LINK, d), cut).toEqual({ ok: true, kind: "refused" });
        expect(stages, cut).toEqual(["icon"]);
      }
    });
  });
});
