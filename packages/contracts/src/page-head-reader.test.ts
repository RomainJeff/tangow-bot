import { describe, expect, it, vi } from "vitest";
import type { PageHeadFetchInit } from "./page-head-reader.js";
import {
  createPageHeadCollector,
  devicePageUrl,
  isPrivateHostLiteral,
  isPublicAddress,
  PAGE_HEAD_ACCEPT,
  PAGE_HEAD_MAX_BYTES,
  PAGE_HEAD_USER_AGENT,
  readPageHead,
} from "./page-head-reader.js";

const bytes = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));

describe("devicePageUrl: what a device may be asked to read (CA 86)", () => {
  it.each([
    "https://www.lefigaro.fr/international/some-article",
    "http://example.com/a?b=1#frag",
    "https://example.com:443/default-port",
    "https://[2606:4700::1111]/ipv6",
  ])("accepts %s", (url) => {
    expect(devicePageUrl(url)).toBeDefined();
  });

  it("drops the fragment", () => {
    expect(devicePageUrl("https://example.com/a#secret")).toBe("https://example.com/a");
  });

  it.each([
    ["a non-http scheme", "ftp://example.com/x"],
    ["javascript", "javascript:alert(1)"],
    ["a file", "file:///etc/passwd"],
    ["credentials", "https://user:pw@example.com/"],
    ["a user only", "https://user@example.com/"],
    ["a non-default port", "https://example.com:8443/x"],
    ["port 80 on https", "https://example.com:80/x"],
    ["port 8080 on http", "http://example.com:8080/x"],
    ["localhost", "http://localhost/x"],
    ["a trailing-dot localhost", "http://localhost./x"],
    ["a .localhost name", "http://app.localhost/x"],
    ["a .local name", "https://printer.local/x"],
    ["a .internal name", "https://db.internal/x"],
    ["loopback", "http://127.0.0.1/x"],
    ["loopback in decimal", "http://2130706433/x"],
    ["loopback in octal", "http://0177.0.0.1/x"],
    ["loopback in hex", "http://0x7f.1/x"],
    ["private 10/8", "http://10.1.2.3/x"],
    ["private 172.16/12", "http://172.20.0.1/x"],
    ["private 192.168/16", "http://192.168.1.1/x"],
    ["link-local", "http://169.254.169.254/latest/meta-data"],
    ["CGNAT", "http://100.64.0.1/x"],
    ["this network", "http://0.0.0.0/x"],
    ["multicast", "http://224.0.0.1/x"],
    ["IPv6 loopback", "http://[::1]/x"],
    ["IPv6 unspecified", "http://[::]/x"],
    ["IPv6 link-local", "http://[fe80::1]/x"],
    ["IPv6 unique-local", "http://[fd12:3456::1]/x"],
    ["IPv4-mapped IPv6", "http://[::ffff:127.0.0.1]/x"],
    ["IPv4-mapped IPv6 (hex)", "http://[::ffff:7f00:1]/x"],
    ["NAT64", "http://[64:ff9b::7f00:1]/x"],
    ["6to4", "http://[2002:7f00:1::1]/x"],
    ["documentation IPv6", "http://[2001:db8::1]/x"],
    ["a single-label name", "http://router/x"],
    ["a .lan name", "http://nas.lan/x"],
    ["a .home.arpa name", "http://tv.home.arpa/x"],
    ["a .test name", "http://app.test/x"],
    ["a sign-in host", "https://login.news.example.com/x"],
    ["a sign-in path", "https://news.example.com/account/sign-in"],
    ["empty", ""],
    ["too long", `https://example.com/${"a".repeat(2100)}`],
    ["not a URL", "not a url"],
  ])("refuses %s", (_name, url) => {
    expect(devicePageUrl(url)).toBeUndefined();
  });

  it("refuses what is not a string", () => {
    for (const value of [undefined, null, 5, {}, ["https://example.com"]]) {
      expect(devicePageUrl(value)).toBeUndefined();
    }
  });

  it("tells a public resolved address from a private one, and fails closed on the unclear", () => {
    for (const address of ["93.184.216.34", "2606:4700:10::6814:179a", "[2606:4700::1111]"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      "127.0.0.1",
      "::1",
      "10.0.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::7f00:1",
      "nonsense",
      "",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("recognizes private host literals directly", () => {
    expect(isPrivateHostLiteral("example.com")).toBe(false);
    expect(isPrivateHostLiteral("8.8.8.8")).toBe(false);
    expect(isPrivateHostLiteral("[2606:4700::1111]")).toBe(false);
    expect(isPrivateHostLiteral("172.15.0.1")).toBe(false);
    expect(isPrivateHostLiteral("172.32.0.1")).toBe(false);
    expect(isPrivateHostLiteral("999.1.1.1")).toBe(true);
  });
});

describe("createPageHeadCollector: only the head, 512 KiB at most", () => {
  it("stops at </head>, found across chunks and in any case", () => {
    const collector = createPageHeadCollector();
    expect(collector.push(bytes("<html><head><title>T</title></he"))).toBe(false);
    expect(collector.push(bytes("AD><body>never kept</body>"))).toBe(true);
    expect(collector.text()).toBe("<html><head><title>T</title></heAD");
    expect(collector.push(bytes("more"))).toBe(true);
    expect(collector.text()).toBe("<html><head><title>T</title></heAD");
  });

  it("stops at 512 KiB of a page that never closes its head", () => {
    const collector = createPageHeadCollector();
    const chunk = bytes("a".repeat(64 * 1024));
    let done = false;
    let pushes = 0;
    while (!done) {
      done = collector.push(chunk);
      pushes += 1;
    }
    expect(pushes).toBe(8);
    expect(collector.text()).toHaveLength(PAGE_HEAD_MAX_BYTES);
  });

  it("keeps one character per byte, so the server can rebuild the exact bytes", () => {
    const collector = createPageHeadCollector();
    collector.push(new Uint8Array([0x3c, 0xc3, 0xa9, 0xff, 0x00]));
    expect(Array.from(collector.text(), (char) => char.charCodeAt(0))).toEqual([
      0x3c, 0xc3, 0xa9, 0xff, 0x00,
    ]);
  });
});

function body(chunks: Uint8Array[], onCancel?: () => void) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel: onCancel,
  });
}

function respond(init: {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Uint8Array[];
  onCancel?: () => void;
}) {
  return new Response(body(init.chunks ?? [], init.onCancel), {
    status: init.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
  });
}

type Fetch = (url: string, init: PageHeadFetchInit) => Promise<Response>;

describe("readPageHead: one plain request (CA 86)", () => {
  it("sends the reader's User-Agent and nothing that identifies the person or the page", async () => {
    const fetch = vi.fn<Fetch>(async () => respond({ chunks: [bytes("<head></head>")] }));

    await readPageHead("https://news.example.com/a#frag", { fetch });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://news.example.com/a");
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      headers: { "user-agent": PAGE_HEAD_USER_AGENT, accept: PAGE_HEAD_ACCEPT },
    });
    expect(Object.keys(init?.headers ?? {}).sort()).toEqual(["accept", "user-agent"]);
    expect(PAGE_HEAD_USER_AGENT).toMatch(/TangowLinkPreview/);
  });

  it("returns the head up to </head> and cancels the rest of the body", async () => {
    const onCancel = vi.fn();
    const fetch = vi.fn<Fetch>(async () =>
      respond({
        chunks: [
          bytes("<head><title>Le Figaro</title>"),
          bytes("</head><body>"),
          bytes("x".repeat(1000)),
        ],
        onCancel,
      }),
    );
    expect(await readPageHead("https://news.example.com/a", { fetch })).toEqual({
      head: "<head><title>Le Figaro</title></head",
      contentType: "text/html; charset=utf-8",
    });
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalled());
  });

  it("returns at most 512 KiB of a head that never ends", async () => {
    const chunk = bytes("a".repeat(100 * 1024));
    const fetch = vi.fn<Fetch>(async () =>
      respond({ chunks: Array.from({ length: 20 }, () => chunk) }),
    );
    const page = await readPageHead("https://news.example.com/a", { fetch });
    expect(page?.head).toHaveLength(PAGE_HEAD_MAX_BYTES);
  });

  it("makes no request for an address a device must not reach", async () => {
    const fetch = vi.fn<Fetch>(async () => respond({}));
    for (const url of [
      "http://127.0.0.1/",
      "https://news.example.com:8443/",
      "https://u:p@news.example.com/",
      "http://localhost/",
      "ftp://news.example.com/",
    ]) {
      expect(await readPageHead(url, { fetch }), url).toBeUndefined();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks every redirect hop, and gives up after five", async () => {
    const hop = (location: string) => new Response(null, { status: 302, headers: { location } });
    const toPrivate = vi.fn<Fetch>(async () => hop("http://127.0.0.1/admin"));
    expect(await readPageHead("https://news.example.com/a", { fetch: toPrivate })).toBeUndefined();
    expect(toPrivate).toHaveBeenCalledTimes(1);

    const toPort = vi.fn<Fetch>(async () => hop("https://news.example.com:8443/x"));
    expect(await readPageHead("https://news.example.com/a", { fetch: toPort })).toBeUndefined();
    expect(toPort).toHaveBeenCalledTimes(1);

    let count = 0;
    const loop = vi.fn<Fetch>(async () => hop(`/step-${++count}`));
    expect(await readPageHead("https://news.example.com/a", { fetch: loop })).toBeUndefined();
    expect(loop).toHaveBeenCalledTimes(6);
  });

  it("stops at a redirect to a sign-in page", async () => {
    for (const location of [
      "https://login.news.example.com/start",
      "/account/login",
      "https://accounts.google.com/o/oauth2/auth",
    ]) {
      const fetch = vi.fn<Fetch>(
        async () => new Response(null, { status: 302, headers: { location } }),
      );
      expect(await readPageHead("https://news.example.com/a", { fetch }), location).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("follows a relative redirect to the page", async () => {
    const fetch = vi.fn<Fetch>(async (url) =>
      url.endsWith("/a")
        ? new Response(null, { status: 301, headers: { location: "/b" } })
        : respond({ chunks: [bytes("<head><title>B</title></head>")] }),
    );
    expect((await readPageHead("https://news.example.com/a", { fetch }))?.head).toBe(
      "<head><title>B</title></head",
    );
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://news.example.com/a",
      "https://news.example.com/b",
    ]);
  });

  it("gives nothing for an error status, another content type, or a response that followed a redirect", async () => {
    for (const make of [
      () => respond({ status: 403, chunks: [bytes("<head></head>")] }),
      () => respond({ status: 404 }),
      () => respond({ headers: { "content-type": "application/pdf" }, chunks: [bytes("%PDF")] }),
      () => respond({ headers: { "content-type": "image/png" }, chunks: [bytes("x")] }),
      () => {
        const response = respond({ chunks: [bytes("<head></head>")] });
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      },
    ]) {
      expect(
        await readPageHead("https://news.example.com/a", { fetch: async () => make() }),
      ).toBeUndefined();
    }
  });

  it("accepts XHTML", async () => {
    const fetch = async () =>
      respond({
        headers: { "content-type": "application/xhtml+xml" },
        chunks: [bytes("<head><title>X</title></head>")],
      });
    expect(await readPageHead("https://news.example.com/a", { fetch })).toEqual({
      head: "<head><title>X</title></head",
      contentType: "application/xhtml+xml",
    });
  });

  it("never throws: a network error, an abort and a stuck server all give nothing", async () => {
    expect(
      await readPageHead("https://news.example.com/a", {
        fetch: async () => {
          throw new TypeError("network down");
        },
      }),
    ).toBeUndefined();

    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn<Fetch>(async () => respond({}));
    expect(
      await readPageHead("https://news.example.com/a", { fetch, signal: controller.signal }),
    ).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();

    const stuck: Fetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    expect(
      await readPageHead("https://news.example.com/a", { fetch: stuck, timeoutMs: 30 }),
    ).toBeUndefined();
  });

  it("stops reading a body that stalls at the deadline", async () => {
    const stalled: Fetch = async (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes("<head><title>Slow"));
          init.signal.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return new Response(stream, { headers: { "content-type": "text/html" } });
    };
    expect(
      await readPageHead("https://news.example.com/a", { fetch: stalled, timeoutMs: 30 }),
    ).toBeUndefined();
  });

  it("asks for nothing but the page: no image, icon or script is ever requested", async () => {
    const fetch = vi.fn<Fetch>(async () =>
      respond({
        chunks: [
          bytes(
            '<head><link rel="icon" href="/i.png"><meta property="og:image" content="/og.png"><script src="/a.js"></script></head>',
          ),
        ],
      }),
    );
    await readPageHead("https://news.example.com/a", { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
