import { EventEmitter } from "node:events";
import { PAGE_HEAD_MAX_BYTES, PAGE_HEAD_USER_AGENT } from "@rakazo/contracts/page-head-reader";
import { describe, expect, it, vi } from "vitest";
import type { PageRequest } from "./page-head.js";
import { createPageFetch, createPageHeadReader } from "./page-head.js";

const html = (text: string) =>
  new Response(text, { headers: { "content-type": "text/html; charset=utf-8" } });

const publicHost = async () => ["93.184.216.34"];

describe("desktop.pageHead.read input validation", () => {
  const fetchPage = vi.fn(async () => html("<head><title>T</title></head>"));
  const reader = () => createPageHeadReader(fetchPage);

  it.each([
    ["a number", 5],
    ["an object", { url: "https://news.example.com" }],
    ["undefined", undefined],
    ["a non-http scheme", "ftp://news.example.com/x"],
    ["a file", "file:///etc/hosts"],
    ["javascript", "javascript:alert(1)"],
    ["credentials", "https://u:p@news.example.com/"],
    ["a non-default port", "https://news.example.com:8443/"],
    ["loopback", "http://127.0.0.1/"],
    ["localhost", "http://localhost/"],
    ["a private host", "http://192.168.0.1/"],
    ["a single-label name", "http://router/"],
    ["a .lan name", "http://nas.lan/"],
    ["a sign-in page", "https://login.news.example.com/a"],
    ["an oversized url", `https://news.example.com/${"a".repeat(3000)}`],
  ])("rejects %s without any request", async (_name, input) => {
    fetchPage.mockClear();
    await expect(reader().read(input)).rejects.toThrow("Invalid page request");
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("returns the head of a public page and its Content-Type, read with the preview reader's User-Agent and no cookies", async () => {
    fetchPage.mockClear();
    await expect(reader().read("https://news.example.com/story")).resolves.toEqual({
      head: "<head><title>T</title></head",
      contentType: "text/html; charset=utf-8",
    });
    const [, init] = fetchPage.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(init).toMatchObject({
      credentials: "omit",
      redirect: "manual",
      headers: { "user-agent": PAGE_HEAD_USER_AGENT },
    });
  });

  it("caps the answer at 512 KiB", async () => {
    const huge = vi.fn(async () => html("a".repeat(2 * PAGE_HEAD_MAX_BYTES)));
    const page = await createPageHeadReader(huge).read("https://news.example.com/story");
    expect(page?.head).toHaveLength(PAGE_HEAD_MAX_BYTES);
  });

  it("answers null for a page that cannot be read", async () => {
    const refused = vi.fn(async () => new Response("no", { status: 403 }));
    await expect(
      createPageHeadReader(refused).read("https://news.example.com/s"),
    ).resolves.toBeNull();
    const broken = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      createPageHeadReader(broken).read("https://news.example.com/s"),
    ).resolves.toBeNull();
  });

  it("serves two reads at a time and answers null to a third", async () => {
    const release: Array<() => void> = [];
    let open = false;
    const slow = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          if (open) resolve(html("<head></head>"));
          else release.push(() => resolve(html("<head></head>")));
        }),
    );
    const { read } = createPageHeadReader(slow);
    const first = read("https://news.example.com/1");
    const second = read("https://news.example.com/2");
    await expect(read("https://news.example.com/3")).resolves.toBeNull();
    expect(slow).toHaveBeenCalledTimes(2);
    open = true;
    for (const resolve of release) resolve();
    await Promise.all([first, second]);
    await expect(read("https://news.example.com/4")).resolves.toMatchObject({
      head: expect.any(String),
    });
  });

  it("starts at most 20 reads a minute, then again when the minute has passed", async () => {
    let clock = 1_000;
    const { read } = createPageHeadReader(fetchPage, { now: () => clock });
    fetchPage.mockClear();
    for (let index = 0; index < 20; index += 1) {
      await expect(read("https://news.example.com/a")).resolves.not.toBeNull();
    }
    await expect(read("https://news.example.com/a")).resolves.toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(20);
    clock += 60_001;
    await expect(read("https://news.example.com/a")).resolves.not.toBeNull();
  });

  it("stops a cancelled read and gives its slot to the next link", async () => {
    const signals: AbortSignal[] = [];
    const hanging = vi.fn(async (url: string, init: { signal: AbortSignal }) => {
      if (url.endsWith("/c")) return html("<head><title>C</title></head>");
      signals.push(init.signal);
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    });
    const { read, cancel } = createPageHeadReader(hanging);
    const a = read("https://news.example.com/a", "read-a");
    const b = read("https://news.example.com/b", "read-b");
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    cancel("read-a");
    cancel("unknown");
    await expect(a).resolves.toBeNull();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    await expect(read("https://news.example.com/c", "read-c")).resolves.toEqual({
      head: "<head><title>C</title></head",
      contentType: "text/html; charset=utf-8",
    });

    cancel("read-b");
    await expect(b).resolves.toBeNull();
  });
});

