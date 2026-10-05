import type { LinkPreviewJobDeps, LinkPreviewServiceDeps } from "@rakazo/adapters";
import {
  createLinkPreviewFetcherForTests,
  resolveLinkPreviewDetailed,
  resolveLinkPreviewWithDeviceHead,
  runLinkPreviewJob,
} from "@rakazo/adapters";
import { createLogger, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeThreadDb } from "./fake-thread-db.js";

// A 1 x 1 PNG: real bytes for the server to fetch and re-encode.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const ARTICLE = "https://news.test/article/le-vrai-titre-du-jour";
const IMAGE = "https://img.test/og.png";
const HEAD = `<head><title>Le vrai titre</title><meta property="og:image" content="${IMAGE}"></head>`;
const scope = { spaceId: "space-1", userId: "user-1", source: "composer" as const };
const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];
const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const refusal = () => new Response("no", { status: 403 });

afterEach(() => installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] })));

/** news.test refuses the server; its images (img.test) are open. */
function site(route?: (url: string) => Response | Promise<Response>) {
  const db = createFakeThreadDb();
  db.seedThread({ id: "thread-1" });
  const requests: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    requests.push(url);
    const custom = await route?.(url);
    if (custom) return custom;
    if (url === IMAGE) return new Response(PNG, { headers: { "content-type": "image/png" } });
    return refusal();
  });
  const deps: LinkPreviewServiceDeps & LinkPreviewJobDeps = {
    prisma: db.prisma,
    artifacts: db.artifacts,
    events: { notify: vi.fn(async () => undefined) },
    readDeps: {
      fetchResource: createLinkPreviewFetcherForTests({ fetch: fetchMock }),
      resolveHostname: publicResolver,
    },
  };
  const cacheRows = () => [...db.tables.linkPreviewCache.values()];
  return { db, deps, requests, cacheRows };
}

describe("the server tells the device it may read (CA 81, CA 54)", () => {
  it("flags a refusal of the site, with the fallback card, and remembers it as restricted", async () => {
    const { deps, cacheRows } = site();
    const answer = await resolveLinkPreviewDetailed(deps, scope, ARTICLE);
    expect(answer.deviceReadable).toBe(true);
    expect(answer.preview).toMatchObject({ format: "compact", title: "Le vrai titre du jour" });
    expect(cacheRows()).toMatchObject([{ status: "ok", source: "restricted" }]);
    // The second ask is served from the cache and says the same.
    const again = await resolveLinkPreviewDetailed(deps, scope, ARTICLE);
    expect(again.deviceReadable).toBe(true);
  });

  it("flags a refusal with no fallback card, and a failure that may pass", async () => {
    const oneWord = site();
    const bare = await resolveLinkPreviewDetailed(oneWord.deps, scope, "https://news.test/a");
    expect(bare).toMatchObject({ preview: null, deviceReadable: true });
    expect(oneWord.cacheRows()).toMatchObject([{ status: "failed", source: "restricted" }]);

    for (const status of [429, 503]) {
      const passing = site((url) => (url === ARTICLE ? new Response("x", { status }) : undefined));
      expect(await resolveLinkPreviewDetailed(passing.deps, scope, ARTICLE)).toMatchObject({
        preview: null,
        deviceReadable: true,
      });
      expect(passing.cacheRows()).toEqual([]);
    }
  });

  it("does not flag a timeout or a network error (no HTTP answer, so no oracle on private names)", async () => {
    const timeout = site((url) =>
      url === ARTICLE ? new Promise<Response>(() => undefined) : undefined,
    );
    expect(
      await resolveLinkPreviewDetailed(
        { ...timeout.deps, readDeps: { ...timeout.deps.readDeps, pageTimeoutMs: 30 } },
        scope,
        ARTICLE,
      ),
    ).toMatchObject({ preview: null, deviceReadable: false });
    const reset = site((url) => {
      if (url === ARTICLE) throw new TypeError("fetch failed");
      return undefined;
    });
    expect(await resolveLinkPreviewDetailed(reset.deps, scope, ARTICLE)).toMatchObject({
      preview: null,
      deviceReadable: false,
    });
    const unresolved = site();
    expect(
      await resolveLinkPreviewDetailed(
        {
          ...unresolved.deps,
          readDeps: {
            ...unresolved.deps.readDeps,
            resolveHostname: async () => {
              throw new Error("ENOTFOUND");
            },
          },
        },
        scope,
        ARTICLE,
      ),
    ).toMatchObject({ preview: null, deviceReadable: false });
    // And a pageHead is then ignored: nothing was refused.
    const answer = await resolveLinkPreviewWithDeviceHead({ ...reset.deps }, scope, ARTICLE, HEAD);
    expect(answer.preview).toBeNull();
    expect(reset.cacheRows()).toEqual([]);
  });

  it("does not flag what the device cannot help with", async () => {
    const readable = site((url) => (url === ARTICLE ? html(HEAD) : undefined));
    expect((await resolveLinkPreviewDetailed(readable.deps, scope, ARTICLE)).deviceReadable).toBe(
      false,
    );
    const gone = site((url) => (url === ARTICLE ? new Response("x", { status: 404 }) : undefined));
    expect(await resolveLinkPreviewDetailed(gone.deps, scope, ARTICLE)).toMatchObject({
      preview: null,
      deviceReadable: false,
    });
    for (const unsafe of [
      "http://127.0.0.1/some-long-article-title",
      "https://news.test:8443/some-long-article-title",
      "https://news.test/some-long-article-title?token=abc",
      "https://login.news.test/some-long-article-title",
      "https://accounts.google.com/some-long-article-title",
    ]) {
      const { deps, requests } = site();
      expect(await resolveLinkPreviewDetailed(deps, scope, unsafe), unsafe).toMatchObject({
        preview: null,
        deviceReadable: false,
      });
      expect(requests, unsafe).toEqual([]);
    }
  });
});

