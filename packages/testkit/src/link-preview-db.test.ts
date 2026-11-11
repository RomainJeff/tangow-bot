import { createLinkPreviewPurge, sweepOrphanPreviewArtifacts } from "@tangow/adapters";
import { ThreadEntrySchema } from "@tangow/contracts";
import {
  appendLinkBlocks,
  findCachedLinkPreview,
  findOrphanPreviewArtifacts,
  LINK_PREVIEW_ACTOR_READS_PER_MINUTE,
  LINK_PREVIEW_CACHE_MAX_BYTES,
  LINK_PREVIEW_CACHE_MAX_ENTRIES,
  LINK_PREVIEW_CACHE_TTL_MS,
  linkPreviewKeyHash,
  purgeLinkPreviewState,
  removeLinkPreviewBlock,
  reserveLinkPreviewRead,
  rewindThread,
  storeLinkPreviewCache,
} from "@tangow/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeThreadDb } from "./fake-thread-db.js";
import { openThreadDb, type ThreadDb } from "./thread-db.js";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const ok = (extra: Record<string, unknown> = {}) => ({
  kind: "page" as const,
  title: "A page",
  article: true as const,
  ...extra,
});

describe("cache key", () => {
  it("is a sha256 of the space and the URL, so it differs per space and holds no URL", () => {
    const one = linkPreviewKeyHash("space-1", "https://example.test/a");
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(one).toBe(linkPreviewKeyHash("space-1", "https://example.test/a"));
    expect(one).not.toBe(linkPreviewKeyHash("space-2", "https://example.test/a"));
    expect(one).not.toBe(linkPreviewKeyHash("space-1", "https://example.test/b"));
  });
});

