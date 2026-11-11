import {
  createLinkPreviewFetcherForTests,
  createReadLimiter,
  type LinkPreviewJobDeps,
  type LinkPreviewReadResult,
  runLinkPreviewJob,
} from "@tangow/adapters";
import type { MessageBlock } from "@tangow/contracts";
import { appendLinkBlocks, removeLinkPreviewBlock } from "@tangow/db";
import { createLogger, createTestSink, installLogger } from "@tangow/logging";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openThreadDb, type ThreadDb } from "./thread-db.js";

const PAGE = "https://example.test/articles/one?id=7";
const png = new Uint8Array([1, 2, 3, 4]);
const okCompact: LinkPreviewReadResult = {
  ok: true,
  kind: "page",
  article: true,
  title: "A page",
};
const image = { bytes: Buffer.from(png), width: 1200, height: 630 };
const okLarge: LinkPreviewReadResult = {
  ok: true,
  kind: "page",
  article: true,
  title: "A big page",
  image,
};

let db: ThreadDb;
beforeAll(async () => {
  db = await openThreadDb();
}, 60_000);
beforeEach(() => db.reset());
afterAll(() => db.close());

async function setup(
  options: {
    read?: LinkPreviewJobDeps["read"];
    group?: boolean;
    spaceId?: string;
    threadId?: string;
    botId?: string;
  } = {},
) {
  const { threadId = "thread-1", spaceId, botId } = options;
  await db.seedThread({
    id: threadId,
    spaceId,
    botId,
    ...(options.group ? { group: { id: "group-1", memberBotIds: ["bot-first", "bot-b"] } } : {}),
  });
  const read = vi.fn(options.read ?? (async () => okCompact));
  const notify = vi.fn(async () => undefined);
  const deps: LinkPreviewJobDeps = {
    prisma: db.prisma,
    artifacts: db.artifacts,
    events: { notify },
    read,
  };
  return { read, notify, deps };
}

const text = (value: string): MessageBlock => ({ kind: "text", text: value });
const said = (id: string, blocks: MessageBlock[], threadId = "thread-1") =>
  db.seedMessage({ id, threadId, blocks });
const card = async (messageId: string) => (await db.previewOf(messageId)).card;
const previewArtifacts = () => db.prisma.artifact.findMany({ where: { isLinkPreview: true } });

afterEach(() => installLogger(createLogger({ service: "tangow-worker", level: "off", sinks: [] })));

