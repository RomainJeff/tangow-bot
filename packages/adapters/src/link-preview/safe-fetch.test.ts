import dns from "node:dns";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isTransientReason, LinkPreviewError, type LinkPreviewFailureReason } from "./errors.js";
import { createReadLimiter } from "./limits.js";
import {
  caresResolveHostname,
  fetchLinkPreviewResource,
  type LinkPreviewFetchMode,
  type LinkPreviewFetchOptions,
  MAX_HTML_BYTES,
  MAX_IMAGE_BYTES,
} from "./safe-fetch.js";
import {
  createLinkPreviewFetcherForTests,
  type LinkPreviewFetchSeams,
} from "./safe-fetch-for-tests.js";

/** The options of a read plus the test seams, which only the test factory can reach. */
type TestFetchOptions = LinkPreviewFetchOptions & LinkPreviewFetchSeams;

function fetchWithSeams(
  rawUrl: string,
  mode: LinkPreviewFetchMode,
  options: TestFetchOptions = {},
) {
  const { fetch, unsafeForTests, dispatcher, ...rest } = options;
  return createLinkPreviewFetcherForTests({ fetch, unsafeForTests, dispatcher })(
    rawUrl,
    mode,
    rest,
  );
}

const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];
const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

async function reasonOf(promise: Promise<unknown>): Promise<LinkPreviewFailureReason | "resolved"> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    expect(error).toBeInstanceOf(LinkPreviewError);
    return (error as LinkPreviewError).reason;
  }
}