describe("cache entries", () => {
  it("serves an entry for 24 hours, then not", async () => {
    const db = createFakeThreadDb();
    const key = linkPreviewKeyHash("space-1", "https://example.test/a");
    await storeLinkPreviewCache(db.prisma, {
      spaceId: "space-1",
      keyHash: key,
      entry: ok(),
      now: NOW,
    });

    expect(await findCachedLinkPreview(db.prisma, "space-1", key, at(1000))).toMatchObject({
      kind: "page",
      title: "A page",
    });
    expect(
      await findCachedLinkPreview(db.prisma, "space-1", key, at(LINK_PREVIEW_CACHE_TTL_MS)),
    ).toBeNull();
    expect(await findCachedLinkPreview(db.prisma, "space-2", key, at(1000))).toBeNull();
  });

  it("reads every row written before reads were facts as a miss", async () => {
    const db = createFakeThreadDb();
    const row = (
      keyHash: string,
      format: string,
      article: boolean | null,
      status = "ok",
      source = "server",
    ) => {
      db.tables.linkPreviewCache.set(keyHash, {
        id: keyHash,
        spaceId: "space-1",
        keyHash,
        status,
        format,
        title: "Old",
        imageKey: null,
        imageWidth: null,
        imageHeight: null,
        imageBytes: 0,
        imageFit: null,
        article,
        source,
        expiresAt: at(1000),
      });
    };
    row("old-page", "compact", null);
    row("old-large", "large", null);
    row("old-photo", "photo", null);
    row("article", "compact", true);
    row("old-failed", "compact", null, "failed", "restricted");
    row("old-device", "compact", null, "ok", "device");
    const read = (key: string) => findCachedLinkPreview(db.prisma, "space-1", key, NOW);
    for (const key of [
      "old-page",
      "old-large",
      "old-photo",
      "article",
      "old-failed",
      "old-device",
    ]) {
      expect(await read(key), key).toBeNull();
    }
  });

  it("keeps what a read learned: a photo, a page, an article reached on another site, a refusal, a failure", async () => {
    const db = createFakeThreadDb();
    const icon = { key: "icon", bytes: 3 };
    const entries = {
      photo: { kind: "photo", image: { key: "p", width: 40, height: 30, bytes: 5 } },
      page: { kind: "page", article: false, title: "Doc", icon },
      crossSite: {
        kind: "page",
        article: true,
        title: "Story",
        crossSite: true,
        image: { key: "i", width: 180, height: 180, bytes: 4, fit: "contain" },
        icon,
      },
      refused: { kind: "refused", icon },
      bare: { kind: "refused" },
      failure: { kind: "unreadable" },
    } as const;
    for (const [keyHash, entry] of Object.entries(entries)) {
      await storeLinkPreviewCache(db.prisma, { spaceId: "space-1", keyHash, entry, now: NOW });
    }
    for (const [keyHash, entry] of Object.entries(entries)) {
      expect(await findCachedLinkPreview(db.prisma, "space-1", keyHash, NOW), keyHash).toEqual({
        ...entry,
        source: "server",
      });
    }
  });

  it("remembers where an entry came from: the server or the device", async () => {
    const db = createFakeThreadDb();
    const read = async (key: string) => findCachedLinkPreview(db.prisma, "space-1", key, NOW);
    await storeLinkPreviewCache(db.prisma, {
      spaceId: "space-1",
      keyHash: "plain",
      entry: ok({ title: "T" }),
      now: NOW,
    });
    await storeLinkPreviewCache(db.prisma, {
      spaceId: "space-1",
      keyHash: "device",
      entry: ok({ title: "T", source: "device" }),
      now: NOW,
    });
    expect(await read("plain")).toMatchObject({ kind: "page", source: "server" });
    expect(await read("device")).toMatchObject({ kind: "page", source: "device" });
  });

  it("remembers that an image is a site icon, and only then", async () => {
    const db = createFakeThreadDb();
    const image = { key: "blob", width: 180, height: 180, bytes: 10 };
    await storeLinkPreviewCache(db.prisma, {
      spaceId: "space-1",
      keyHash: "icon",
      entry: ok({ image: { ...image, fit: "contain" } }),
      now: NOW,
    });
    await storeLinkPreviewCache(db.prisma, {
      spaceId: "space-1",
      keyHash: "page",
      entry: ok({ image }),
      now: NOW,
    });
    const icon = await findCachedLinkPreview(db.prisma, "space-1", "icon", NOW);
    const page = await findCachedLinkPreview(db.prisma, "space-1", "page", NOW);
    expect(icon).toMatchObject({ image: { fit: "contain" } });
    expect(page).not.toHaveProperty("image.fit");
  });

  it("hands back the image and icon of an entry it replaced, for deletion", async () => {
    const db = createFakeThreadDb();
    const image = (key: string) => ({ key, width: 600, height: 400, bytes: 10 });
    const icon = { key: "icon", bytes: 3 };
    const store = (entry: object, ms: number) =>
      storeLinkPreviewCache(db.prisma, {
        spaceId: "space-1",
        keyHash: "k",
        entry: entry as never,
        now: at(ms),
      });
    await store(ok({ image: image("old"), icon }), 0);
    expect((await store(ok({ image: image("new"), icon }), 5)).removedImageKeys).toEqual(["old"]);
    expect((await store({ kind: "unreadable" }, 10)).removedImageKeys).toEqual(["new", "icon"]);
    expect(db.tables.linkPreviewCache.size).toBe(1);
  });

  it("stays under 500 entries for a space after 1 500 distinct links (CA 43)", async () => {
    const db = createFakeThreadDb();
    const evicted: string[] = [];
    for (let index = 0; index < 1_500; index += 1) {
      const { removedImageKeys } = await storeLinkPreviewCache(db.prisma, {
        spaceId: "space-1",
        keyHash: linkPreviewKeyHash("space-1", `https://example.test/${index}`),
        entry: ok({ image: { key: `blob-${index}`, width: 600, height: 400, bytes: 1000 } }),
        now: at(index),
      });
      evicted.push(...removedImageKeys);
    }
    expect(db.tables.linkPreviewCache.size).toBe(LINK_PREVIEW_CACHE_MAX_ENTRIES);
    // Oldest out: what is left is the last 500, and every other image was handed back.
    const kept = new Set([...db.tables.linkPreviewCache.values()].map((row) => row.imageKey));
    expect(kept.has("blob-1499")).toBe(true);
    expect(kept.has("blob-0")).toBe(false);
    expect(evicted).toHaveLength(1_500 - LINK_PREVIEW_CACHE_MAX_ENTRIES);
  });

  it("stays under 100 MB of images, and one space never evicts another's", async () => {
    const db = createFakeThreadDb();
    const heavy = 3 * 1024 * 1024;
    await storeLinkPreviewCache(db.prisma, {
      spaceId: "space-2",
      keyHash: "theirs",
      entry: ok({ image: { key: "theirs", width: 1, height: 1, bytes: heavy } }),
      now: NOW,
    });
    for (let index = 0; index < 50; index += 1) {
      await storeLinkPreviewCache(db.prisma, {
        spaceId: "space-1",
        keyHash: `k${index}`,
        entry: ok({ image: { key: `blob-${index}`, width: 1, height: 1, bytes: heavy } }),
        now: at(index),
      });
    }
    const mine = [...db.tables.linkPreviewCache.values()].filter(
      (row) => row.spaceId === "space-1",
    );
    const total = mine.reduce((sum, row) => sum + (row.imageBytes as number), 0);
    expect(total).toBeLessThanOrEqual(LINK_PREVIEW_CACHE_MAX_BYTES);
    expect(mine.length).toBe(Math.floor(LINK_PREVIEW_CACHE_MAX_BYTES / heavy));
    expect([...db.tables.linkPreviewCache.values()].some((row) => row.keyHash === "theirs")).toBe(
      true,
    );
  });

  it("counts icons toward the 100 MB, and hands back the icons it evicts", async () => {
    const db = createFakeThreadDb();
    const heavy = 3 * 1024 * 1024;
    const evicted: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      const { removedImageKeys } = await storeLinkPreviewCache(db.prisma, {
        spaceId: "space-1",
        keyHash: `k${index}`,
        entry: { kind: "refused", icon: { key: `icon-${index}`, bytes: heavy } },
        now: at(index),
      });
      evicted.push(...removedImageKeys);
    }
    const kept = Math.floor(LINK_PREVIEW_CACHE_MAX_BYTES / heavy);
    expect(db.tables.linkPreviewCache.size).toBe(kept);
    expect(evicted).toEqual(Array.from({ length: 50 - kept }, (_, index) => `icon-${index}`));
  });

  it("purges expired rows and spent read counters, returning the images to delete", async () => {
    const db = createFakeThreadDb();
    await storeLinkPreviewCache(db.prisma, {
      spaceId: "space-1",
      keyHash: "old",
      entry: ok({
        image: { key: "blob-old", width: 1, height: 1, bytes: 5 },
        icon: { key: "icon-old", bytes: 2 },
      }),
      now: NOW,
    });
    await storeLinkPreviewCache(db.prisma, {
      spaceId: "space-1",
      keyHash: "fresh",
      entry: ok(),
      now: at(LINK_PREVIEW_CACHE_TTL_MS),
    });
    db.tables.linkPreviewRead.set("r-old", {
      id: "r-old",
      spaceId: "space-1",
      source: "job",
      createdAt: NOW,
    });

    const purged = await purgeLinkPreviewState(db.prisma, at(LINK_PREVIEW_CACHE_TTL_MS + 1000));

    expect(purged.removedImages).toEqual([
      { spaceId: "space-1", key: "blob-old" },
      { spaceId: "space-1", key: "icon-old" },
    ]);
    expect([...db.tables.linkPreviewCache.values()].map((row) => row.keyHash)).toEqual(["fresh"]);
    expect(db.tables.linkPreviewRead.size).toBe(0);
  });

  it("keeps a row refreshed between the purge's read and its delete, and its keys", async () => {
    const db = createFakeThreadDb();
    for (const keyHash of ["stale", "refreshed"]) {
      await storeLinkPreviewCache(db.prisma, {
        spaceId: "space-1",
        keyHash,
        entry: ok({ image: { key: `blob-${keyHash}`, width: 1, height: 1, bytes: 5 } }),
        now: NOW,
      });
    }
    const racing = {
      $transaction: <T>(fn: (tx: never) => Promise<T>) =>
        db.prisma.$transaction((tx: never) =>
          fn({
            ...(tx as object),
            linkPreviewCache: {
              ...(tx as { linkPreviewCache: object }).linkPreviewCache,
              findMany: async (args: never) => {
                const rows = await (
                  tx as { linkPreviewCache: { findMany: (a: never) => Promise<unknown[]> } }
                ).linkPreviewCache.findMany(args);
                // A refresh commits after the read, before the delete.
                for (const row of db.tables.linkPreviewCache.values()) {
                  if (row.keyHash === "refreshed")
                    row.expiresAt = at(LINK_PREVIEW_CACHE_TTL_MS * 3);
                }
                return rows;
              },
            },
          } as never),
        ),
    };

    const purged = await purgeLinkPreviewState(
      racing as never,
      at(LINK_PREVIEW_CACHE_TTL_MS + 1000),
    );

    expect(purged.removedImages).toEqual([{ spaceId: "space-1", key: "blob-stale" }]);
    expect([...db.tables.linkPreviewCache.values()].map((row) => row.keyHash)).toEqual([
      "refreshed",
    ]);
  });

  it("purges at most once per interval, bytes included", async () => {
    const db = createFakeThreadDb();
    const entry = ok({ image: { key: "", width: 1, height: 1, bytes: 5 } });
    const stored = await db.artifacts.put(
      { name: "x", mimeType: "image/webp", bytes: new Uint8Array(5) },
      {
        operationId: "t",
        traceId: "t",
        spaceId: "space-1",
        userId: "u",
        signal: new AbortController().signal,
      },
    );
    entry.image.key = stored.id;
    await storeLinkPreviewCache(db.prisma, { spaceId: "space-1", keyHash: "old", entry, now: NOW });
    let now = at(LINK_PREVIEW_CACHE_TTL_MS + 1000);
    const purge = createLinkPreviewPurge(
      { prisma: db.prisma, artifacts: db.artifacts },
      { now: () => now },
    );

    await purge();
    expect(db.tables.linkPreviewCache.size).toBe(0);
    expect(db.artifacts.keys()).toEqual([]);

    db.tables.linkPreviewRead.set("r", {
      id: "r",
      spaceId: "space-1",
      source: "job",
      createdAt: NOW,
    });
    now = at(LINK_PREVIEW_CACHE_TTL_MS + 2000);
    await purge();
    expect(db.tables.linkPreviewRead.size).toBe(1);
  });
});