describe("the server takes a device's page head (CA 84)", () => {
  it("replaces the fallback with the parsed card, fetching the image itself, and caches it as device-read", async () => {
    const { deps, requests, cacheRows } = site();
    await resolveLinkPreviewDetailed(deps, scope, ARTICLE);
    requests.length = 0;

    const answer = await resolveLinkPreviewWithDeviceHead(deps, scope, ARTICLE, HEAD);

    expect(answer.deviceReadable).toBe(false);
    expect(answer.preview).toMatchObject({
      format: "compact",
      title: "Le vrai titre",
      image: { width: 1, height: 1 },
    });
    // No request for the page again (the cached refusal is the proof); the server asked for the
    // image the head names, and only that.
    expect(requests).toEqual([IMAGE]);
    expect(cacheRows()).toHaveLength(1);
    expect(cacheRows()[0]).toMatchObject({
      status: "ok",
      source: "device",
      title: "Le vrai titre",
    });
    const key = cacheRows()[0]?.imageKey as string;
    expect(deps.artifacts.keys()).toEqual([key]);
  });

  it("re-checks the refusal itself when nothing is cached, and keeps a card made for a passing failure out of the cache (429, 5xx)", async () => {
    for (const status of [429, 503]) {
      const { deps, requests, cacheRows } = site((url) =>
        url === ARTICLE ? new Response("x", { status }) : undefined,
      );
      const answer = await resolveLinkPreviewWithDeviceHead(deps, scope, ARTICLE, HEAD);
      expect(answer.preview).toMatchObject({ title: "Le vrai titre" });
      expect(answer).toMatchObject({ refused: false, ephemeralImageKey: expect.any(String) });
      expect(requests).toEqual([ARTICLE, IMAGE]);
      // Not remembered for the space: nothing for the message job or a bot to reuse.
      expect(cacheRows()).toEqual([]);
      // Its image is in the store only until the caller has used it.
      expect(deps.artifacts.keys()).toEqual([answer.ephemeralImageKey]);
    }
  });

  it("caches the card for a refusal of the site itself (401, 402, 403, 451)", async () => {
    for (const status of [401, 402, 403, 451]) {
      const { deps, cacheRows } = site((url) =>
        url === ARTICLE || url === "https://news.test/" ? new Response("x", { status }) : undefined,
      );
      const answer = await resolveLinkPreviewWithDeviceHead(deps, scope, ARTICLE, HEAD);
      expect(answer).toMatchObject({ refused: true });
      expect(answer).not.toHaveProperty("ephemeralImageKey");
      expect(cacheRows()).toMatchObject([{ source: "device", title: "Le vrai titre" }]);
    }
  });

  it("honors the charset of the response's Content-Type, like a fetched page", async () => {
    const { deps } = site();
    const head = "<head><title>Caf\u00e9 du jour</title></head>";
    const wrong = await resolveLinkPreviewWithDeviceHead(deps, scope, ARTICLE, head);
    expect(wrong.preview?.title).not.toBe("Café du jour");
    const other = site();
    const right = await resolveLinkPreviewWithDeviceHead(
      other.deps,
      scope,
      ARTICLE,
      head,
      undefined,
      "text/html; charset=iso-8859-1",
    );
    expect(right.preview).toMatchObject({ title: "Café du jour" });
  });

  it("ignores it for a site the server can read", async () => {
    const { deps, requests, cacheRows } = site((url) =>
      url === ARTICLE ? html("<head><title>Titre du serveur</title></head>") : undefined,
    );
    const answer = await resolveLinkPreviewWithDeviceHead(deps, scope, ARTICLE, HEAD);
    expect(answer.preview).toMatchObject({ title: "Titre du serveur" });
    expect(requests).toEqual([ARTICLE]);
    expect(cacheRows()).toMatchObject([{ source: "server" }]);
    // Even with a fresh server entry in the cache, a later head changes nothing.
    const later = await resolveLinkPreviewWithDeviceHead(deps, scope, ARTICLE, HEAD);
    expect(later.preview).toMatchObject({ title: "Titre du serveur" });
    expect(requests).toEqual([ARTICLE]);
  });

  it("ignores it for a link that is unsafe, blocked, secret or a sign-in page", async () => {
    for (const unsafe of [
      "http://127.0.0.1/some-long-article-title",
      "https://news.test:8443/some-long-article-title",
      "https://news.test/some-long-article-title?token=abc",
      "https://login.news.test/some-long-article-title",
      "https://accounts.google.com/some-long-article-title",
      "javascript:alert(1)",
    ]) {
      const { deps, requests, cacheRows } = site();
      const answer = await resolveLinkPreviewWithDeviceHead(deps, scope, unsafe, HEAD);
      expect(answer, unsafe).toMatchObject({ preview: null, deviceReadable: false });
      expect(requests, unsafe).toEqual([]);
      // A refusal that describes the link may be remembered, but never as a device-read card.
      expect(
        cacheRows().filter((row) => row.source === "device"),
        unsafe,
      ).toEqual([]);
    }
  });

  it("ignores a head over 512 KiB, an empty one, and one that is not bytes", async () => {
    for (const head of [
      `<head><title>T</title>${"x".repeat(512 * 1024)}</head>`,
      "",
      "<head><title>☃</title></head>",
    ]) {
      const { deps, requests, cacheRows } = site();
      await resolveLinkPreviewDetailed(deps, scope, ARTICLE);
      requests.length = 0;
      const answer = await resolveLinkPreviewWithDeviceHead(deps, scope, ARTICLE, head);
      expect(answer.preview).toMatchObject({ title: "Le vrai titre du jour" });
      expect(requests).toEqual([]);
      expect(cacheRows()).toMatchObject([{ source: "restricted" }]);
    }
    // A head of exactly 512 KiB is accepted.
    const { deps } = site();
    const exact = `<head><title>Plein</title></head>${" ".repeat(512 * 1024 - 33)}`;
    expect(exact.length).toBe(512 * 1024);
    const answer = await resolveLinkPreviewWithDeviceHead(deps, scope, ARTICLE, exact);
    expect(answer.preview).toMatchObject({ title: "Plein" });
  });

  it("keeps the fallback when the head has no title, and does not cache the miss", async () => {
    const { deps, cacheRows } = site();
    const answer = await resolveLinkPreviewWithDeviceHead(deps, scope, ARTICLE, "<head></head>");
    expect(answer.preview).toMatchObject({ title: "Le vrai titre du jour" });
    expect(answer.deviceReadable).toBe(true);
    expect(cacheRows()).toMatchObject([{ source: "restricted" }]);
  });

  it("reads the head the way a fetched page is read: charset, entities, a remote image named by <base>", async () => {
    const { deps, requests } = site((url) =>
      url === "https://cdn.test/assets/pic.png"
        ? new Response(PNG, { headers: { "content-type": "image/png" } })
        : undefined,
    );
    const latin1 =
      '<head><base href="https://cdn.test/assets/"><meta charset="iso-8859-1"><title>Café &amp; cie</title><meta property="og:image" content="pic.png"></head>';
    const answer = await resolveLinkPreviewWithDeviceHead(deps, scope, ARTICLE, latin1);
    expect(answer.preview).toMatchObject({ title: "Café & cie", image: { width: 1 } });
    expect(requests).toContain("https://cdn.test/assets/pic.png");
  });

  it("counts against the composer's read budget, and stops when it is spent", async () => {
    const { deps, db } = site();
    await resolveLinkPreviewDetailed(deps, scope, ARTICLE);
    await resolveLinkPreviewWithDeviceHead(deps, scope, ARTICLE, HEAD);
    expect(db.tables.linkPreviewRead.size).toBe(2);

    const limited = site();
    for (let index = 0; index < 9; index += 1) {
      limited.db.tables.linkPreviewRead.set(`r${index}`, {
        id: `r${index}`,
        spaceId: "space-1",
        userId: "user-1",
        source: "composer",
        createdAt: new Date(),
      });
    }
    // One read left: the refusal check takes it, the device head finds the budget gone.
    const answer = await resolveLinkPreviewWithDeviceHead(limited.deps, scope, ARTICLE, HEAD);
    expect(answer.preview).toMatchObject({ title: "Le vrai titre du jour" });
    expect(limited.cacheRows()).toMatchObject([{ source: "restricted" }]);
  });
});

