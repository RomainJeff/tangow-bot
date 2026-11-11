import { afterEach, describe, expect, it, vi } from "vitest";

// The reader takes `expo/fetch` on purpose; the global fetch must never be what it calls.
const expoFetch = vi.hoisted(() => vi.fn());
vi.mock("expo/fetch", () => ({ fetch: expoFetch }));

import { readPageHeadOnDevice } from "./page-head";

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = expoFetch;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => handler(url, init));
  const globalFetch = vi.fn(async () => new Response("global fetch must not be used"));
  vi.stubGlobal("fetch", globalFetch);
  return fetchMock;
}
const page = (text: string, init: ResponseInit = {}) =>
  new Response(text, { headers: { "content-type": "text/html; charset=utf-8" }, ...init });

afterEach(() => vi.unstubAllGlobals());

describe("iOS page reader (spec 22, CA 86)", () => {
  it("reads the head with the system fetch: no cookies, the preview User-Agent, redirects checked here", async () => {
    const fetchMock = stubFetch(() => page("<head><title>Le Figaro</title></head><body>x</body>"));

    const head = await readPageHeadOnDevice("https://www.lefigaro.fr/some-article");

    expect(head).toEqual({
      head: "<head><title>Le Figaro</title></head",
      contentType: "text/html; charset=utf-8",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://www.lefigaro.fr/some-article");
    expect(init).toMatchObject({ credentials: "omit", redirect: "manual", method: "GET" });
    const headers = init?.headers as Record<string, string>;
    expect(headers["user-agent"]).toMatch(/TangowLinkPreview/);
    expect(Object.keys(headers).sort()).toEqual(["accept", "user-agent"]);
  });

  it.each([
    "ftp://example.com/x",
    "https://example.com:8443/x",
    "https://user:pw@example.com/x",
    "http://localhost/x",
    "http://printer.local/x",
    "http://router/x",
    "http://127.0.0.1/x",
    "http://192.168.1.10/x",
    "http://[::1]/x",
    "http://10.0.0.1/x",
  ])("never contacts %s", async (url) => {
    const fetchMock = stubFetch(() => page("<head></head>"));
    expect(await readPageHeadOnDevice(url)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a redirect to a private address and reads nothing from it", async () => {
    const fetchMock = stubFetch((url) =>
      url.startsWith("https://news.example.com")
        ? new Response(null, { status: 302, headers: { location: "http://192.168.1.1/login" } })
        : page("<head><title>router</title></head>"),
    );
    expect(await readPageHeadOnDevice("https://news.example.com/a")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at a redirect to a sign-in page", async () => {
    const fetchMock = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "/account/login" } }),
    );
    expect(await readPageHeadOnDevice("https://news.example.com/a")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the text up to </head> only, whatever follows", async () => {
    stubFetch(() => page(`<head><title>T</title></head><body>${"b".repeat(100_000)}</body>`));
    const read = await readPageHeadOnDevice("https://news.example.com/a");
    expect(read?.head).toBe("<head><title>T</title></head");
  });

  it("caps a head that never ends at 512 KiB", async () => {
    stubFetch(() => page(`<head>${"a".repeat(600 * 1024)}`));
    const read = await readPageHeadOnDevice("https://news.example.com/a");
    expect(read?.head).toHaveLength(512 * 1024);
  });

  it("stops when the caller does", async () => {
    const fetchMock = stubFetch(() => page("<head></head>"));
    const controller = new AbortController();
    controller.abort();
    expect(await readPageHeadOnDevice("https://news.example.com/a", controller.signal)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers null for a refusal or a network error", async () => {
    stubFetch(() => new Response("no", { status: 403 }));
    expect(await readPageHeadOnDevice("https://news.example.com/a")).toBeNull();
    stubFetch(() => {
      throw new TypeError("Network request failed");
    });
    expect(await readPageHeadOnDevice("https://news.example.com/a")).toBeNull();
  });
});