describe("read budget (CA 22, CA 55)", () => {
  async function reads(db: ReturnType<typeof createFakeThreadDb>, count: number, input: object) {
    const results: boolean[] = [];
    for (let index = 0; index < count; index += 1) {
      results.push(
        await reserveLinkPreviewRead(db.prisma, {
          spaceId: "space-1",
          source: "job",
          now: at(index),
          ...input,
        }),
      );
    }
    return results;
  }

  it("allows 30 reads a minute per space, then refuses until the minute is over", async () => {
    const db = createFakeThreadDb();
    const results = await reads(db, 31, {});
    expect(results.filter(Boolean)).toHaveLength(30);
    expect(results[30]).toBe(false);
    expect(
      await reserveLinkPreviewRead(db.prisma, {
        spaceId: "space-1",
        source: "job",
        now: at(61_000),
      }),
    ).toBe(true);
    expect(
      await reserveLinkPreviewRead(db.prisma, { spaceId: "space-2", source: "job", now: NOW }),
    ).toBe(true);
  });

  it("allows a person 10 composer reads a minute, leaving the rest of the space to the bots", async () => {
    const db = createFakeThreadDb();
    const results = await reads(db, 12, { source: "composer", userId: "user-1" });
    expect(results.filter(Boolean)).toHaveLength(LINK_PREVIEW_ACTOR_READS_PER_MINUTE);
    // Another person, and the background job, still read.
    expect(
      await reserveLinkPreviewRead(db.prisma, {
        spaceId: "space-1",
        source: "composer",
        userId: "user-2",
        now: at(20),
      }),
    ).toBe(true);
    expect(
      await reserveLinkPreviewRead(db.prisma, { spaceId: "space-1", source: "job", now: at(21) }),
    ).toBe(true);
  });

  it("locks the person as well as the space for a composer read, space first", async () => {
    const db = createFakeThreadDb();
    const locks: unknown[] = [];
    const prisma = {
      $transaction: (work: (tx: unknown) => Promise<unknown>) =>
        db.prisma.$transaction((tx: Record<string, unknown>) =>
          work({
            ...tx,
            $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
              locks.push(...values);
              return 0;
            },
          }),
        ),
    } as unknown as Parameters<typeof reserveLinkPreviewRead>[0];

    await reserveLinkPreviewRead(prisma, {
      spaceId: "space-1",
      source: "composer",
      userId: "user-1",
      now: NOW,
    });
    await reserveLinkPreviewRead(prisma, { spaceId: "space-2", source: "job", now: NOW });

    expect(locks).toEqual([
      "link-preview-reads:space-1",
      "link-preview-reads:user:user-1",
      "link-preview-reads:space-2",
    ]);
  });

  it("counts a composer read against the space too", async () => {
    const db = createFakeThreadDb();
    for (let index = 0; index < 30; index += 1) {
      await reserveLinkPreviewRead(db.prisma, {
        spaceId: "space-1",
        source: "composer",
        userId: `user-${index}`,
        now: at(index),
      });
    }
    expect(
      await reserveLinkPreviewRead(db.prisma, { spaceId: "space-1", source: "job", now: at(40) }),
    ).toBe(false);
  });
});