describe("link preview fetch: URL policy and redirects (injected client)", () => {
  it.each([
    ["file:///etc/passwd", "unsafe_url"],
    ["gopher://example.test/1", "unsafe_url"],
    ["ftp://example.test/file", "unsafe_url"],
    ["javascript:alert(1)", "unsafe_url"],
    ["not a url", "unsafe_url"],
    ["http://user:secret@example.test/", "unsafe_url"],
    ["https://example.test:8443/", "unsafe_url"],
    ["http://example.test:8080/", "unsafe_url"],
    [`https://example.test/${"a".repeat(2048)}`, "unsafe_url"],
    ["http://127.0.0.1/", "blocked_address"],
    ["http://localhost/", "blocked_address"],
    ["http://localhost./", "blocked_address"],
    ["http://foo.localhost/", "blocked_address"],
    ["http://x.internal/", "blocked_address"],
    ["http://x.local/", "blocked_address"],
    ["http://2130706433/", "blocked_address"],
    ["http://0177.0.0.1/", "blocked_address"],
    ["http://0x7f.1/", "blocked_address"],
    ["http://[::ffff:7f00:1]/", "blocked_address"],
    ["http://[::1]/", "blocked_address"],
    ["http://169.254.169.254/latest/meta-data", "blocked_address"],
    ["http://168.63.129.16/", "blocked_address"],
  ] as const)("refuses %s before opening a connection", async (url, reason) => {
    const fetchMock = vi.fn<typeof fetch>();
    expect(
      await reasonOf(
        fetchWithSeams(url, "page", {
          fetch: fetchMock,
          resolveHostname: publicResolver,
          limiter: createReadLimiter(),
        }),
      ),
    ).toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["http://127.0.0.1/", "blocked_address"],
    ["https://example.test:8443/", "unsafe_url"],
    ["file:///etc/passwd", "unsafe_url"],
    ["gopher://example.test/1", "unsafe_url"],
    ["//127.0.0.1/x", "blocked_address"],
  ] as const)("refuses a redirect to %s", async (location, reason) => {
    const fetchMock = vi.fn<typeof fetch>(async () => redirect(location));
    expect(
      await reasonOf(
        fetchWithSeams("https://example.test/start", "page", {
          fetch: fetchMock,
          resolveHostname: publicResolver,
          limiter: createReadLimiter(),
        }),
      ),
    ).toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://accounts.google.com/",
    "https://login.example.com/",
    "https://example.com/sso",
    "https://example.com/a/sign-in",
  ])("refuses a sign-in page before opening a connection: %s (CA 71)", async (url) => {
    const fetchMock = vi.fn<typeof fetch>();
    const options = { fetch: fetchMock, resolveHostname: publicResolver };
    expect(
      await reasonOf(fetchWithSeams(url, "page", { ...options, limiter: createReadLimiter() })),
    ).toBe("login_page");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isTransientReason("login_page")).toBe(false);
  });

  it.each([
    "https://example.com/login",
    "https://login.example.com/start",
    "https://accounts.google.com/signin/v2",
  ])("refuses a redirect to a sign-in page: %s (CA 71)", async (location) => {
    const fetchMock = vi.fn<typeof fetch>(async () => redirect(location));
    expect(
      await reasonOf(
        fetchWithSeams("https://example.test/start", "page", {
          fetch: fetchMock,
          resolveHostname: publicResolver,
          limiter: createReadLimiter(),
        }),
      ),
    ).toBe("login_page");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads a page whose path only contains a sign-in word, and an image from any host", async () => {
    const options = { resolveHostname: publicResolver, limiter: createReadLimiter() };
    const page = await fetchWithSeams("https://example.com/blog/login-tips", "page", {
      ...options,
      fetch: vi.fn<typeof fetch>(async () => html("<title>t</title>")),
    });
    expect(page.kind).toBe("html");
    const png = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    });
    const image = await fetchWithSeams("https://auth.cdn.example.com/login", "image", {
      ...options,
      fetch: vi.fn<typeof fetch>(async () => png),
    });
    expect(image.kind).toBe("image");
  });

  it("follows five redirects and refuses the sixth", async () => {
    let hops = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      hops += 1;
      return redirect(`https://example.test/${hops}`);
    });
    const options: TestFetchOptions = {
      fetch: fetchMock,
      resolveHostname: publicResolver,
      limiter: createReadLimiter(),
    };
    expect(await reasonOf(fetchWithSeams("https://example.test/0", "page", options))).toBe(
      "too_many_redirects",
    );
    expect(fetchMock).toHaveBeenCalledTimes(6);

    let remaining = 5;
    const fiveThenPage = vi.fn<typeof fetch>(async () =>
      remaining-- > 0 ? redirect("https://example.test/next") : html("<title>ok</title>"),
    );
    const resource = await fetchWithSeams("https://example.test/0", "page", {
      ...options,
      fetch: fiveThenPage,
    });
    expect(resource.kind).toBe("html");
    expect(fiveThenPage).toHaveBeenCalledTimes(6);
  });

  it("resolves a relative redirect against the current URL and reports the final URL", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      urls.push(String(input));
      return urls.length === 1 ? redirect("/final?x=1") : html("<title>t</title>");
    });
    const resource = await fetchWithSeams("https://example.test/start", "page", {
      fetch: fetchMock,
      resolveHostname: publicResolver,
      limiter: createReadLimiter(),
    });
    expect(urls).toEqual(["https://example.test/start", "https://example.test/final?x=1"]);
    expect(resource.url).toBe("https://example.test/final?x=1");
  });

  it("refuses a redirect to a host that resolves privately", async () => {
    const resolveHostname = async (host: string) => [
      { address: host === "internal.example.test" ? "10.0.0.5" : "8.8.8.8", family: 4 },
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => redirect("https://internal.example.test/"));
    expect(
      await reasonOf(
        fetchWithSeams("https://example.test/", "page", {
          fetch: fetchMock,
          resolveHostname,
          limiter: createReadLimiter(),
        }),
      ),
    ).toBe("blocked_address");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a host whose DNS answer changes to a private address between hops", async () => {
    let calls = 0;
    const resolveHostname = async () => [
      { address: ++calls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 },
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => redirect("https://rebind.example.test/2"));
    expect(
      await reasonOf(
        fetchWithSeams("https://rebind.example.test/1", "page", {
          fetch: fetchMock,
          resolveHostname,
          limiter: createReadLimiter(),
        }),
      ),
    ).toBe("blocked_address");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses when any resolved address is private", async () => {
    const resolveHostname = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "fd00::1", family: 6 },
    ];
    expect(
      await reasonOf(
        fetchWithSeams("https://example.test/", "page", {
          fetch: vi.fn<typeof fetch>(),
          resolveHostname,
          limiter: createReadLimiter(),
        }),
      ),
    ).toBe("blocked_address");
  });
});