describe("the cache serves the device's card to everything else in the space (CA 85)", () => {
  const text = (value: string) => ({ kind: "text", text: value });
  const card = (blocks: unknown[] | undefined) =>
    blocks?.find((block) => (block as { kind?: string }).kind === "link_preview") as
      | Record<string, unknown>
      | undefined;

  async function withDeviceCard(spaceId = "space-1") {
    const ctx = site();
    if (spaceId !== "space-1") {
      ctx.db.seedThread({ id: "thread-2", spaceId });
    }
    await resolveLinkPreviewWithDeviceHead(ctx.deps, scope, ARTICLE, HEAD);
    ctx.requests.length = 0;
    return ctx;
  }

  it("gives the message that is sent the full card, with no new request", async () => {
    const { db, deps, requests } = await withDeviceCard();
    db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(`look ${ARTICLE}`)] });

    await runLinkPreviewJob(deps, { messageId: "m1" });

    expect(card(db.blocksOf("m1"))).toMatchObject({
      url: ARTICLE,
      format: "compact",
      title: "Le vrai titre",
      image: { width: 1, height: 1 },
    });
    expect(requests).toEqual([]);
  });

  it("gives a bot that sends the same link within the day the full card too", async () => {
    const { db, deps, requests } = await withDeviceCard();
    db.seedRun({ id: "run-1", threadId: "thread-1" });
    db.seedMessage({
      id: "final",
      threadId: "thread-1",
      role: "bot",
      runId: "run-1",
      blocks: [text(`Source: ${ARTICLE}`)],
    });

    await runLinkPreviewJob(deps, { runId: "run-1" });

    expect(card(db.blocksOf("final"))).toMatchObject({ title: "Le vrai titre" });
    expect(requests).toEqual([]);
  });

  it("does not give it to another space, which reads (and is refused) for itself", async () => {
    const { db, deps, requests } = await withDeviceCard();
    db.seedThread({ id: "thread-2", spaceId: "space-2", userId: "user-2", botId: "bot-2" });
    db.seedMessage({ id: "m2", threadId: "thread-2", blocks: [text(`look ${ARTICLE}`)] });

    await runLinkPreviewJob(deps, { messageId: "m2" });

    expect(card(db.blocksOf("m2"))).toMatchObject({ title: "Le vrai titre du jour" });
    expect(requests).toContain(ARTICLE);
    expect(requests).not.toContain(IMAGE);
  });
});