describe("link.preview job for a message a person sent", () => {
  it("logs the card against the message and tells the thread once", async () => {
    const { read, notify, deps } = await setup();
    await said("m1", [text(`look ${PAGE} ok`)]);

    await runLinkPreviewJob(deps, { messageId: "m1" });

    expect(read).toHaveBeenCalledTimes(1);
    expect(await card("m1")).toEqual({
      kind: "link_preview",
      url: PAGE,
      format: "compact",
      title: "A page",
    });
    const preview = await db.prisma.sessionEntry.findFirstOrThrow({
      where: { type: "link.preview" },
    });
    expect(preview.botId).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("thread-1", expect.any(Number));
  });

  it("copies the cached image into an artifact owned like the thread's attachments", async () => {
    const { deps } = await setup({ read: async () => okLarge });
    await said("m1", [text(PAGE)]);

    await runLinkPreviewJob(deps, { messageId: "m1" });

    const [artifact] = await previewArtifacts();
    expect(artifact).toMatchObject({
      previewMessageId: "m1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      groupId: null,
      mimeType: "image/webp",
    });
    expect(await card("m1")).toMatchObject({
      format: "large",
      image: { artifactId: artifact?.id, width: 1200, height: 630 },
    });
    // The cache keeps its own bytes: deleting the artifact must never empty the cache.
    const [cached] = await db.prisma.linkPreviewCache.findMany();
    expect(cached?.imageKey).toBeDefined();
    expect(cached?.imageKey).not.toBe(artifact?.storageKey);
    expect(db.artifacts.keys()).toContain(cached?.imageKey);
    expect(db.artifacts.keys()).toContain(artifact?.storageKey);
  });

  it("writes the icon marker on the card image of a site icon, and not on a page image", async () => {
    const icon = await setup({
      read: async () => ({ ...okLarge, image: { ...image, fit: "contain" } }),
    });
    await said("m1", [text(PAGE)]);
    await runLinkPreviewJob(icon.deps, { messageId: "m1" });
    expect(await card("m1")).toMatchObject({ format: "compact", image: { fit: "contain" } });

    const page = await setup({
      read: async () => okLarge,
      threadId: "thread-2",
      botId: "bot-2",
      spaceId: "space-2",
    });
    await said("m2", [text(PAGE)], "thread-2");
    await runLinkPreviewJob(page.deps, { messageId: "m2" });
    expect((await card("m2"))?.image).not.toHaveProperty("fit");
  });

  it("owns the image of a group thread by the group and its first member", async () => {
    const { deps } = await setup({ read: async () => okLarge, group: true });
    await said("m1", [text(PAGE)]);

    await runLinkPreviewJob(deps, { messageId: "m1" });

    const [artifact] = await previewArtifacts();
    expect(artifact).toMatchObject({ groupId: "group-1", botId: "bot-first", userId: "user-1" });
    expect(await card("m1")).toBeDefined();
  });

  describe("skips (CA 28, CA 57)", () => {
    const cases: Array<[string, () => Promise<void>]> = [
      ["a message with no link", () => said("m1", [text("hello")])],
      ["a link in a code fence", () => said("m1", [text(`\`\`\`\n${PAGE}\n\`\`\``)])],
      [
        "a message sent with the preview turned off",
        () => said("m1", [text(PAGE), { kind: "link_preview", removed: true }]),
      ],
      [
        "a link that names a secret in its query",
        () => said("m1", [text("https://example.test/page?token=abc")]),
      ],
      [
        "a message an external channel brought in",
        () =>
          db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)], external: true }),
      ],
      [
        "a message with a pending ask",
        () => said("m1", [text(PAGE), { kind: "ask", text: "Allow?", status: "pending" }]),
      ],
      [
        "an answered ask: the same rule as the screens",
        () => said("m1", [text(PAGE), { kind: "ask", text: "Allow?", status: "answered" }]),
      ],
      [
        "a routine run card",
        () => said("m1", [text(PAGE), { kind: "routine_run", routineName: "r", state: "running" }]),
      ],
      [
        "a handoff",
        () =>
          said("m1", [{ kind: "handoff", fromBotId: "a", toBotId: "b", text: PAGE }, text(PAGE)]),
      ],
      [
        "a message that is not the person's",
        () =>
          db.seedMessage({
            id: "m1",
            threadId: "thread-1",
            blocks: [text(PAGE)],
            from: { botId: "bot-1" },
          }),
      ],
    ];

    it.each(cases)("reads nothing and writes nothing for %s", async (_name, seed) => {
      const { read, notify, deps } = await setup();
      await seed();

      await runLinkPreviewJob(deps, { messageId: "m1" });

      expect(read).not.toHaveBeenCalled();
      expect(await db.prisma.sessionEntry.count({ where: { type: "link.preview" } })).toBe(0);
      expect(await db.prisma.linkPreviewCache.count()).toBe(0);
      expect(await db.prisma.linkPreviewRead.count()).toBe(0);
      expect(notify).not.toHaveBeenCalled();
    });

    it("logs nothing at all for a secret link (no read, no cache, no log)", async () => {
      const { deps } = await setup();
      const sink = createTestSink();
      installLogger(createLogger({ service: "tangow-worker", sinks: [sink] }));
      await said("m1", [text("https://example.test/p?magic=SECRET")]);

      await runLinkPreviewJob(deps, { messageId: "m1" });

      expect(sink.events).toEqual([]);
    });

    it("does nothing for a message that is gone", async () => {
      const { read, deps } = await setup();
      await expect(runLinkPreviewJob(deps, { messageId: "missing" })).resolves.toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe("cache (CA 21, CA 22)", () => {
    it("reads a link once for two messages of the same space", async () => {
      const { read, deps } = await setup();
      await said("m1", [text(PAGE)]);
      await said("m2", [text(`#2 ${PAGE}#frag`)]);

      await runLinkPreviewJob(deps, { messageId: "m1" });
      await runLinkPreviewJob(deps, { messageId: "m2" });

      expect(read).toHaveBeenCalledTimes(1);
      expect(await card("m2")).toMatchObject({ title: "A page" });
    });

    it("does not store the URL, only its hash, and never shares it between spaces", async () => {
      const first = await setup();
      await said("m1", [text(PAGE)]);
      await runLinkPreviewJob(first.deps, { messageId: "m1" });
      const [row] = await db.prisma.linkPreviewCache.findMany();
      expect(JSON.stringify(row)).not.toContain("example.test");
      expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/);

      const second = await setup({ spaceId: "space-2", threadId: "thread-2", botId: "bot-2" });
      await said("m2", [text(PAGE)], "thread-2");
      await runLinkPreviewJob(second.deps, { messageId: "m2" });
      const [other] = await db.prisma.linkPreviewCache.findMany({ where: { spaceId: "space-2" } });
      expect(other?.keyHash).not.toBe(row?.keyHash);
      expect(second.read).toHaveBeenCalledTimes(1);
    });

    it("caches a definitive failure and shows no card", async () => {
      const { read, deps } = await setup({
        read: async () => ({ ok: false, reason: "http_error", transient: false }),
      });
      await said("m1", [text(PAGE)]);
      await said("m2", [text(PAGE)]);

      await runLinkPreviewJob(deps, { messageId: "m1" });
      await runLinkPreviewJob(deps, { messageId: "m2" });

      expect(read).toHaveBeenCalledTimes(1);
      expect((await db.prisma.linkPreviewCache.findFirst())?.status).toBe("unreadable");
      expect(await card("m1")).toBeUndefined();
      expect(await card("m2")).toBeUndefined();
    });

    it("never caches a transient failure and never retries inside one job", async () => {
      const { read, deps } = await setup({
        read: async () => ({ ok: false, reason: "timeout", transient: true }),
      });
      await said("m1", [text(PAGE)]);

      await runLinkPreviewJob(deps, { messageId: "m1" });
      expect(read).toHaveBeenCalledTimes(1);
      expect(await db.prisma.linkPreviewCache.count()).toBe(0);

      await said("m2", [text(PAGE)]);
      await runLinkPreviewJob(deps, { messageId: "m2" });
      expect(read).toHaveBeenCalledTimes(2);
    });

    it("stops at 30 real reads a minute per space, without a negative cache", async () => {
      const { read, deps } = await setup();
      for (let index = 0; index < 31; index += 1) {
        await said(`m${index}`, [text(`https://example.test/page-${index}`)]);
      }

      for (let index = 0; index < 31; index += 1) {
        await runLinkPreviewJob(deps, { messageId: `m${index}` });
      }

      expect(read).toHaveBeenCalledTimes(30);
      expect(await card("m29")).toBeDefined();
      expect(await card("m30")).toBeUndefined();
      // The refused link left nothing behind: it is tried again once the minute is over.
      expect(await db.prisma.linkPreviewCache.count()).toBe(30);
      expect(await db.prisma.linkPreviewRead.count()).toBe(30);
    });

    it("counts reads per space: another space still has its 30", async () => {
      const busy = await setup();
      await db.prisma.linkPreviewRead.createMany({
        data: Array.from({ length: 30 }, () => ({ spaceId: "space-1", source: "job" })),
      });
      await said("m1", [text(PAGE)]);
      await runLinkPreviewJob(busy.deps, { messageId: "m1" });
      expect(busy.read).not.toHaveBeenCalled();

      const other = await setup({ spaceId: "space-2", threadId: "thread-2", botId: "bot-2" });
      await said("m2", [text(PAGE)], "thread-2");
      await runLinkPreviewJob(other.deps, { messageId: "m2" });
      expect(other.read).toHaveBeenCalledTimes(1);
    });
  });

  describe("concurrency (CA 17, CA 40)", () => {
    it("writes nothing when the thread was deleted while the page was read", async () => {
      const { notify, deps } = await setup({
        read: async () => {
          await db.prisma.thread.delete({ where: { id: "thread-1" } });
          return okLarge;
        },
      });
      await said("m1", [text(PAGE)]);

      await runLinkPreviewJob(deps, { messageId: "m1" });

      expect(await db.prisma.sessionEntry.count({ where: { type: "link.preview" } })).toBe(0);
      expect(notify).not.toHaveBeenCalled();
      // No card image was left behind for it, row or bytes: only the cache's own copy.
      expect(await previewArtifacts()).toEqual([]);
      expect(db.artifacts.keys()).toHaveLength(1);
    });

    it("drops the card when the preview was removed while the page was read", async () => {
      const { deps } = await setup({
        read: async () => {
          await removeLinkPreviewBlock(db.prisma, {
            spaceId: "space-1",
            threadId: "thread-1",
            messageId: "m1",
          });
          return okLarge;
        },
      });
      await said("m1", [text(PAGE)]);

      await runLinkPreviewJob(deps, { messageId: "m1" });

      expect(await db.previewOf("m1")).toEqual({ removed: true });
      expect(await previewArtifacts()).toEqual([]);
      // Only the cache's own copy of the image is left.
      expect(db.artifacts.keys()).toHaveLength(1);
    });

    it("does not deadlock the thread while the page is being read", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { deps } = await setup({
        read: async () => {
          await gate;
          return okCompact;
        },
      });
      await said("m1", [text(PAGE)]);

      const job = runLinkPreviewJob(deps, { messageId: "m1" });
      // A write that needs the thread lock (what finalizeRun and threads.send do) goes through.
      await db.prisma.$transaction(
        (tx) => tx.$queryRaw`SELECT id FROM threads WHERE id = ${"thread-1"} FOR UPDATE`,
      );
      release();
      await job;

      expect(await card("m1")).toBeDefined();
    });
  });

  describe("never throws", () => {
    it("survives a reader that throws", async () => {
      const { deps } = await setup({
        read: async () => {
          throw new Error("boom https://example.test/secret?token=1");
        },
      });
      const sink = createTestSink();
      installLogger(createLogger({ service: "tangow-worker", sinks: [sink] }));
      await said("m1", [text(PAGE)]);

      await expect(runLinkPreviewJob(deps, { messageId: "m1" })).resolves.toBeUndefined();

      expect(JSON.stringify(sink.events)).not.toContain("example.test");
    });

    it("survives a database that fails", async () => {
      const { deps } = await setup();
      const broken = {
        ...deps,
        prisma: {
          sessionEntry: {
            findUnique: async () => {
              throw new Error("database down");
            },
          },
        },
      } as unknown as LinkPreviewJobDeps;
      await expect(runLinkPreviewJob(broken, { messageId: "m1" })).resolves.toBeUndefined();
    });

    it("gives up after its own deadline", async () => {
      const { deps } = await setup({
        read: async (_url, readDeps) => {
          await new Promise<void>((resolve) => {
            if (readDeps.signal?.aborted) resolve();
            readDeps.signal?.addEventListener("abort", () => resolve());
          });
          return { ok: false, reason: "aborted", transient: true };
        },
      });
      await said("m1", [text(PAGE)]);

      await runLinkPreviewJob({ ...deps, timeoutMs: 30 }, { messageId: "m1" });

      expect(await card("m1")).toBeUndefined();
    });
  });
});