describe("link preview fetch: request and response rules (injected client)", () => {
  const base = () => ({ resolveHostname: publicResolver, limiter: createReadLimiter() });

  it("sends only the fixed headers", async () => {
    let init: RequestInit | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (_input, requestInit) => {
      init = requestInit;
      return html("<title>t</title>");
    });
    await fetchWithSeams("https://example.test/", "page", {
      ...base(),
      fetch: fetchMock,
    });
    const headers = init?.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["accept", "accept-encoding", "user-agent"]);
    expect(headers["user-agent"]).toMatch(/^Mozilla\/5\.0 \(compatible; RakazoLinkPreview\/\d/);
    expect(headers["accept-encoding"]).toBe("gzip, deflate, br");
    expect(init?.redirect).toBe("manual");
  });

  it.each([
    [404, "http_error"],
    [403, "http_error"],
    [410, "http_error"],
    [408, "server_error"],
    [429, "rate_limited"],
    [500, "server_error"],
    [503, "server_error"],
  ] as const)("classifies HTTP %i as %s", async (status, reason) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("no", { status }));
    expect(
      await reasonOf(
        fetchWithSeams("https://example.test/", "page", { ...base(), fetch: fetchMock }),
      ),
    ).toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("makes one attempt on a network failure", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("x"), { code: "ECONNRESET" }),
      });
    });
    expect(
      await reasonOf(
        fetchWithSeams("https://example.test/", "page", { ...base(), fetch: fetchMock }),
      ),
    ).toBe("network");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["text/plain", "page"],
    ["application/json", "page"],
    ["application/pdf", "page"],
    ["", "page"],
    ["text/html", "image"],
  ] as const)("refuses content type %j in %s mode", async (contentType, mode) => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response("x", { headers: contentType ? { "content-type": contentType } : {} }),
    );
    expect(
      await reasonOf(
        fetchWithSeams("https://example.test/", mode, { ...base(), fetch: fetchMock }),
      ),
    ).toBe("unsupported_type");
  });

  it("returns an image for a direct image link in page mode", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    const resource = await fetchWithSeams("https://example.test/a.png", "page", {
      ...base(),
      fetch: fetchMock,
    });
    expect(resource).toMatchObject({ kind: "image", contentType: "image/png" });
    expect(Array.from(resource.bytes)).toEqual([1, 2, 3]);
  });

  it.each(["gzip, br", "gzip,gzip", "zstd", "compress", "gzip, identity"])(
    "refuses Content-Encoding %j",
    async (encoding) => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        html("<title>t</title>", { "content-encoding": encoding }),
      );
      expect(
        await reasonOf(
          fetchWithSeams("https://example.test/", "page", {
            ...base(),
            fetch: fetchMock,
          }),
        ),
      ).toBe("unsupported_type");
    },
  );

  it("cuts HTML at </head> without reading the body, and without error", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(
          pulled === 1
            ? new TextEncoder().encode("<html><head><title>Hi</title></HEAD><body>")
            : chunk,
        );
      },
    });
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(stream, { headers: { "content-type": "text/html" } }),
    );
    const resource = await fetchWithSeams("https://example.test/", "page", {
      ...base(),
      fetch: fetchMock,
    });
    expect(new TextDecoder().decode(resource.bytes)).toBe("<html><head><title>Hi</title></HEAD");
    expect(pulled).toBeLessThanOrEqual(2);
  });

  it("finds </head> split across two chunks", async () => {
    const parts = ["<head><title>t</title></he", "ad><body>zzz"];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = parts.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
    });
    const resource = await fetchWithSeams("https://example.test/", "page", {
      ...base(),
      fetch: async () => new Response(stream, { headers: { "content-type": "text/html" } }),
    });
    expect(new TextDecoder().decode(resource.bytes)).toBe("<head><title>t</title></head");
  });

  it("truncates HTML at 512 KiB without error when no </head> shows up", async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(
          new TextEncoder().encode(
            sent === 1 ? "<title>Early</title>".padEnd(100 * 1024, " ") : "y".repeat(100 * 1024),
          ),
        );
      },
    });
    const resource = await fetchWithSeams("https://example.test/", "page", {
      ...base(),
      fetch: async () => new Response(stream, { headers: { "content-type": "text/html" } }),
    });
    expect(resource.bytes.byteLength).toBe(MAX_HTML_BYTES);
    expect(new TextDecoder().decode(resource.bytes.subarray(0, 20))).toBe("<title>Early</title>");
    expect(sent).toBeLessThan(10);
  });

  it("ignores a Content-Length that claims less than what arrives", async () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(big, { headers: { "content-type": "image/png", "content-length": "10" } }),
    );
    expect(
      await reasonOf(
        fetchWithSeams("https://example.test/a.png", "image", {
          ...base(),
          fetch: fetchMock,
        }),
      ),
    ).toBe("too_large");
  });

  it("fails an honestly oversized image before reading it", async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array(10));
        },
      },
      { highWaterMark: 0 },
    );
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(stream, {
          headers: { "content-type": "image/jpeg", "content-length": String(MAX_IMAGE_BYTES + 1) },
        }),
    );
    expect(
      await reasonOf(
        fetchWithSeams("https://example.test/a.jpg", "image", {
          ...base(),
          fetch: fetchMock,
        }),
      ),
    ).toBe("too_large");
    expect(pulled).toBe(false);
  });

  it("cuts a resolver that never answers at the deadline", async () => {
    const started = Date.now();
    const reason = await reasonOf(
      fetchWithSeams("https://example.test/", "page", {
        fetch: vi.fn<typeof fetch>(),
        resolveHostname: () => new Promise(() => undefined),
        limiter: createReadLimiter(),
        deadlineMs: 150,
      }),
    );
    expect(reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reports a caller cancellation as aborted", async () => {
    const controller = new AbortController();
    const pending = fetchWithSeams("https://example.test/", "page", {
      fetch: () => new Promise(() => undefined),
      resolveHostname: publicResolver,
      limiter: createReadLimiter(),
      signal: controller.signal,
    });
    controller.abort();
    expect(await reasonOf(pending)).toBe("aborted");
  });

  it("never puts the URL in an error", async () => {
    const secretUrl = "https://example.test/p?token=SECRET#frag";
    for (const fetchImpl of [
      async () => new Response("x", { status: 404 }),
      async () => redirect("http://127.0.0.1/?token=SECRET"),
      async () => {
        throw new TypeError(`fetch failed ${secretUrl}`, { cause: new Error(secretUrl) });
      },
    ]) {
      const error = await fetchWithSeams(secretUrl, "page", {
        ...base(),
        fetch: fetchImpl,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LinkPreviewError);
      const text = JSON.stringify([
        (error as Error).message,
        (error as Error).cause,
        (error as Error).stack,
      ]);
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain("frag");
    }
  });
});