describe("a message's preview in the log", () => {
  let db: ThreadDb;
  beforeAll(async () => {
    db = await openThreadDb();
  }, 60_000);
  beforeEach(() => db.reset());
  afterAll(() => db.close());

  const scope = { spaceId: "space-1", threadId: "thread-1", messageId: "m1" };
  const url = "https://example.test/a";
  const text = { kind: "text" as const, text: url };
  /** The bot and run the thread's feed showed the newest entry under. */
  const lastFeed = async () => {
    const event = await db.prisma.event.findFirstOrThrow({
      where: { threadId: "thread-1", type: "session.entry.appended" },
      orderBy: { seq: "desc" },
    });
    return { botId: event.botId, runId: event.runId };
  };

  describe("reaches the feed under the message's own bot (QA F1)", () => {
    it("shows a card on a group bot's reply, and its removal, under that bot and no run", async () => {
      await db.seedThread({
        id: "thread-1",
        group: { id: "group-1", memberBotIds: ["bot-a", "bot-b"] },
      });
      await db.seedRun({
        id: "run-1",
        threadId: "thread-1",
        botId: "bot-b",
        messages: [{ id: "m1", blocks: [text] }],
      });

      await appendLinkBlocks(db.prisma, {
        ...scope,
        blocks: [{ kind: "link_preview", url, format: "compact", title: "A page" }],
      });
      expect(await lastFeed()).toEqual({ botId: "bot-b", runId: null });

      await removeLinkPreviewBlock(db.prisma, scope);
      expect(await lastFeed()).toEqual({ botId: "bot-b", runId: null });
    });

    it("falls back to the thread's bot for a message that names none", async () => {
      await db.seedThread({ id: "thread-1" });
      await db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text] });

      await appendLinkBlocks(db.prisma, {
        ...scope,
        blocks: [{ kind: "link_preview", url, format: "compact", title: "A page" }],
      });

      expect(await lastFeed()).toEqual({ botId: "bot-1", runId: null });
    });
  });

  it("adds one card to a message, and none to a message of another thread", async () => {
    const card = { kind: "link_preview" as const, url, format: "compact" as const, title: "A" };
    await db.seedThread({ id: "thread-1" });
    await db.seedThread({ id: "thread-2", botId: "bot-2" });
    await db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text] });
    await db.seedMessage({ id: "m2", threadId: "thread-2", blocks: [text] });

    const outcomes = [
      await appendLinkBlocks(db.prisma, { ...scope, blocks: [card] }),
      await appendLinkBlocks(db.prisma, { ...scope, blocks: [card] }),
      await appendLinkBlocks(db.prisma, { ...scope, messageId: "m2", blocks: [card] }),
      await removeLinkPreviewBlock(db.prisma, { ...scope, messageId: "m2" }),
    ];

    expect(outcomes.map((result) => result.outcome)).toEqual([
      "appended",
      "present",
      "gone",
      "gone",
    ]);
    expect(await db.previewOf("m2")).toEqual({ removed: false });
  });

  it("adds no card to a message a rewind cut before the preview arrived", async () => {
    await db.seedThread({ id: "thread-1" });
    await db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text] });
    await rewindThread(db.prisma, { ...scope, botId: "bot-1" });

    const appended = await appendLinkBlocks(db.prisma, {
      ...scope,
      blocks: [{ kind: "link_preview", url, format: "compact", title: "A page" }],
    });

    expect(appended).toEqual({ outcome: "gone" });
    expect(await db.previewOf("m1")).toEqual({ removed: false });
  });

  describe("removal and card images (CA 16, CA 44)", () => {
    async function previewArtifact(id: string, storageKey: string, createdAt = NOW) {
      await db.prisma.artifact.create({
        data: {
          id,
          isLinkPreview: true,
          previewMessageId: "m1",
          storageKey,
          spaceId: "space-1",
          userId: "user-1",
          botId: "bot-1",
          name: "link-preview.webp",
          mimeType: "image/webp",
          size: 3,
          hash: "h",
          createdAt,
        },
      });
    }

    async function withCard() {
      await db.seedThread({ id: "thread-1" });
      await db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text] });
      await previewArtifact("a1", "blob-1");
      await appendLinkBlocks(db.prisma, {
        ...scope,
        blocks: [
          {
            kind: "link_preview",
            url,
            format: "photo",
            image: { artifactId: "a1", width: 1, height: 1 },
          },
        ],
      });
    }

    it("removes the card, deletes the image row and returns its bytes", async () => {
      await withCard();

      const removed = await removeLinkPreviewBlock(db.prisma, scope);

      expect(removed).toMatchObject({
        outcome: "removed",
        artifacts: [{ id: "a1", storageKey: "blob-1" }],
      });
      expect(await db.previewOf("m1")).toEqual({ removed: true });
      expect(await db.prisma.artifact.count()).toBe(0);
    });

    it("is idempotent: the second call writes nothing", async () => {
      await withCard();
      await removeLinkPreviewBlock(db.prisma, scope);

      await expect(removeLinkPreviewBlock(db.prisma, scope)).resolves.toEqual({
        outcome: "unchanged",
      });

      expect(await db.prisma.sessionEntry.count({ where: { type: "link.preview.removed" } })).toBe(
        1,
      );
    });

    it("marks a message that has no card yet, so a read in flight cannot add one", async () => {
      await db.seedThread({ id: "thread-1" });
      await db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text] });

      await removeLinkPreviewBlock(db.prisma, scope);

      expect(await db.previewOf("m1")).toEqual({ removed: true });
      await expect(
        appendLinkBlocks(db.prisma, {
          ...scope,
          blocks: [{ kind: "link_preview", url, format: "compact", title: "A page" }],
        }),
      ).resolves.toEqual({ outcome: "present" });
    });

    const mention = (path: string, artifactId?: string) => ({
      kind: "link_mention" as const,
      url: `https://docs.test/${path}`,
      title: path,
      ...(artifactId ? { icon: { artifactId } } : {}),
    });

    /** The kind and URL of each block every feed event since `from` carries, event by event. */
    const feedSince = async (from: number) =>
      (
        await db.prisma.event.findMany({
          where: { type: "session.entry.appended", seq: { gt: from } },
          orderBy: { seq: "asc" },
        })
      ).map((event) => (event.payload as { entries: unknown[] }).entries);
    const blocksOf = (entries: unknown[]) =>
      (entries as Array<{ payload: { block: { kind: string; url: string } } }>).map(
        ({ payload: { block } }) => `${block.kind} ${block.url}`,
      );
    const lastSeq = async () =>
      (await db.prisma.thread.findUniqueOrThrow({ where: { id: "thread-1" } })).nextEventSeq - 1;

    it("writes the card, then the mentions, in one transaction and two feed events, and a rerun adds only what is missing (CA 22)", async () => {
      await db.seedThread({ id: "thread-1" });
      await db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text] });
      const card = { kind: "link_preview" as const, url, format: "compact" as const, title: "A" };
      const from = await lastSeq();
      const transactions = vi.spyOn(db.prisma, "$transaction");

      const first = await appendLinkBlocks(db.prisma, {
        ...scope,
        blocks: [mention("a"), card, mention("b#top"), mention("b")],
      });

      expect(transactions).toHaveBeenCalledTimes(1);
      transactions.mockRestore();
      expect(first).toMatchObject({ outcome: "appended", seq: from + 2, artifactIds: [] });
      expect((await feedSince(from)).map(blocksOf)).toEqual([
        [`link_preview ${url}`],
        ["link_mention https://docs.test/a", "link_mention https://docs.test/b#top"],
      ]);

      const rerun = await appendLinkBlocks(db.prisma, {
        ...scope,
        blocks: [{ ...card, title: "B" }, mention("a"), mention("c", "a2")],
      });
      expect(rerun).toMatchObject({ outcome: "appended", seq: from + 3, artifactIds: ["a2"] });
      expect((await feedSince(from + 2)).map(blocksOf)).toEqual([
        ["link_mention https://docs.test/c"],
      ]);
      expect((await db.mentionsOf("m1")).map((block) => block.url)).toEqual([
        "https://docs.test/a",
        "https://docs.test/b#top",
        "https://docs.test/c",
      ]);
      expect((await db.previewOf("m1")).card?.title).toBe("A");
    });

    it("keeps the card live on a client released before mentions, which drops a whole event holding one (CA 22)", async () => {
      await db.seedThread({ id: "thread-1" });
      await db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text] });
      const card = { kind: "link_preview" as const, url, format: "compact" as const, title: "A" };
      const from = await lastSeq();
      // That client's `link.preview` entry holds a card and nothing else.
      const oldClient = ThreadEntrySchema.refine(
        (entry) => entry.type !== "link.preview" || entry.payload.block.kind === "link_preview",
      ).array();

      await appendLinkBlocks(db.prisma, { ...scope, blocks: [card, mention("a")] });

      const events = await feedSince(from);
      const kept = events.flatMap((entries) => oldClient.safeParse(entries).data ?? []);
      expect(kept.map((entry) => entry.type === "link.preview" && entry.payload.block)).toEqual([
        card,
      ]);
      expect(oldClient.safeParse(events.flat()).success).toBe(false);
    });

    it("keeps the mentions and their icons when the card is removed (CA 12)", async () => {
      await withCard();
      await previewArtifact("a2", "blob-2");
      await appendLinkBlocks(db.prisma, { ...scope, blocks: [mention("a", "a2")] });

      const removed = await removeLinkPreviewBlock(db.prisma, scope);

      expect(removed).toMatchObject({ artifacts: [{ id: "a1", storageKey: "blob-1" }] });
      expect(await db.previewOf("m1")).toEqual({ removed: true });
      expect(await db.mentionsOf("m1")).toEqual([mention("a", "a2")]);
      expect((await db.prisma.artifact.findMany()).map((row) => row.id)).toEqual(["a2"]);
      expect(await findOrphanPreviewArtifacts(db.prisma, { now: at(61 * 60_000) })).toEqual([]);
    });

    it("gives a message sent with its preview off neither card nor mention", async () => {
      await db.seedThread({ id: "thread-1" });
      const optOut = { kind: "link_preview" as const, removed: true as const };
      await db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text, optOut] });

      const card = { kind: "link_preview" as const, url, format: "compact" as const, title: "A" };
      await expect(
        appendLinkBlocks(db.prisma, { ...scope, blocks: [card, mention("a")] }),
      ).resolves.toEqual({ outcome: "present" });
      expect(await db.mentionsOf("m1")).toEqual([]);
    });

    it("stays coherent when two writers and a removal race (CA 12)", async () => {
      await db.seedThread({ id: "thread-1" });
      await db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text] });
      const card = { kind: "link_preview" as const, url, format: "compact" as const, title: "A" };

      await Promise.all([
        appendLinkBlocks(db.prisma, { ...scope, blocks: [card, mention("a")] }),
        appendLinkBlocks(db.prisma, { ...scope, blocks: [mention("a"), mention("b")] }),
        removeLinkPreviewBlock(db.prisma, scope),
      ]);

      // Whichever ran first, the card is gone or never came, and each mention is there once.
      expect(await db.previewOf("m1")).toEqual({ removed: true });
      expect((await db.mentionsOf("m1")).map((block) => block.url).sort()).toEqual([
        "https://docs.test/a",
        "https://docs.test/b",
      ]);
    });

    it("finds the card images left behind when a thread goes, and sweeps rows and bytes", async () => {
      await withCard();
      const { id: stored } = await db.artifacts.put(
        { name: "p", mimeType: "image/webp", bytes: new Uint8Array(3) },
        {
          operationId: "t",
          traceId: "t",
          spaceId: "space-1",
          userId: "user-1",
          signal: new AbortController().signal,
        },
      );
      await db.prisma.artifact.update({ where: { id: "a1" }, data: { storageKey: stored } });
      // A file a person attached must never be swept.
      await db.prisma.artifact.create({
        data: {
          id: "file",
          isLinkPreview: false,
          storageKey: "keep",
          spaceId: "space-1",
          userId: "user-1",
          botId: "bot-1",
          name: "notes.txt",
          mimeType: "text/plain",
          size: 1,
          hash: "h",
        },
      });
      expect(await findOrphanPreviewArtifacts(db.prisma, { now: NOW })).toEqual([]);

      // The thread is deleted: its entries go, the foreign key nulls the artifact's message.
      await db.prisma.thread.delete({ where: { id: "thread-1" } });
      expect(
        (await findOrphanPreviewArtifacts(db.prisma, { now: NOW })).map((row) => row.id),
      ).toEqual(["a1"]);
      expect(await findOrphanPreviewArtifacts(db.prisma, { spaceId: "space-2", now: NOW })).toEqual(
        [],
      );

      await expect(
        sweepOrphanPreviewArtifacts({ prisma: db.prisma, artifacts: db.artifacts }, { now: NOW }),
      ).resolves.toBe(1);
      expect((await db.prisma.artifact.findMany()).map((row) => row.id)).toEqual(["file"]);
      expect(db.artifacts.keys()).toEqual([]);
    });

    it("sweeps an image whose message never got its card, after a grace hour", async () => {
      await db.seedThread({ id: "thread-1" });
      await db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text] });
      await previewArtifact("lost", "blob");

      expect(await findOrphanPreviewArtifacts(db.prisma, { now: at(30 * 60_000) })).toEqual([]);
      expect(
        (await findOrphanPreviewArtifacts(db.prisma, { now: at(61 * 60_000) })).map(
          (row) => row.id,
        ),
      ).toEqual(["lost"]);
      // Once the card is there, it is no orphan.
      await appendLinkBlocks(db.prisma, {
        ...scope,
        blocks: [
          {
            kind: "link_preview",
            url,
            format: "photo",
            image: { artifactId: "lost", width: 1, height: 1 },
          },
        ],
      });
      expect(await findOrphanPreviewArtifacts(db.prisma, { now: at(61 * 60_000) })).toEqual([]);
    });
  });
});