describe("link.preview job: one mention per link (CA 6, 7, 16, 19, 20, 22, 30)", () => {
  const tool = (title: string): LinkPreviewReadResult => ({
    ok: true,
    kind: "page",
    article: false,
    title,
  });
  const byHost: LinkPreviewJobDeps["read"] = async (url) =>
    url.includes("news.test") ? okCompact : tool(new URL(url).hostname);
  const mentions = async (id: string) => (await db.mentionsOf(id)).map((block) => block.url);
  const urlsRead = (read: { mock: { calls: Array<[string, ...unknown[]]> } }) =>
    read.mock.calls.map(([url]) => url).sort();

  it("filters links before counting: a token or sign-in link takes no slot and no read (CA 20)", async () => {
    const { read, deps } = await setup({ read: byHost });
    await said("m1", [
      text(
        "https://a.test/x?token=1 https://accounts.google.com/signin https://b.test/1 https://c.test/2 https://d.test/3",
      ),
    ]);

    await runLinkPreviewJob(deps, { messageId: "m1" });

    expect(urlsRead(read)).toEqual(["https://b.test/1", "https://c.test/2", "https://d.test/3"]);
    expect(await mentions("m1")).toEqual([
      "https://b.test/1",
      "https://c.test/2",
      "https://d.test/3",
    ]);
  });

  it("mentions the first five links in text order and leaves the rest plain (CA 6)", async () => {
    const { read, deps } = await setup({ read: byHost });
    const seven = Array.from({ length: 7 }, (_, i) => `https://s${i}.test/p`);
    await said("m1", [text(seven.join(" "))]);

    await runLinkPreviewJob(deps, { messageId: "m1" });

    expect(urlsRead(read)).toEqual(seven.slice(0, 5));
    expect(await mentions("m1")).toEqual(seven.slice(0, 5));
  });

  it("reads and mentions a link once, however it is written (CA 16)", async () => {
    const { read, deps } = await setup({ read: byHost });
    await said("m1", [
      text(
        "www.x.test/a and https://www.x.test/a#b\n- https://y.test/doc\n\nsee [the doc](https://y.test/doc)",
      ),
    ]);

    await runLinkPreviewJob(deps, { messageId: "m1" });

    expect(urlsRead(read)).toEqual(["https://www.x.test/a", "https://y.test/doc"]);
    expect(await mentions("m1")).toEqual(["https://www.x.test/a", "https://y.test/doc"]);
  });

  it("gives a first article a card and every link a mention; never reads a mention's page image (CA 7)", async () => {
    const { read, deps } = await setup({ read: byHost });
    const article = "https://news.test/story";
    await said("m1", [text(`${article} https://figma.test/f https://notion.test/n`)]);
    await said("m2", [text(`https://figma.test/f ${article} https://notion.test/n`)]);

    await runLinkPreviewJob(deps, { messageId: "m1" });
    await runLinkPreviewJob(deps, { messageId: "m2" });

    expect(await card("m1")).toEqual({
      kind: "link_preview",
      url: article,
      format: "compact",
      title: "A page",
    });
    expect(await db.mentionsOf("m1")).toEqual([
      { kind: "link_mention", url: article, title: "A page" },
      { kind: "link_mention", url: "https://figma.test/f", title: "figma.test" },
      { kind: "link_mention", url: "https://notion.test/n", title: "notion.test" },
    ]);
    expect(
      Object.fromEntries(read.mock.calls.slice(0, 3).map(([url, d]) => [url, d.pageImage])),
    ).toEqual({
      [article]: undefined,
      "https://figma.test/f": false,
      "https://notion.test/n": false,
    });
    expect(await card("m2")).toBeUndefined();
    expect(await mentions("m2")).toEqual([
      "https://figma.test/f",
      article,
      "https://notion.test/n",
    ]);
  });

  it("writes a five-link message as a card event, then a mention event, and one notification (CA 22)", async () => {
    const { notify, deps } = await setup({ read: byHost });
    await said("m1", [
      text(
        "https://news.test/1 https://b.test/2 https://c.test/3 https://d.test/4 https://e.test/5",
      ),
    ]);
    const feed = async () =>
      (
        await db.prisma.event.findMany({
          where: { type: "session.entry.appended" },
          orderBy: { seq: "asc" },
        })
      ).map((event) =>
        (
          event.payload as { entries: Array<{ payload: { block?: { kind: string } } }> }
        ).entries.map((entry) => entry.payload.block?.kind),
      );
    const before = (await feed()).length;

    await runLinkPreviewJob(deps, { messageId: "m1" });

    expect((await feed()).slice(before)).toEqual([
      ["link_preview"],
      ["link_mention", "link_mention", "link_mention", "link_mention", "link_mention"],
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("leaves the remaining links plain once the space's quota is spent (CA 19)", async () => {
    const { read, deps } = await setup({ read: byHost });
    await db.prisma.linkPreviewRead.createMany({
      data: Array.from({ length: 28 }, () => ({ spaceId: "space-1", source: "job" })),
    });
    const five = ["a", "b", "c", "d", "e"].map((host) => `https://${host}.test/p`);
    await said("m1", [text(five.join(" "))]);

    await runLinkPreviewJob(deps, { messageId: "m1" });
    await runLinkPreviewJob(deps, { messageId: "m1" });

    expect(urlsRead(read)).toEqual(five.slice(0, 2));
    expect(await mentions("m1")).toEqual(five.slice(0, 2));
  });

  it("completes a partial set on a rerun without a duplicate", async () => {
    const { deps } = await setup({ read: byHost });
    await said("m1", [text("https://a.test/1 https://b.test/2 https://c.test/3")]);
    await appendLinkBlocks(db.prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      messageId: "m1",
      blocks: [{ kind: "link_mention", url: "https://b.test/2", title: "Earlier" }],
    });

    await runLinkPreviewJob(deps, { messageId: "m1" });

    expect(await db.mentionsOf("m1")).toEqual([
      { kind: "link_mention", url: "https://b.test/2", title: "Earlier" },
      { kind: "link_mention", url: "https://a.test/1", title: "a.test" },
      { kind: "link_mention", url: "https://c.test/3", title: "c.test" },
    ]);
  });

  it("gives a message that is only an article's link its card and no mention (CA 17)", async () => {
    const { deps } = await setup({ read: byHost });
    await said("m1", [text("https://news.test/story")]);
    await said("m2", [text("https://figma.test/f")]);

    await runLinkPreviewJob(deps, { messageId: "m1" });
    await runLinkPreviewJob(deps, { messageId: "m2" });

    expect(await card("m1")).toMatchObject({ url: "https://news.test/story" });
    expect(await mentions("m1")).toEqual([]);
    expect(await mentions("m2")).toEqual(["https://figma.test/f"]);
  });

  it("reads two links at a time, starting each as a read ends, in text order (CA 22)", async () => {
    const started: string[] = [];
    const answers = new Map<string, () => void>();
    const { deps } = await setup({
      read: (url) =>
        new Promise((resolve) => {
          started.push(url);
          answers.set(url, () => resolve(tool(new URL(url).hostname)));
        }),
    });
    const four = ["a", "b", "c", "d"].map((host) => `https://${host}.test/p`);
    const answer = (index: number) => answers.get(four[index] as string)?.();
    await said("m1", [text(four.join(" "))]);

    const job = runLinkPreviewJob(deps, { messageId: "m1" });
    await vi.waitFor(() => expect(started).toEqual(four.slice(0, 2)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(started).toEqual(four.slice(0, 2));
    answer(1);
    await vi.waitFor(() => expect(started).toEqual(four.slice(0, 3)));
    answer(0);
    await vi.waitFor(() => expect(started).toEqual(four));
    answer(2);
    answer(3);
    await job;

    expect(await mentions("m1")).toEqual(four);
  });

  it("reads no link after the one the quota refused, even once the quota has room (CA 19)", async () => {
    const { read, deps } = await setup({ read: byHost });
    const minute = Date.parse("2026-10-17T12:00:00.000Z");
    await db.prisma.linkPreviewRead.createMany({
      data: Array.from({ length: 30 }, () => ({
        spaceId: "space-1",
        source: "job",
        createdAt: new Date(minute),
      })),
    });
    // Each link asks the clock once, in text order: only the second finds the minute full.
    const clock = [minute + 61_000, minute + 30_000];
    const five = ["a", "b", "c", "d", "e"].map((host) => `https://${host}.test/p`);
    await said("m1", [text(five.join(" "))]);

    await runLinkPreviewJob(
      { ...deps, now: () => new Date(clock.shift() ?? minute + 120_000) },
      { messageId: "m1" },
    );

    expect(urlsRead(read)).toEqual(five.slice(0, 1));
    expect(await mentions("m1")).toEqual(five.slice(0, 1));
  });

  it("writes the mentions read before the deadline in one notification, the late link plain", async () => {
    const late = "https://late.test/p";
    const { notify, deps } = await setup({
      read: async (url, readDeps) => {
        if (url !== late) return tool(new URL(url).hostname);
        await new Promise<void>((resolve) => {
          if (readDeps.signal?.aborted) resolve();
          readDeps.signal?.addEventListener("abort", () => resolve());
        });
        return { ok: false, reason: "aborted", transient: true };
      },
    });
    await said("m1", [text(`https://a.test/1 https://b.test/2 ${late}`)]);

    await runLinkPreviewJob({ ...deps, timeoutMs: 500 }, { messageId: "m1" });

    expect(await mentions("m1")).toEqual(["https://a.test/1", "https://b.test/2"]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("copies a mention's icon into a preview artifact of the message (CA 30)", async () => {
    const icon = { bytes: Buffer.from(png), width: 64, height: 64 };
    const { deps } = await setup({ read: async () => ({ ...tool("Doc"), icon }) });
    await said("m1", [text("https://docs.test/d")]);

    await runLinkPreviewJob(deps, { messageId: "m1" });

    const [artifact] = await previewArtifacts();
    expect(artifact).toMatchObject({ isLinkPreview: true, previewMessageId: "m1" });
    expect(await db.mentionsOf("m1")).toEqual([
      {
        kind: "link_mention",
        url: "https://docs.test/d",
        title: "Doc",
        icon: { artifactId: artifact?.id },
      },
    ]);
  });
});

describe("link.preview job for a bot's run (CA 13, CA 70, CA 71)", () => {
  const LINK = "https://a.test/x";

  async function run(options: {
    status?: string;
    trigger?: string;
    messages?: Array<{ id: string; blocks: MessageBlock[]; midTurn?: true; toPerson?: true }>;
    read?: LinkPreviewJobDeps["read"];
  }) {
    const ctx = await setup({ read: options.read });
    await db.seedRun({
      id: "run-1",
      threadId: "thread-1",
      status: options.status,
      trigger: options.trigger,
      messages: options.messages ?? [{ id: "final", blocks: [text(`Source: ${LINK}`)] }],
    });
    return ctx;
  }

  it("previews the final reply and the message_user posts, whether or not the bot opened the link (CA 70)", async () => {
    const { read, deps } = await run({
      messages: [
        { id: "progress", midTurn: true, blocks: [text(`working on ${LINK}`)] },
        { id: "said", midTurn: true, toPerson: true, blocks: [text(`here: ${LINK}`)] },
        { id: "final", blocks: [text(`Source: ${LINK}`)] },
      ],
    });

    await runLinkPreviewJob(deps, { runId: "run-1" });

    expect(await card("said")).toMatchObject({ url: LINK });
    expect(await card("final")).toMatchObject({ url: LINK });
    // Narration is never previewed.
    expect(await card("progress")).toBeUndefined();
    // Same link twice: one page read.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("gives every link of the reply a mention, and none to the narration before it", async () => {
    const news = "https://news.test/story";
    const { deps } = await run({
      read: async (url) =>
        url.startsWith(news) ? okCompact : { ok: true, kind: "page", article: false },
      messages: [
        {
          id: "progress",
          midTurn: true,
          blocks: [text("checking https://b.test/1 https://c.test/2")],
        },
        { id: "final", blocks: [text(`See ${news}, https://b.test/1 and https://c.test/2`)] },
      ],
    });

    await runLinkPreviewJob(deps, { runId: "run-1" });

    expect(await card("final")).toMatchObject({ url: news });
    expect((await db.mentionsOf("final")).map((block) => block.url)).toEqual([
      news,
      "https://b.test/1",
      "https://c.test/2",
    ]);
    expect(await db.mentionsOf("progress")).toEqual([]);
  });

  it("reads a site's icon once for all the messages of a run (CA 23)", async () => {
    const icon = PNG.sync.write(new PNG({ width: 64, height: 64 }));
    const requests: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      return url.endsWith(".png")
        ? new Response(icon, { headers: { "content-type": "image/png" } })
        : new Response(
            '<head><title>Doc</title><link rel="apple-touch-icon" href="/i.png"></head>',
            {
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          );
    };
    const { deps } = await run({
      messages: [
        { id: "said", midTurn: true, toPerson: true, blocks: [text("https://docs.test/a")] },
        { id: "final", blocks: [text("https://docs.test/b")] },
      ],
    });
    const { read: _fakeReader, ...withRealReader } = deps;

    await runLinkPreviewJob(
      {
        ...withRealReader,
        readDeps: {
          fetchResource: createLinkPreviewFetcherForTests({ fetch }),
          resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }],
          limiter: createReadLimiter(),
        },
      },
      { runId: "run-1" },
    );

    expect(requests).toEqual([
      "https://docs.test/a",
      "https://docs.test/i.png",
      "https://docs.test/b",
    ]);
    expect([...(await db.mentionsOf("said")), ...(await db.mentionsOf("final"))]).toMatchObject([
      { url: "https://docs.test/a", icon: { artifactId: expect.any(String) } },
      { url: "https://docs.test/b", icon: { artifactId: expect.any(String) } },
    ]);
  });

  it("puts a post's previews on that post when another post came just before it", async () => {
    // Tool calls live in another session, so the two posts follow each other in the thread's.
    const { deps } = await run({
      messages: [
        { id: "first", midTurn: true, toPerson: true, blocks: [text("Looking into it.")] },
        { id: "second", midTurn: true, toPerson: true, blocks: [text(`Found it: ${LINK}`)] },
      ],
    });

    await runLinkPreviewJob(deps, { runId: "run-1" });

    expect(await card("second")).toMatchObject({ url: LINK });
    expect(await card("first")).toBeUndefined();
    expect(await db.mentionsOf("first")).toEqual([]);
  });

  it("previews a link from a run that used no tool at all", async () => {
    const { deps } = await run({
      messages: [{ id: "final", blocks: [text("https://never-opened.test/page")] }],
    });
    await runLinkPreviewJob(deps, { runId: "run-1" });
    expect(await card("final")).toMatchObject({ url: "https://never-opened.test/page" });
  });

  it.each([
    ["a failed run", { status: "failed" }],
    ["a stopped run", { status: "cancelled" }],
    ["a run still going", { status: "running" }],
    ["a bot-to-bot run", { trigger: "bot_message" }],
  ])("shows no card for %s", async (_name, options) => {
    const { read, deps } = await run(options);
    await runLinkPreviewJob(deps, { runId: "run-1" });
    expect(read).not.toHaveBeenCalled();
    expect(await card("final")).toBeUndefined();
  });

  it.each([
    "https://accounts.google.com/signin/v2/identifier",
    "https://login.example.com/",
    "https://example.com/sso",
    "https://example.com/a/sign-in",
  ])("reads nothing for a link to a sign-in page: %s (CA 71)", async (link) => {
    const { read, deps } = await run({ messages: [{ id: "final", blocks: [text(link)] }] });
    await runLinkPreviewJob(deps, { runId: "run-1" });
    expect(read).not.toHaveBeenCalled();
    expect(await card("final")).toBeUndefined();
  });

  it("still previews a page whose path only contains a sign-in word", async () => {
    const link = "https://example.com/blog/login-tips";
    const { deps } = await run({ messages: [{ id: "final", blocks: [text(link)] }] });
    await runLinkPreviewJob(deps, { runId: "run-1" });
    expect(await card("final")).toMatchObject({ url: link });
  });
});

describe("link.preview job for a routine's result (spec 3.5)", () => {
  const LINKS = ["https://a.test/1", "https://b.test/2", "https://c.test/3"];
  const tool = (title: string): LinkPreviewReadResult => ({
    ok: true,
    kind: "page",
    article: false,
    title,
  });

  async function routineRun(options: {
    status?: string;
    result: string;
    read?: (url: string) => Promise<LinkPreviewReadResult>;
  }) {
    const ctx = await setup({
      read: options.read ?? (async (url) => tool(new URL(url).hostname)),
    });
    await db.seedRun({
      id: "run-1",
      threadId: "thread-1",
      status: options.status ?? "completed",
      trigger: "routine",
      messages: [{ id: "final", blocks: [text(options.result)] }],
      routine: { result: options.result },
    });
    const report = await db.prisma.sessionEntry.findFirst({
      where: { type: "routine.finished" },
      select: { id: true },
    });
    return { ...ctx, reportId: report?.id };
  }

  it("mentions every link of the result the thread shows, on the routine's mark", async () => {
    const { deps, reportId } = await routineRun({
      result: `This week: ${LINKS[0]}, ${LINKS[1]} and ${LINKS[2]}`,
    });

    await runLinkPreviewJob(deps, { runId: "run-1" });

    expect((await db.mentionsOf(reportId!)).map(({ url, title }) => ({ url, title }))).toEqual([
      { url: "https://a.test/1", title: "a.test" },
      { url: "https://b.test/2", title: "b.test" },
      { url: "https://c.test/3", title: "c.test" },
    ]);
    // The run's own words stay in its session, which the thread does not show.
    expect(await db.mentionsOf("final")).toEqual([]);
  });

  it("writes the same mentions when the job runs twice on the mark", async () => {
    const { deps, reportId } = await routineRun({ result: `${LINKS[0]} and ${LINKS[1]}` });

    await runLinkPreviewJob(deps, { runId: "run-1" });
    const once = await db.mentionsOf(reportId!);
    await runLinkPreviewJob(deps, { runId: "run-1" });

    expect(once.map((block) => block.url)).toEqual([LINKS[0], LINKS[1]]);
    expect(await db.mentionsOf(reportId!)).toEqual(once);
  });

  it("keeps a mention's icon as a preview artifact of the mark", async () => {
    const icon = { bytes: Buffer.from(png), width: 64, height: 64 };
    const { deps, reportId } = await routineRun({
      result: LINKS[0],
      read: async () => ({ ...tool("Doc"), icon }),
    });

    await runLinkPreviewJob(deps, { runId: "run-1" });

    const [artifact] = await previewArtifacts();
    expect(artifact).toMatchObject({ isLinkPreview: true, previewMessageId: reportId });
    expect(await db.mentionsOf(reportId!)).toMatchObject([
      { url: LINKS[0], icon: { artifactId: artifact?.id } },
    ]);
  });

  it.each([
    ["a routine that had nothing to say", { result: "" }],
    ["a blank result", { result: "  \n " }],
    ["a routine that failed", { status: "failed", result: `Partial: ${LINKS[0]}` }],
  ])("reads nothing for %s", async (_name, options) => {
    const { read, deps, reportId } = await routineRun(options);

    await runLinkPreviewJob(deps, { runId: "run-1" });

    expect(reportId).toEqual(expect.any(String));
    expect(read).not.toHaveBeenCalled();
    expect(await db.mentionsOf(reportId!)).toEqual([]);
  });
});