describe("link preview fetch: concurrency caps", () => {
  it("allows 2 reads per host and releases each token only when the read ends", async () => {
    const limiter = createReadLimiter({ total: 8, perHost: 2 });
    const gates: Array<() => void> = [];
    const slowFetch = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          gates.push(() => resolve(html("<title>t</title>")));
        }),
    );
    const read = (url: string) =>
      fetchWithSeams(url, "page", {
        fetch: slowFetch,
        resolveHostname: publicResolver,
        limiter,
      });
    const first = read("https://same.test/1");
    const second = read("https://same.test/2");
    await vi.waitFor(() => expect(gates).toHaveLength(2));

    expect(await reasonOf(read("https://same.test/3"))).toBe("busy");
    const other = read("https://other.test/");
    await vi.waitFor(() => expect(gates).toHaveLength(3));

    gates[0]?.();
    await first;
    const fourth = read("https://same.test/4");
    await vi.waitFor(() => expect(gates).toHaveLength(4));
    for (const open of gates.slice(1)) open();
    await Promise.all([second, other, fourth]);
    expect(limiter.tryAcquire("same.test")).toBeTypeOf("function");
  });

  it("caps the total number of reads", async () => {
    const limiter = createReadLimiter({ total: 2, perHost: 2 });
    const gates: Array<() => void> = [];
    const slowFetch = vi.fn<typeof fetch>(
      () => new Promise<Response>((resolve) => gates.push(() => resolve(html("<title>t</title>")))),
    );
    const read = (host: string) =>
      fetchWithSeams(`https://${host}/`, "page", {
        fetch: slowFetch,
        resolveHostname: publicResolver,
        limiter,
      });
    const reads = [read("a.test"), read("b.test")];
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(await reasonOf(read("c.test"))).toBe("busy");
    for (const open of gates) open();
    await Promise.all(reads);
  });

  it("holds the token until the connection pool is torn down, even when the deadline fired", async () => {
    const limiter = createReadLimiter({ total: 1, perHost: 1 });
    let torn = false;
    let heldDuringTeardown = false;
    const dispatcher = {
      destroy: () =>
        new Promise<void>((resolve) => {
          // Teardown has begun and the deadline has already sounded: the slot must still be taken.
          heldDuringTeardown = limiter.tryAcquire("example.test") === undefined;
          setTimeout(() => {
            torn = true;
            resolve();
          }, 100);
        }),
    };
    const result = await reasonOf(
      fetchWithSeams("https://example.test/", "page", {
        fetch: () => new Promise(() => undefined),
        dispatcher,
        resolveHostname: publicResolver,
        limiter,
        deadlineMs: 50,
      }),
    );
    expect(result).toBe("timeout");
    expect(heldDuringTeardown).toBe(true);
    expect(torn).toBe(true);
    expect(limiter.tryAcquire("example.test")).toBeTypeOf("function");
  });

  it("does not wait for a teardown that never ends", async () => {
    const limiter = createReadLimiter({ total: 1, perHost: 1 });
    const started = Date.now();
    await reasonOf(
      fetchWithSeams("https://example.test/", "page", {
        fetch: () => new Promise(() => undefined),
        dispatcher: { destroy: () => new Promise(() => undefined) },
        resolveHostname: publicResolver,
        limiter,
        deadlineMs: 20,
      }),
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(limiter.tryAcquire("example.test")).toBeTypeOf("function");
  });

  it("offers no way to weaken the checks through the production function's options", () => {
    // The seams are not options: a stray `fetch` or policy object is ignored, never honoured.
    const hostile = { fetch: () => Promise.reject(new Error("used")), unsafeForTests: {} };
    return expect(
      reasonOf(
        fetchLinkPreviewResource("http://127.0.0.1/", "page", {
          ...hostile,
          resolveHostname: publicResolver,
        } as LinkPreviewFetchOptions),
      ),
    ).resolves.toBe("blocked_address");
  });
});

