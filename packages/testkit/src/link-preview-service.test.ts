import { createLinkPreviewFetcherForTests, resolveLinkPreview } from "@rakazo/adapters";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeThreadDb } from "./fake-thread-db.js";

const URL_WITH_SECRET_PARTS = "https://h.tld/private/path?x=1&id=SECRETVALUE#frag";
const scope = { spaceId: "space-1", userId: "user-1", source: "job" as const };
const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];
const page = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

afterEach(() => installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] })));

function service(route: (url: string) => Response | Promise<Response>, resolve = publicResolver) {
  const db = createFakeThreadDb();
  const requests: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    requests.push(String(input));
    return route(String(input));
  });
  return {
    db,
    requests,
    deps: {
      prisma: db.prisma,
      artifacts: db.artifacts,
      readDeps: {
        fetchResource: createLinkPreviewFetcherForTests({ fetch: fetchMock }),
        resolveHostname: resolve,
      },
    },
  };
}

function capture() {
  const sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
  return sink;
}

describe("logs hold the host only (CA 56)", () => {
  const failures: Array<[string, () => ReturnType<typeof service>]> = [
    [
      "a refused address",
      () =>
        service(
          () => page("x"),
          async () => [{ address: "10.0.0.5", family: 4 }],
        ),
    ],
    ["a 404", () => service(() => new Response("gone", { status: 404 }))],
    ["a server error", () => service(() => new Response("down", { status: 503 }))],
    [
      "a redirect to a private address",
      () => service(() => Response.redirect("http://127.0.0.1/a", 302)),
    ],
    ["a page with no title", () => service(() => page("<head></head>"))],
    [
      "an image that cannot be used",
      () =>
        service((url) =>
          url === URL_WITH_SECRET_PARTS.split("#")[0]
            ? new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })
            : new Response("x", { status: 500 }),
        ),
    ],
    [
      "a page image that fails",
      () =>
        service((url) =>
          url.startsWith("https://h.tld/private")
            ? page(
                '<head><title>T</title><meta property="og:image" content="/img/secret.png?k=SECRETVALUE"></head>',
              )
            : new Response("x", { status: 404 }),
        ),
    ],
    ["a timeout", () => service(() => new Promise<Response>(() => undefined))],
  ];

  it.each(failures)("for %s", async (_name, build) => {
    const { deps } = build();
    const sink = capture();

    const result = await resolveLinkPreview(
      { ...deps, readDeps: { ...deps.readDeps, pageTimeoutMs: 40, imageTimeoutMs: 40 } },
      scope,
      URL_WITH_SECRET_PARTS,
    );
    // Only the last case may legitimately succeed (a page image failing keeps a compact card).
    void result;

    const logged = JSON.stringify(sink.events);
    for (const forbidden of [
      "private",
      "path",
      "x=1",
      "SECRETVALUE",
      "frag",
      "secret.png",
      "/img",
    ]) {
      expect(logged, forbidden).not.toContain(forbidden);
    }
    expect(logged).not.toContain("https://");
  });

  it("logs the host and a reason for a failed read", async () => {
    const { deps } = service(() => new Response("gone", { status: 404 }));
    const sink = capture();

    await resolveLinkPreview(deps, scope, URL_WITH_SECRET_PARTS);

    expect(sink.events.map((event) => event.message)).toContain("link preview read failed");
    expect(JSON.stringify(sink.events)).toContain("h.tld");
  });

  it("does not log a link that is not previewable, nor a secret link", async () => {
    const { deps, requests } = service(() => page("<title>x</title>"));
    const sink = capture();

    for (const url of [
      "http://[::1",
      "https://exa mple.test/%zz?token=SECRETVALUE",
      "https://h.tld/p?token=SECRETVALUE#f",
      "https://h.tld/p?Session=SECRETVALUE",
      "javascript:alert(1)",
      "https://user:pw@h.tld/",
    ]) {
      await expect(resolveLinkPreview(deps, scope, url)).resolves.toBeNull();
    }

    expect(sink.events).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe("one attempt (CA 37)", () => {
  it("makes one page request and, at most, one image request, and never retries a failure", async () => {
    const { deps, requests } = service((url) =>
      url === "https://h.tld/a"
        ? page('<head><title>T</title><meta property="og:image" content="/img.png"></head>')
        : new Response("down", { status: 503 }),
    );

    const result = await resolveLinkPreview(deps, scope, "https://h.tld/a");

    expect(result).toMatchObject({ format: "compact", title: "T" });
    expect(requests).toEqual(["https://h.tld/a", "https://h.tld/img.png"]);

    const failing = service(() => new Response("down", { status: 503 }));
    await expect(resolveLinkPreview(failing.deps, scope, "https://h.tld/b")).resolves.toBeNull();
    expect(failing.requests).toEqual(["https://h.tld/b"]);
    // A transient failure leaves nothing in the cache.
    expect(failing.db.tables.linkPreviewCache.size).toBe(0);
  });
});
