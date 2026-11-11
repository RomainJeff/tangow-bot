import { isIP } from "node:net";
import type { PageHeadFetchInit, PageHeadRead } from "@tangow/contracts/page-head-reader";
import {
  devicePageUrl,
  isPublicAddress,
  PAGE_HEAD_MAX_BYTES,
  readPageHead,
} from "@tangow/contracts/page-head-reader";

/** Page reads running at once for the renderer: a link pasted twice must not pile up sockets. */
const MAX_PAGE_HEAD_READS = 2;
/** Page reads one minute allows: a person pastes a handful of links, a hostile script floods. */
const MAX_PAGE_HEAD_READS_PER_MINUTE = 20;
const MINUTE_MS = 60_000;

/** The addresses a name resolves to right now, as Chromium's own resolver would connect to them. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

/** The narrow slice of Electron's `ClientRequest` the page reader uses. */
export interface PageRequest {
  setHeader(name: string, value: string): void;
  on(event: "redirect", listener: (status: number, method: string, url: string) => void): void;
  on(
    event: "response",
    listener: (response: {
      statusCode: number;
      headers: Record<string, string | string[] | undefined>;
      on(event: "data", listener: (chunk: Uint8Array) => void): void;
      on(event: "end", listener: () => void): void;
      on(event: "error", listener: (error: Error) => void): void;
    }) => void,
  ): void;
  on(event: "error", listener: (error: Error) => void): void;
  abort(): void;
  end(): void;
}

/**
 * The shell's `fetch` for the shared page reader, over Electron's network stack: a request that
 * sends no cookies and keeps none (the caller gives it an in-memory partition of its own) and
 * hands back every redirect as a 3xx response instead of following it, so the reader can check
 * each hop. (`fetch` itself throws on a manual redirect in Electron, hence `net.request`.)
 */
export function createPageFetch(
  makeRequest: (url: string) => PageRequest,
  resolveHost: ResolveHost,
): (url: string, init: PageHeadFetchInit) => Promise<Response> {
  return async (url, init) => {
    await assertPublicHost(url, resolveHost, init.signal);
    return requestPage(makeRequest, url, init);
  };
}

/**
 * Resolves the host of every hop (the first address and each redirect) and refuses it when any
 * address it resolves to is not public, so `localtest.me`, `192-168-1-1.nip.io` or an attacker's
 * record pointing inside the network never gets a request. The resolver is the session's own
 * (`session.resolveHost`), which fills Chromium's host cache: the connection that follows uses
 * the answer that was checked, which narrows a rebinding window that cannot be closed from here.
 */
async function assertPublicHost(url: string, resolveHost: ResolveHost, signal: AbortSignal) {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) !== 0) {
    if (!isPublicAddress(hostname)) throw new Error("Not a public address.");
    return;
  }
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const addresses = await Promise.race([resolveHost(hostname), aborted]);
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new Error("Not a public address.");
  }
}

function requestPage(
  makeRequest: (url: string) => PageRequest,
  url: string,
  init: PageHeadFetchInit,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const request = makeRequest(url);
    for (const [name, value] of Object.entries(init.headers)) request.setHeader(name, value);
    const abort = () => {
      request.abort();
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (init.signal.aborted) return abort();
    init.signal.addEventListener("abort", abort, { once: true });
    request.on("redirect", (status, _method, location) => {
      request.abort();
      init.signal.removeEventListener("abort", abort);
      resolve(new Response(null, { status, headers: { location } }));
    });
    request.on("response", (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
          response.on("end", () => {
            init.signal.removeEventListener("abort", abort);
            controller.close();
          });
          response.on("error", (error) => controller.error(error));
          init.signal.addEventListener("abort", () => controller.error(init.signal.reason), {
            once: true,
          });
        },
        cancel() {
          request.abort();
        },
      });
      // A status a Response cannot carry with a body (101, 204, 205, 304) has none here.
      const bodyless = [101, 204, 205, 304].includes(response.statusCode);
      resolve(new Response(bodyless ? null : body, { status: response.statusCode, headers }));
    });
    request.on("error", (error) => {
      init.signal.removeEventListener("abort", abort);
      reject(error);
    });
    request.end();
  });
}

export interface PageHeadReaderOptions {
  maxConcurrent?: number;
  maxPerMinute?: number;
  now?: () => number;
}

/**
 * `desktop.pageHead.read`: the start of the page at `url`, read by this computer for a link the
 * server was refused. The renderer is not trusted, so the input is checked here (a string, http(s),
 * default port, no credentials, a public host, not a sign-in page) and an invalid one is rejected;
 * every hop is resolved and checked (see `createPageFetch`); at most two reads run at once and
 * twenty start in a minute, the rest answer null. The answer is the head as text of at most
 * 512 KiB with its Content-Type, or null when the page cannot be read.
 *
 * `desktop.pageHead.cancel`: the renderer names each read, and cancelling that name stops its
 * request and frees its slot at once; it still counts toward the minute.
 */
export function createPageHeadReader(
  fetchPage: (url: string, init: PageHeadFetchInit) => Promise<Response>,
  options: PageHeadReaderOptions = {},
): {
  read: (url: unknown, id?: unknown) => Promise<PageHeadRead | null>;
  cancel: (id: unknown) => void;
} {
  const maxConcurrent = options.maxConcurrent ?? MAX_PAGE_HEAD_READS;
  const maxPerMinute = options.maxPerMinute ?? MAX_PAGE_HEAD_READS_PER_MINUTE;
  const now = options.now ?? Date.now;
  const running = new Map<string | symbol, AbortController>();
  let starts: number[] = [];
  return {
    async read(url, id) {
      if (typeof url !== "string" || devicePageUrl(url) === undefined) {
        throw new Error("Invalid page request.");
      }
      const at = now();
      starts = starts.filter((start) => at - start < MINUTE_MS);
      if (running.size >= maxConcurrent || starts.length >= maxPerMinute) return null;
      // A read an older renderer left unnamed, or named twice, cannot be cancelled.
      const key = typeof id === "string" && !running.has(id) ? id : Symbol();
      const controller = new AbortController();
      running.set(key, controller);
      starts.push(at);
      try {
        const page = await readPageHead(url, { fetch: fetchPage, signal: controller.signal });
        return page !== undefined && page.head.length <= PAGE_HEAD_MAX_BYTES ? page : null;
      } finally {
        running.delete(key);
      }
    },
    cancel(id) {
      if (typeof id === "string") running.get(id)?.abort();
    },
  };
}