describe("caresResolveHostname (CA 39)", () => {
  type FakeResolver = {
    resolve4: (host: string) => Promise<string[]>;
    resolve6: (host: string) => Promise<string[]>;
  };
  const constructed: Array<Record<string, unknown>> = [];
  let behaviour: FakeResolver = {
    resolve4: async () => [],
    resolve6: async () => [],
  };

  beforeAll(() => {
    // Offline: the resolver class is replaced, so no DNS packet is ever sent.
    class FakeResolver {
      constructor(options: unknown) {
        constructed.push(options as Record<string, unknown>);
      }
      resolve4 = (host: string) => behaviour.resolve4(host);
      resolve6 = (host: string) => behaviour.resolve6(host);
    }
    vi.spyOn(dns.promises, "Resolver").mockImplementation(FakeResolver as never);
  });
  afterAll(() => vi.restoreAllMocks());

  it("answers an IP literal without asking the resolver", async () => {
    const before = constructed.length;
    await expect(caresResolveHostname("93.184.216.34")).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);
    await expect(caresResolveHostname("2606:4700::1111")).resolves.toEqual([
      { address: "2606:4700::1111", family: 6 },
    ]);
    expect(constructed.length).toBe(before);
  });

  it("asks c-ares with a 3 s timeout and a single try, once for the process", async () => {
    behaviour = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
    await caresResolveHostname("a.example.test");
    await caresResolveHostname("b.example.test");

    expect(constructed).toEqual([{ timeout: 3_000, tries: 1 }]);
  });

  it("merges both families and survives one of them failing", async () => {
    behaviour = {
      resolve4: async () => ["93.184.216.34"],
      resolve6: async () => {
        throw new Error("ENODATA");
      },
    };
    await expect(caresResolveHostname("a.example.test")).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);
    behaviour = {
      resolve4: async () => ["93.184.216.34"],
      resolve6: async () => ["2606:4700::1111"],
    };
    await expect(caresResolveHostname("a.example.test")).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ]);
  });

  it("fails when neither family answers", async () => {
    const fail = async () => {
      throw new Error("ESERVFAIL");
    };
    behaviour = { resolve4: fail, resolve6: fail };
    await expect(caresResolveHostname("a.example.test")).rejects.toThrow("DNS resolution failed");
  });
});