class FakeResponse extends EventEmitter {
  constructor(
    readonly statusCode: number,
    readonly headers: Record<string, string | string[] | undefined>,
  ) {
    super();
  }
}

class FakeRequest extends EventEmitter {
  readonly headers: Record<string, string> = {};
  aborted = false;
  ended = false;
  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  abort() {
    this.aborted = true;
  }
  end() {
    this.ended = true;
  }
}

function adapter(resolveHost: (hostname: string) => Promise<string[]> = publicHost) {
  const requests: FakeRequest[] = [];
  const fetchPage = createPageFetch((url) => {
    const request = new FakeRequest();
    (request as unknown as { url: string }).url = url;
    requests.push(request);
    return request as unknown as PageRequest;
  }, resolveHost);
  return { requests, fetchPage };
}

/** Lets the async host check finish so the request exists. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

const init = (signal = new AbortController().signal) => ({
  method: "GET" as const,
  credentials: "omit" as const,
  redirect: "manual" as const,
  headers: { "user-agent": PAGE_HEAD_USER_AGENT, accept: "text/html" },
  signal,
});

describe("createPageFetch over Electron's request", () => {
  it("sets only the given headers and ends the request", async () => {
    const { requests, fetchPage } = adapter();
    const pending = fetchPage("https://news.example.com/x", init());
    await tick();
    const [request] = requests;
    expect(request?.headers).toEqual({ "user-agent": PAGE_HEAD_USER_AGENT, accept: "text/html" });
    expect(request?.ended).toBe(true);
    request?.emit("redirect", 302, "GET", "https://news.example.com/y");
    await pending;
  });

  it("hands a redirect back as a 3xx response, aborting the request instead of following it", async () => {
    const { requests, fetchPage } = adapter();
    const pending = fetchPage("https://news.example.com/x", init());
    await tick();
    requests[0]?.emit("redirect", 301, "GET", "http://127.0.0.1/admin");
    const response = await pending;
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("http://127.0.0.1/admin");
    expect(requests[0]?.aborted).toBe(true);
  });

  it("streams the body of a response", async () => {
    const { requests, fetchPage } = adapter();
    const pending = fetchPage("https://news.example.com/x", init());
    await tick();
    const upstream = new FakeResponse(200, {
      "content-type": "text/html",
      "set-cookie": ["a=1", "b=2"],
    });
    requests[0]?.emit("response", upstream);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html");
    upstream.emit("data", Buffer.from("<head>"));
    upstream.emit("data", Buffer.from("</head>"));
    upstream.emit("end");
    expect(await response.text()).toBe("<head></head>");
  });

  it("cancels the request when the reader stops early", async () => {
    const { requests, fetchPage } = adapter();
    const pending = fetchPage("https://news.example.com/x", init());
    await tick();
    requests[0]?.emit("response", new FakeResponse(200, { "content-type": "text/html" }));
    const response = await pending;
    await response.body?.cancel();
    expect(requests[0]?.aborted).toBe(true);
  });

  it("rejects on a network error and on an abort", async () => {
    const failing = adapter();
    const pending = failing.fetchPage("https://news.example.com/x", init());
    await tick();
    failing.requests[0]?.emit("error", new Error("net::ERR_CONNECTION_RESET"));
    await expect(pending).rejects.toThrow("ERR_CONNECTION_RESET");

    const controller = new AbortController();
    const aborting = adapter();
    const stopped = aborting.fetchPage("https://news.example.com/x", init(controller.signal));
    await tick();
    controller.abort();
    await expect(stopped).rejects.toThrow("Aborted");
    expect(aborting.requests[0]?.aborted).toBe(true);
  });

  it("drives the shared reader end to end: a redirect to a private address is never requested", async () => {
    const { requests, fetchPage } = adapter();
    const read = createPageHeadReader(fetchPage).read("https://news.example.com/story");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests[0]?.emit("redirect", 302, "GET", "http://169.254.169.254/latest");
    await expect(read).resolves.toBeNull();
    expect(requests).toHaveLength(1);
  });
});

describe("every hop is resolved and must be public (M1)", () => {
  it.each([
    ["loopback", ["127.0.0.1"]],
    ["loopback in IPv6", ["::1"]],
    ["a LAN address", ["192.168.1.20"]],
    ["10/8", ["10.0.0.7"]],
    ["link-local (cloud metadata)", ["169.254.169.254"]],
    ["IPv4-mapped IPv6", ["::ffff:127.0.0.1"]],
    ["one private among public answers", ["93.184.216.34", "192.168.1.20"]],
    ["no answer at all", []],
  ])("a name resolving to %s is never requested", async (_name, addresses) => {
    const { requests, fetchPage } = adapter(async () => addresses);
    await expect(fetchPage("https://localtest.example.com/x", init())).rejects.toThrow(
      "Not a public address",
    );
    expect(requests).toEqual([]);
    const { read } = createPageHeadReader(adapter(async () => addresses).fetchPage);
    await expect(read("https://localtest.example.com/x")).resolves.toBeNull();
  });

  it("refuses a name that fails to resolve", async () => {
    const { requests, fetchPage } = adapter(async () => {
      throw new Error("ERR_NAME_NOT_RESOLVED");
    });
    await expect(fetchPage("https://news.example.com/x", init())).rejects.toThrow("NOT_RESOLVED");
    expect(requests).toEqual([]);
  });

  it("resolves again for each hop: a redirect to a name that now points inside is stopped", async () => {
    const answers = new Map([
      ["news.example.com", ["93.184.216.34"]],
      ["cdn.example.com", ["10.1.2.3"]],
    ]);
    const resolved: string[] = [];
    const { requests, fetchPage } = adapter(async (hostname) => {
      resolved.push(hostname);
      return answers.get(hostname) ?? [];
    });
    const read = createPageHeadReader(fetchPage).read("https://news.example.com/story");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests[0]?.emit("redirect", 302, "GET", "https://cdn.example.com/story");
    await expect(read).resolves.toBeNull();
    expect(resolved).toEqual(["news.example.com", "cdn.example.com"]);
    expect(requests).toHaveLength(1);
  });

  it("catches a rebinding sequence: public on the first look, private on the next read", async () => {
    let calls = 0;
    const resolveHost = async () => (++calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"]);
    const { requests, fetchPage } = adapter(resolveHost);
    const { read } = createPageHeadReader(fetchPage);

    const first = read("https://rebind.example.com/story");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests[0]?.emit("response", new FakeResponse(200, { "content-type": "text/html" }));
    (requests[0] as unknown as FakeRequest).emit("error", new Error("unused"));
    await first;

    await expect(read("https://rebind.example.com/story")).resolves.toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("does not resolve an IP literal, which is checked as it is", async () => {
    const resolveHost = vi.fn(publicHost);
    const { requests, fetchPage } = adapter(resolveHost);
    const pending = fetchPage("https://93.184.216.34/x", init());
    await tick();
    requests[0]?.emit("redirect", 302, "GET", "https://news.example.com/y");
    await pending;
    expect(resolveHost).not.toHaveBeenCalled();
    await expect(fetchPage("http://10.0.0.1/x", init())).rejects.toThrow("Not a public address");
  });

  it("stops a stuck resolver when the read is aborted", async () => {
    const controller = new AbortController();
    const { fetchPage } = adapter(() => new Promise(() => undefined));
    const pending = fetchPage("https://news.example.com/x", init(controller.signal));
    controller.abort(new Error("Aborted"));
    await expect(pending).rejects.toThrow("Aborted");
  });
});
