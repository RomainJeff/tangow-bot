import { createLinkPreviewPurge, sweepOrphanPreviewArtifacts } from "@rakazo/adapters";
import {
  appendLinkPreviewBlock,
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
  storeLinkPreviewCache,
} from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { createFakeThreadDb } from "./fake-thread-db.js";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const ok = (extra: Record<string, unknown> = {}) => ({
  status: "ok" as const,
  format: "compact" as const,
  title: "A page",
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
      status: "ok",
      title: "A page",
    });
    expect(
      await findCachedLinkPreview(db.prisma, "space-1", key, at(LINK_PREVIEW_CACHE_TTL_MS)),
    ).toBeNull();
    expect(await findCachedLinkPreview(db.prisma, "space-2", key, at(1000))).toBeNull();
  });

  it("keeps a definitive failure as a bare failed entry", async () => {
    const db = createFakeThreadDb();
    await storeLinkPreviewCache(db.prisma, {
      spaceId: "space-1",
      keyHash: "k",
      entry: { status: "failed" },
      now: NOW,
    });
    expect(await findCachedLinkPreview(db.prisma, "space-1", "k", NOW)).toEqual({
      status: "failed",
    });
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

  it("hands back the image of an entry it replaced, for deletion", async () => {
    const db = createFakeThreadDb();
    const image = (key: string) => ({ key, width: 600, height: 400, bytes: 10 });
    await storeLinkPreviewCache(db.prisma, {
      spaceId: "space-1",
      keyHash: "k",
      entry: ok({ image: image("old") }),
      now: NOW,
    });
    const replaced = await storeLinkPreviewCache(db.prisma, {
      spaceId: "space-1",
      keyHash: "k",
      entry: ok({ image: image("new") }),
      now: at(5),
    });
    expect(replaced.removedImageKeys).toEqual(["old"]);
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

  it("purges expired rows and spent read counters, returning the images to delete", async () => {
    const db = createFakeThreadDb();
    await storeLinkPreviewCache(db.prisma, {
      spaceId: "space-1",
      keyHash: "old",
      entry: ok({ image: { key: "blob-old", width: 1, height: 1, bytes: 5 } }),
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

    expect(purged.removedImages).toEqual([{ spaceId: "space-1", key: "blob-old" }]);
    expect([...db.tables.linkPreviewCache.values()].map((row) => row.keyHash)).toEqual(["fresh"]);
    expect(db.tables.linkPreviewRead.size).toBe(0);
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

describe("the live update keeps the message's identity (QA F1)", () => {
  const scope = { spaceId: "space-1", threadId: "thread-1", messageId: "m2" };
  const url = "https://example.test/a";

  function groupThread() {
    const db = createFakeThreadDb();
    db.seedThread({ id: "thread-1" });
    db.tables.threads.get("thread-1")!.botId = null;
    db.tables.threads.get("thread-1")!.groupId = "group-1";
    db.tables.chatGroupMembers.set("gm1", {
      id: "gm1",
      groupId: "group-1",
      botId: "bot-a",
      createdAt: new Date(0),
    });
    db.seedMessage({
      id: "m2",
      threadId: "thread-1",
      role: "bot",
      botId: "bot-b",
      runId: "run-1",
      replyToMessageId: "m1",
      replyQuote: "the quoted words",
      blocks: [{ kind: "text", text: url }],
    });
    return db;
  }

  it("attributes a card on a group bot's reply to that bot and carries the reply quote", async () => {
    const db = groupThread();

    await appendLinkPreviewBlock(db.prisma, {
      ...scope,
      block: { kind: "link_preview", url, format: "compact", title: "A page" },
    });

    const [event] = db.eventsOfType("thread.message.updated");
    expect(event?.botId).toBe("bot-b");
    expect(event?.runId).toBeUndefined();
    expect(event?.payload).toMatchObject({
      messageId: "m2",
      role: "bot",
      replyToMessageId: "m1",
      replyQuote: "the quoted words",
    });
  });

  it("does the same when the card is removed", async () => {
    const db = groupThread();

    await removeLinkPreviewBlock(db.prisma, scope);

    const [event] = db.eventsOfType("thread.message.updated");
    expect(event?.botId).toBe("bot-b");
    expect(event?.payload).toMatchObject({
      replyToMessageId: "m1",
      replyQuote: "the quoted words",
    });
  });

  it("falls back to the thread's bot for a message that names none, and omits absent reply fields", async () => {
    const db = createFakeThreadDb();
    db.seedThread({ id: "thread-1" });
    db.seedMessage({ id: "m2", threadId: "thread-1", blocks: [{ kind: "text", text: url }] });

    await appendLinkPreviewBlock(db.prisma, {
      ...scope,
      block: { kind: "link_preview", url, format: "compact", title: "A page" },
    });

    const [event] = db.eventsOfType("thread.message.updated");
    expect(event?.botId).toBe("bot-1");
    expect(Object.keys(event?.payload as object).sort()).toEqual(["blocks", "messageId", "role"]);
  });
});

describe("removal and card images (CA 16, CA 44)", () => {
  const scope = { spaceId: "space-1", threadId: "thread-1", messageId: "m1" };

  function withCard() {
    const db = createFakeThreadDb();
    db.seedThread({ id: "thread-1" });
    db.seedMessage({
      id: "m1",
      threadId: "thread-1",
      blocks: [
        { kind: "text", text: "https://example.test/a" },
        {
          kind: "link_preview",
          url: "https://example.test/a",
          format: "photo",
          image: { artifactId: "a1", width: 1, height: 1 },
        },
        { kind: "from_the_future" },
      ],
    });
    db.tables.artifact.set("a1", {
      id: "a1",
      isLinkPreview: true,
      previewMessageId: "m1",
      storageKey: "blob-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      createdAt: NOW,
    });
    return db;
  }

  it("swaps the card for the marker in place, deletes the image row and returns its bytes", async () => {
    const db = withCard();

    const removed = await removeLinkPreviewBlock(db.prisma, scope);

    expect(removed).toMatchObject({
      outcome: "removed",
      artifacts: [{ id: "a1", storageKey: "blob-1" }],
    });
    expect(db.blocksOf("m1")).toEqual([
      { kind: "text", text: "https://example.test/a" },
      { kind: "link_preview", removed: true },
      { kind: "from_the_future" },
    ]);
    expect(db.tables.artifact.size).toBe(0);
    expect(db.eventsOfType("thread.message.updated")).toHaveLength(1);
  });

  it("is idempotent: the second call changes nothing and emits nothing", async () => {
    const db = withCard();
    await removeLinkPreviewBlock(db.prisma, scope);
    const before = structuredClone(db.blocksOf("m1"));

    await expect(removeLinkPreviewBlock(db.prisma, scope)).resolves.toEqual({
      outcome: "unchanged",
    });

    expect(db.blocksOf("m1")).toEqual(before);
    expect(db.eventsOfType("thread.message.updated")).toHaveLength(1);
  });

  it("puts a marker on a message that has no card yet, so a read in flight cannot add one", async () => {
    const db = createFakeThreadDb();
    db.seedThread({ id: "thread-1" });
    db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [{ kind: "text", text: "x" }] });

    await removeLinkPreviewBlock(db.prisma, scope);

    expect(db.blocksOf("m1")).toEqual([
      { kind: "text", text: "x" },
      { kind: "link_preview", removed: true },
    ]);
  });

  it("finds the card images left behind when a message disappears, and sweeps rows and bytes", async () => {
    const db = withCard();
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
    db.tables.artifact.get("a1")!.storageKey = stored;
    // A file a person attached must never be swept.
    db.tables.artifact.set("file", {
      id: "file",
      isLinkPreview: false,
      previewMessageId: null,
      storageKey: "keep",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      createdAt: NOW,
    });
    expect(await findOrphanPreviewArtifacts(db.prisma, { now: NOW })).toEqual([]);

    // Thread cleared or rewound: the message goes, the foreign key nulls the artifact's message.
    await db.prisma.message.deleteMany({ where: { threadId: "thread-1" } });
    expect(
      (await findOrphanPreviewArtifacts(db.prisma, { now: NOW })).map((row) => row.id),
    ).toEqual(["a1"]);
    expect(await findOrphanPreviewArtifacts(db.prisma, { spaceId: "space-2", now: NOW })).toEqual(
      [],
    );

    await expect(
      sweepOrphanPreviewArtifacts({ prisma: db.prisma, artifacts: db.artifacts }, { now: NOW }),
    ).resolves.toBe(1);
    expect([...db.tables.artifact.keys()]).toEqual(["file"]);
    expect(db.artifacts.keys()).toEqual([]);
  });

  it("sweeps an image whose message never got its card, after a grace hour", async () => {
    const db = createFakeThreadDb();
    db.seedThread({ id: "thread-1" });
    db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [{ kind: "text", text: "x" }] });
    db.tables.artifact.set("lost", {
      id: "lost",
      isLinkPreview: true,
      previewMessageId: "m1",
      storageKey: "blob",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      createdAt: NOW,
    });
    // The artifact's message is read through the relation in Postgres; the fake needs it spelled.
    const prisma = {
      artifact: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          const rows = await db.prisma.artifact.findMany(args as never);
          return (rows as Array<Record<string, unknown>>).map((row) => ({
            ...row,
            previewMessage: { blocks: db.blocksOf(row.previewMessageId as string) },
          }));
        },
      },
    };

    expect(await findOrphanPreviewArtifacts(prisma as never, { now: at(30 * 60_000) })).toEqual([]);
    expect(
      (await findOrphanPreviewArtifacts(prisma as never, { now: at(61 * 60_000) })).map(
        (row) => row.id,
      ),
    ).toEqual(["lost"]);
    // Once the card is there, it is no orphan.
    db.tables.messages.get("m1")!.blocks = [
      { kind: "link_preview", image: { artifactId: "lost" } },
    ];
    expect(await findOrphanPreviewArtifacts(prisma as never, { now: at(61 * 60_000) })).toEqual([]);
  });
});
