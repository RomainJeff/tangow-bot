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

  it("makes one page request and at most one image request", async () => {
    const { deps: d, fetchMock } = deps((url) =>
      url === ARTICLE ? page(articleHead("/og.png")) : new Response("x", { status: 500 }),
    );
    await readLinkPreview(ARTICLE, d);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    ["a 403", () => new Response("no", { status: 403 }), "http_error"],
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