describe("link preview fetch: real undici client against a local server", () => {
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  async function serve(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ port: number; connections: () => number; accepted: () => number }> {
    let accepted = 0;
    const server = createServer(handler);
    server.on("connection", (socket) => {
      accepted += 1;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      port: (server.address() as AddressInfo).port,
      connections: () => sockets.size,
      accepted: () => accepted,
    };
  }

  /** Reaches the local server with the real client: the name resolves to loopback, which the
   * default policy would refuse, and the port is not 80. Both are test-only overrides. */
  const localOptions = (overrides: TestFetchOptions = {}): TestFetchOptions => ({
    resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
    limiter: createReadLimiter(),
    unsafeForTests: { allowAnyPort: true, isAddressAllowed: () => true },
    ...overrides,
  });

  it("refuses at connect time a name that turns private after validation (DNS rebinding)", async () => {
    const server = await serve((_req, res) => res.end("<title>leaked</title>"));
    let calls = 0;
    const resolveHostname = async () => [
      { address: ++calls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 },
    ];
    const reason = await reasonOf(
      fetchWithSeams(`http://rebind.example.test:${server.port}/`, "page", {
        resolveHostname,
        limiter: createReadLimiter(),
        // Only the port is relaxed; the default address policy stays in force.
        unsafeForTests: { allowAnyPort: true },
      }),
    );
    expect(reason).toBe("blocked_address");
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(server.accepted()).toBe(0);
  });

  it("refuses a public-looking name that resolves to loopback", async () => {
    const server = await serve((_req, res) => res.end("<title>leaked</title>"));
    const reason = await reasonOf(
      fetchWithSeams(`http://public-looking.example.test:${server.port}/`, "page", {
        resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
        limiter: createReadLimiter(),
        unsafeForTests: { allowAnyPort: true },
      }),
    );
    expect(reason).toBe("blocked_address");
    expect(server.accepted()).toBe(0);
  });

  it("sends exactly the fixed headers on the wire and closes its connection", async () => {
    let seen: IncomingMessage["headers"] = {};
    const server = await serve((req, res) => {
      seen = req.headers;
      res.setHeader("content-type", "text/html");
      res.end("<title>t</title>");
    });
    const resource = await fetchWithSeams(
      `http://preview.test:${server.port}/page`,
      "page",
      localOptions(),
    );
    expect(resource.kind).toBe("html");
    expect(seen.cookie).toBeUndefined();
    expect(seen.authorization).toBeUndefined();
    expect(seen.referer).toBeUndefined();
    expect(seen["accept-encoding"]).toBe("gzip, deflate, br");
    expect(seen["user-agent"]).toMatch(/RakazoLinkPreview/);
    expect(seen.accept).toContain("text/html");
    await vi.waitFor(() => expect(server.connections()).toBe(0));
  });

  it("ignores proxy environment variables", async () => {
    const proxy = await serve((_req, res) => res.end("proxied"));
    const target = await serve((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<title>direct</title>");
    });
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ]) {
      vi.stubEnv(name, proxyUrl);
    }
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    const resource = await fetchWithSeams(
      `http://preview.test:${target.port}/`,
      "page",
      localOptions(),
    );
    expect(new TextDecoder().decode(resource.bytes)).toBe("<title>direct</title>");
    expect(proxy.accepted()).toBe(0);
  });

  it("follows a real redirect chain", async () => {
    const server = await serve((req, res) => {
      if (req.url === "/a") {
        res.writeHead(301, { location: "/b" }).end();
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end("<title>b</title>");
    });
    const resource = await fetchWithSeams(
      `http://preview.test:${server.port}/a`,
      "page",
      localOptions(),
    );
    expect(resource.url).toBe(`http://preview.test:${server.port}/b`);
  });

  it("caps a gzip bomb at the decoded byte limit with bounded memory", async () => {
    let produced = 0;
    let source: Readable | undefined;
    const server = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      source = new Readable({
        read() {
          produced += 1 << 20;
          this.push(Buffer.alloc(1 << 20));
        },
      });
      const gzip = createGzip({ level: 1 });
      source.pipe(gzip).pipe(res);
      res.on("close", () => source?.destroy());
    });
    const before = process.memoryUsage();
    const resource = await fetchWithSeams(
      `http://preview.test:${server.port}/`,
      "page",
      localOptions(),
    );
    const after = process.memoryUsage();
    expect(resource.bytes.byteLength).toBe(MAX_HTML_BYTES);
    expect(
      after.heapUsed + after.arrayBuffers - (before.heapUsed + before.arrayBuffers),
    ).toBeLessThan(64 * 1024 * 1024);
    await vi.waitFor(() => expect(source?.destroyed).toBe(true));
    const stopped = produced;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(produced).toBe(stopped);
  });

  it("refuses a gzip image bomb past 10 MiB decoded", async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip" });
      const source = new Readable({
        read() {
          this.push(Buffer.alloc(1 << 20));
        },
      });
      source.pipe(createGzip({ level: 1 })).pipe(res);
      res.on("close", () => source.destroy());
    });
    const reason = await reasonOf(
      fetchWithSeams(`http://preview.test:${server.port}/a.png`, "image", localOptions()),
    );
    expect(reason).toBe("too_large");
  });

  it("refuses two Content-Encoding layers from a real server", async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip, gzip" });
      res.end("x");
    });
    expect(
      await reasonOf(fetchWithSeams(`http://preview.test:${server.port}/`, "page", localOptions())),
    ).toBe("unsupported_type");
  });

  it("cuts a server that drips one byte at a time at the deadline", async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      const timer = setInterval(() => res.write("a"), 40);
      res.on("close", () => clearInterval(timer));
    });
    const started = Date.now();
    const reason = await reasonOf(
      fetchWithSeams(
        `http://preview.test:${server.port}/`,
        "page",
        localOptions({ deadlineMs: 400 }),
      ),
    );
    expect(reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
    await vi.waitFor(() => expect(server.connections()).toBe(0));
  });

  it("cuts a server that never sends headers at the deadline", async () => {
    const server = await serve(() => undefined);
    const reason = await reasonOf(
      fetchWithSeams(
        `http://preview.test:${server.port}/`,
        "page",
        localOptions({ deadlineMs: 300 }),
      ),
    );
    expect(reason).toBe("timeout");
    await vi.waitFor(() => expect(server.connections()).toBe(0));
  });
});
