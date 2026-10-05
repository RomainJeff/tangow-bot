import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createReadLimiter } from "./limits.js";
import {
  decideLinkPreviewFormat,
  type LinkPreviewReadDeps,
  readLinkPreview,
} from "./read-link-preview.js";
import { createLinkPreviewFetcherForTests } from "./safe-fetch-for-tests.js";

describe("decideLinkPreviewFormat", () => {
  it.each([
    // [input, expected]
    [{ kind: "html", title: "T", image: { width: 600, height: 460 } }, "large"],
    [{ kind: "html", title: "T", image: { width: 650, height: 500 } }, "large"],
    [{ kind: "html", title: "T", image: { width: 1200, height: 630 } }, "large"],
    [{ kind: "html", title: "T", image: { width: 600, height: 462 } }, "compact"],
    [{ kind: "html", title: "T", image: { width: 599, height: 200 } }, "compact"],
    [{ kind: "html", title: "T", image: { width: 800, height: 800 } }, "compact"],
    [{ kind: "html", title: "T", image: { width: 400, height: 400 } }, "compact"],
    [{ kind: "html", title: "T" }, "compact"],
    [{ kind: "html", image: { width: 1200, height: 630 } }, null],
    [{ kind: "html", title: "", image: { width: 1200, height: 630 } }, null],
    [{ kind: "html" }, null],
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
const articleHead = (image: string) =>
  `<head><title>Doc title</title><meta property="og:title" content="Story &amp; more"><meta property="og:image" content="${image}"></head><body>x</body>`;

describe("readLinkPreview: formats", () => {
  it("builds a large card from a downloaded 1200 x 630 image", async () => {
    const big = await png(1200, 630);
    const { deps: d, requests } = deps((url) =>
      url === ARTICLE ? page(articleHead("/og.png")) : imageResponse(big),
    );
    const result = await readLinkPreview(ARTICLE, d);
    expect(result).toMatchObject({ ok: true, format: "large", title: "Story & more" });
    if (!result.ok) throw new Error("unreachable");
    expect(result.image).toMatchObject({ width: 1200, height: 630 });
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
    const result = await readLinkPreview(ARTICLE, d);
    expect(result).toMatchObject({
      ok: true,
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
      const result = await readLinkPreview(ARTICLE, d);
      expect(result).toEqual({ ok: true, format: "compact", title: "Story & more" });
    }
  });

  it("builds a photo card from a direct image link, without title", async () => {
    const photo = await png(800, 600);
    const { deps: d } = deps(() => imageResponse(photo, "image/png"));
    const result = await readLinkPreview("https://img.example.test/a.png", d);
    expect(result).toMatchObject({ ok: true, format: "photo", image: { width: 800, height: 600 } });
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
    const result = await readLinkPreview("https://short.example.test/x", d);
    expect(result).toMatchObject({ ok: true, format: "large" });
    expect(requests.at(-1)).toBe("https://news.example.test/a/og.png");
  });

  it("makes one page request and at most two image requests: the page's image, then the icon", async () => {
    const { deps: d, fetchMock } = deps((url) =>
      url === ARTICLE
        ? page(
            `<head><title>Doc</title><meta property="og:image" content="/og.png"><link rel="apple-touch-icon" href="/t.png"><link rel="icon" sizes="128x128" type="image/png" href="/i.png"></head>`,
          )
        : new Response("x", { status: 500 }),
    );
    await readLinkPreview(ARTICLE, d);
    // The page, og.png, then only the first icon candidate: never a second icon.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reads no image when the page names none", async () => {
    const { deps: d, fetchMock } = deps(() => page("<title>Only title</title>"));
    expect(await readLinkPreview(ARTICLE, d)).toEqual({
      ok: true,
      format: "compact",
      title: "Only title",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("readLinkPreview: failures are classified", () => {
  const run = (route: Route, extra?: LinkPreviewReadDeps, url = ARTICLE) =>
    readLinkPreview(url, deps(route, extra).deps);

  it.each([
    ["a page without title", () => page("<html><body>hi</body></html>"), "no_title"],
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
    [
      "a refusal with a one-word address",
      () => new Response("no", { status: 403 }),
      "access_denied",
    ],
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
      const result = await readLinkPreview(ARTICLE, d);
      expect(result.ok).toBe(false);
    }
    expect(await readLinkPreview("", deps(() => page("")).deps)).toMatchObject({ ok: false });
    expect(await readLinkPreview(undefined as never, deps(() => page("")).deps)).toMatchObject({
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
          ? page(`<title>t</title><meta property="og:image" content="/img.png?token=SECRET#f">`)
          : new Response("gone", { status: 404 }),
      (url) =>
        url === secretUrl
          ? page(`<title>t</title><meta property="og:image" content="/img.png?token=SECRET#f">`)
          : imageResponse(new Uint8Array([1, 2, 3])),
      (url) =>
        url === secretUrl
          ? page(`<title>t</title><meta property="og:image" content="/img.png?token=SECRET#f">`)
          : imageResponse(png1),
    ];
    const events: unknown[] = [];
    const results: unknown[] = [];
    for (const route of routes) {
      results.push(
        await readLinkPreview(secretUrl, {
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
    `<head><title>Home</title>${og}${links}</head><body>x</body>`;

  it("uses the apple-touch-icon as the thumbnail of a compact card when the page has no image", async () => {
    const icon = await png(180, 180);
    const { deps: d, requests } = deps((url) =>
      url === ARTICLE
        ? page(homeHead(`<link rel="apple-touch-icon" sizes="180x180" href="/touch.png">`))
        : imageResponse(icon),
    );
    const result = await readLinkPreview(ARTICLE, d);
    expect(result).toMatchObject({
      ok: true,
      format: "compact",
      title: "Home",
      imageFit: "contain",
      image: { width: 180, height: 180 },
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
    const result = await readLinkPreview(ARTICLE, d);
    expect(result).toMatchObject({ ok: true, format: "compact", imageFit: "contain" });
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
    const result = await readLinkPreview(ARTICLE, d);
    expect(result).toMatchObject({ ok: true, format: "compact", imageFit: "contain" });
    expect(requests).toEqual([
      ARTICLE,
      "https://news.example.test/og.png",
      "https://news.example.test/i.png",
    ]);
  });

  it("keeps a page image over the icon, cropped as before, and does not fetch the icon", async () => {
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
    const result = await readLinkPreview(ARTICLE, d);
    expect(result).toMatchObject({ ok: true, format: "compact" });
    expect(result).not.toHaveProperty("imageFit");
    expect(requests).toEqual([ARTICLE, "https://news.example.test/og.png"]);
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
      const result = await readLinkPreview(ARTICLE, d);
      expect(result, links).toEqual({ ok: true, format: "compact", title: "Home" });
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
      expect(await readLinkPreview(ARTICLE, d)).toEqual({
        ok: true,
        format: "compact",
        title: "Home",
      });
    }
  });

  it("goes through the same checks as any image: a private address is refused", async () => {
    const { deps: d, requests } = deps((url) =>
      url === ARTICLE
        ? page(homeHead(`<link rel="apple-touch-icon" href="http://127.0.0.1/t.png">`))
        : imageResponse(new Uint8Array([1])),
    );
    expect(await readLinkPreview(ARTICLE, d)).toEqual({
      ok: true,
      format: "compact",
      title: "Home",
    });
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
      expect(await readLinkPreview(ARTICLE, d)).toEqual({
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
      expect(await readLinkPreview(ARTICLE, d)).toMatchObject({ ok: true, imageFit: "contain" });
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
      expect(await readLinkPreview(ARTICLE, d)).toEqual({
        ok: false,
        reason: "aborted",
        transient: true,
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
      expect(await readLinkPreview(ARTICLE, d)).toMatchObject({ ok: false, transient: true });
    });
  });
});

describe("readLinkPreview: a site that refuses the reader (CA 73-76)", () => {
  const SLUG =
    "/international/article/2026/10/05/a-kiev-une-atmosphere-de-guerre-permanente-l-ennemi-est-en-train-de-detruire-la-ville_6788472_3210.html";
  const CLOSED = `https://www.monde.example.test${SLUG}`;
  const HOME = "https://www.monde.example.test/";
  const TITLE =
    "A kiev une atmosphere de guerre permanente l'ennemi est en train de detruire la ville";
  const refusal = (status = 402) =>
    new Response("<head><title>Accès restreint</title></head>", {
      status,
      headers: { "content-type": "text/html" },
    });
  const home = (links = `<link rel="apple-touch-icon" sizes="180x180" href="/touch.png">`) =>
    page(`<head><title>Home</title>${links}</head><body>x</body>`);

  it("draws a compact card from the address, with the icon read on the home page", async () => {
    const icon = await png(180, 180);
    const { deps: d, requests } = deps((url) =>
      url === CLOSED ? refusal() : url === HOME ? home() : imageResponse(icon),
    );
    const result = await readLinkPreview(CLOSED, d);
    expect(result).toMatchObject({
      ok: true,
      format: "compact",
      title: TITLE,
      imageFit: "contain",
      image: { width: 180, height: 180 },
    });
    expect(requests).toEqual([CLOSED, HOME, "https://www.monde.example.test/touch.png"]);
  });

  it.each([401, 402, 403, 451])("does it for a %i", async (status) => {
    const { deps: d } = deps((url) => (url === CLOSED ? refusal(status) : home("")));
    expect(await readLinkPreview(CLOSED, d)).toEqual({ ok: true, format: "compact", title: TITLE });
  });

  it("never shows the title of the refusal page", async () => {
    const icon = await png(180, 180);
    const { deps: d } = deps((url) =>
      url === CLOSED ? refusal() : url === HOME ? home() : imageResponse(icon),
    );
    const result = await readLinkPreview(CLOSED, d);
    expect(JSON.stringify(result)).not.toMatch(/restreint/i);
  });

  it("gives a card without icon when the home page fails too", async () => {
    for (const failing of [
      () => new Response("gone", { status: 404 }),
      () => new Response("blocked", { status: 402 }),
      () => new Response("down", { status: 503 }),
      () => Response.redirect("http://127.0.0.1/", 302),
      () => page("<head><title>Home</title></head>"),
    ]) {
      const { deps: d, requests } = deps((url) => (url === CLOSED ? refusal() : failing()));
      expect(await readLinkPreview(CLOSED, d)).toEqual({
        ok: true,
        format: "compact",
        title: TITLE,
      });
      expect(requests).toEqual([CLOSED, HOME]);
    }
  });

  it("gives a card without icon when the icon cannot be used", async () => {
    const { deps: d } = deps((url) =>
      url === CLOSED ? refusal() : url === HOME ? home() : new Response("gone", { status: 404 }),
    );
    expect(await readLinkPreview(CLOSED, d)).toEqual({ ok: true, format: "compact", title: TITLE });
  });

  it("uses only the icon rules: no SVG, no guessed favicon", async () => {
    const { deps: d, requests } = deps((url) =>
      url === CLOSED ? refusal() : home(`<link rel="icon" sizes="any" href="/i.svg">`),
    );
    expect(await readLinkPreview(CLOSED, d)).toEqual({ ok: true, format: "compact", title: TITLE });
    expect(requests).toEqual([CLOSED, HOME]);
  });

  it("reads no home page and no icon when too little of the job's budget remains", async () => {
    const { deps: d, requests } = deps(() => refusal(), { deadlineAt: Date.now() + 2_000 });
    expect(await readLinkPreview(CLOSED, d)).toEqual({
      ok: false,
      reason: "timeout",
      transient: true,
    });
    expect(requests).toEqual([CLOSED]);
  });

  it("reads no icon when the home page used up the budget", async () => {
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    try {
      const { deps: d, requests } = deps(
        (url) => {
          if (url === HOME) skew = 8_000;
          return url === CLOSED ? refusal() : home();
        },
        { deadlineAt: realNow() + 10_000 },
      );
      expect(await readLinkPreview(CLOSED, d)).toEqual({
        ok: false,
        reason: "timeout",
        transient: true,
      });
      expect(requests).toEqual([CLOSED, HOME]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ["a one-word address", "https://news.example.test/politique"],
    ["a numeric address", "https://news.example.test/article/6788472_3210"],
    ["a date", "https://news.example.test/2026/10/05/"],
    ["no path", "https://news.example.test/"],
  ])("makes no card for %s, and reads nothing more", async (_name, url) => {
    const { deps: d, requests } = deps(() => refusal());
    expect(await readLinkPreview(url, d)).toEqual({
      ok: false,
      reason: "access_denied",
      transient: false,
    });
    expect(requests).toEqual([url]);
  });

  it.each([
    ["a 404", () => new Response("no", { status: 404 }), "http_error", false],
    ["a 410", () => new Response("no", { status: 410 }), "http_error", false],
    ["a 500", () => new Response("no", { status: 500 }), "server_error", true],
    ["a 503", () => new Response("no", { status: 503 }), "server_error", true],
    ["a 429", () => new Response("no", { status: 429 }), "rate_limited", true],
  ] as const)("makes no fallback card for %s", async (_name, route, reason, transient) => {
    const { deps: d, requests } = deps(route);
    expect(await readLinkPreview(CLOSED, d)).toEqual({ ok: false, reason, transient });
    expect(requests).toEqual([CLOSED]);
  });

  it("makes no fallback card for a login page or a blocked address", async () => {
    const loginUrl = "https://login.monde.example.test/article/some-long-title-here";
    const login = deps(() => refusal());
    expect(await readLinkPreview(loginUrl, login.deps)).toMatchObject({
      ok: false,
      reason: "login_page",
    });
    expect(login.requests).toEqual([]);
    const redirected = deps((url) =>
      url === CLOSED ? Response.redirect("https://monde.example.test/sso", 302) : refusal(),
    );
    expect(await readLinkPreview(CLOSED, redirected.deps)).toMatchObject({
      ok: false,
      reason: "login_page",
    });
    const blocked = deps(() => refusal());
    expect(
      await readLinkPreview("http://127.0.0.1/some-long-title-here", blocked.deps),
    ).toMatchObject({ ok: false, reason: "blocked_address" });
    expect(blocked.requests).toEqual([]);
  });

  it("keeps its own user agent on every request", async () => {
    const { deps: d, fetchMock } = deps((url) => (url === CLOSED ? refusal() : home("")));
    await readLinkPreview(CLOSED, d);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = init?.headers as Record<string, string>;
      expect(headers["user-agent"]).toMatch(/RakazoLinkPreview/);
    }
  });
});
