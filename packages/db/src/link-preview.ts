import { createHash } from "node:crypto";
import type { LinkMentionBlock, LinkPreviewCard } from "@rakazo/contracts";
import { EntryId } from "@rakazo/contracts";
import { linkKey } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import {
  appendCardStateInTransaction,
  blocksOf,
  ENTRY_ON_CHAIN,
  endThreadFeedEvent,
  threadEventSeq,
} from "./sessions.js";

export const LINK_PREVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const LINK_PREVIEW_CACHE_MAX_ENTRIES = 500;
export const LINK_PREVIEW_CACHE_MAX_BYTES = 100 * 1024 * 1024;
/** Real page reads (cache misses) one space may start per minute, across the API and the worker. */
export const LINK_PREVIEW_SPACE_READS_PER_MINUTE = 30;
/** Composer reads one person may start per minute: a person pasting links must not starve the bots. */
export const LINK_PREVIEW_ACTOR_READS_PER_MINUTE = 10;
const READ_WINDOW_MS = 60_000;
const READ_ROW_RETENTION_MS = 10 * 60_000;
/** An artifact whose message never received its card (a crash between the two writes). */
const UNATTACHED_ARTIFACT_GRACE_MS = 60 * 60_000;
const SWEEP_BATCH = 100;

export type LinkPreviewReadSource = "job" | "composer";

/** sha256 of the space and the normalized URL: the cache never stores the URL itself. */
export function linkPreviewKeyHash(spaceId: string, normalizedUrl: string): string {
  return createHash("sha256").update(`${spaceId}\n${normalizedUrl}`).digest("hex");
}

/**
 * The key of a card one person's device read: theirs alone, so a head a member sends never
 * becomes another member's card or a bot's card in someone else's thread.
 */
export function linkPreviewDeviceKeyHash(
  spaceId: string,
  userId: string,
  normalizedUrl: string,
): string {
  return createHash("sha256")
    .update(`device\n${spaceId}\n${userId}\n${normalizedUrl}`)
    .digest("hex");
}

/**
 * Where an entry came from. `device`: the head was read by the sender's device and the server
 * fetched the image; such an entry is stored under that person's own key
 * (`linkPreviewDeviceKeyHash`). Absent means `server`.
 */
export type LinkPreviewCacheSource = "server" | "device";

/**
 * What one read learned about a link, so that a card and a mention both derive from it. `Img`
 * and `Icon` are bytes just read, or store keys once cached. A page's title is absent when the
 * page names its site rather than itself; `crossSite` means the read ended on another site than
 * the link's, whose title a mention must never show (a card shows the host). A page image is only
 * read for an article (`fit: "contain"` when the site's icon stands in for it); `article: "unread"`
 * is an article read for a mention, whose image was never asked for. `refused`: the site answered
 * 401, 402, 403 or 451, so only its home page's icon is known.
 */
export type LinkFacts<Img, Icon> =
  | { kind: "photo"; image: Img }
  | {
      kind: "page";
      article: boolean | "unread";
      title?: string;
      crossSite?: true;
      image?: Img & { fit?: "contain" };
      icon?: Icon;
    }
  | { kind: "refused"; icon?: Icon };

/** The facts of a link's last read, or that it cannot be read at all (`unreadable`). */
export type CachedLinkRead = (
  | LinkFacts<
      { key: string; width: number; height: number; bytes: number },
      { key: string; bytes: number }
    >
  | { kind: "unreadable" }
) & { source?: LinkPreviewCacheSource };

type CacheRow = {
  status: string;
  title: string | null;
  imageKey: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  imageBytes: number;
  imageFit: string | null;
  article: boolean | null;
  crossSite: boolean;
  iconKey: string | null;
  iconBytes: number;
  source: string;
};

/** Rows written before reads were facts (`ok`, `failed`) are misses. */
function toCached(row: CacheRow): CachedLinkRead | null {
  const source = row.source === "device" ? "device" : "server";
  const image =
    row.imageKey && row.imageWidth && row.imageHeight
      ? { key: row.imageKey, width: row.imageWidth, height: row.imageHeight, bytes: row.imageBytes }
      : undefined;
  const icon = row.iconKey ? { icon: { key: row.iconKey, bytes: row.iconBytes } } : {};
  switch (row.status) {
    case "photo":
      return image ? { kind: "photo", image, source } : null;
    case "page":
      return {
        kind: "page",
        article: row.article ?? "unread",
        ...(row.title ? { title: row.title } : {}),
        ...(row.crossSite ? { crossSite: true } : {}),
        ...(image
          ? { image: row.imageFit === "contain" ? { ...image, fit: "contain" } : image }
          : {}),
        ...icon,
        source,
      };
    case "refused":
      return { kind: "refused", ...icon, source };
    case "unreadable":
      return { kind: "unreadable", source };
    default:
      return null;
  }
}

/** A live (unexpired) cache entry of this space, or null. */
export async function findCachedLinkPreview(
  prisma: Pick<PrismaClient, "linkPreviewCache">,
  spaceId: string,
  keyHash: string,
  now = new Date(),
): Promise<CachedLinkRead | null> {
  const row = await prisma.linkPreviewCache.findUnique({
    where: { spaceId_keyHash: { spaceId, keyHash } },
  });
  if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
  return toCached(row);
}

/**
 * Stores one entry (replacing an older one of the same key), then evicts the space's oldest
 * entries past the 500-entry / 100 MB caps. Returns the storage keys of the image bytes that
 * lost their row, for the caller to delete from the store. An advisory lock per space makes the
 * read-then-write one step, so two parallel stores of one link never both miss the replaced image.
 */
export async function storeLinkPreviewCache(
  prisma: Pick<PrismaClient, "$transaction">,
  input: { spaceId: string; keyHash: string; entry: CachedLinkRead; now?: Date },
): Promise<{ removedImageKeys: string[] }> {
  const now = input.now ?? new Date();
  const { entry } = input;
  const page = entry.kind === "page" ? entry : undefined;
  const image = entry.kind === "photo" ? entry.image : page?.image;
  const icon = entry.kind === "page" || entry.kind === "refused" ? entry.icon : undefined;
  const data = {
    status: entry.kind,
    title: page?.title ?? null,
    imageKey: image?.key ?? null,
    imageWidth: image?.width ?? null,
    imageHeight: image?.height ?? null,
    imageBytes: image?.bytes ?? 0,
    imageFit: page?.image?.fit ?? null,
    article: page && page.article !== "unread" ? page.article : null,
    crossSite: page?.crossSite === true,
    iconKey: icon?.key ?? null,
    iconBytes: icon?.bytes ?? 0,
    source: entry.source ?? "server",
  };
  const keysOf = (row: { imageKey: string | null; iconKey: string | null }) =>
    [row.imageKey, row.iconKey].filter((key): key is string => key !== null);
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`link-preview-cache:${input.spaceId}`}))`;
    const where = { spaceId_keyHash: { spaceId: input.spaceId, keyHash: input.keyHash } };
    const previous = await tx.linkPreviewCache.findUnique({ where });
    const kept = new Set(keysOf(data));
    const removedImageKeys = previous ? keysOf(previous).filter((key) => !kept.has(key)) : [];
    await tx.linkPreviewCache.upsert({
      where,
      create: {
        spaceId: input.spaceId,
        keyHash: input.keyHash,
        ...data,
        createdAt: now,
        expiresAt: new Date(now.getTime() + LINK_PREVIEW_CACHE_TTL_MS),
      },
      update: {
        ...data,
        createdAt: now,
        expiresAt: new Date(now.getTime() + LINK_PREVIEW_CACHE_TTL_MS),
      },
    });
    const rows = await tx.linkPreviewCache.findMany({
      where: { spaceId: input.spaceId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        keyHash: true,
        imageKey: true,
        imageBytes: true,
        iconKey: true,
        iconBytes: true,
      },
    });
    let count = rows.length;
    let bytes = rows.reduce((sum, row) => sum + row.imageBytes + row.iconBytes, 0);
    const evicted: string[] = [];
    for (const row of rows) {
      if (count <= LINK_PREVIEW_CACHE_MAX_ENTRIES && bytes <= LINK_PREVIEW_CACHE_MAX_BYTES) break;
      // The entry just written is the newest: it is only reached when it alone is over the cap.
      if (row.keyHash === input.keyHash) break;
      evicted.push(row.id);
      count -= 1;
      bytes -= row.imageBytes + row.iconBytes;
      removedImageKeys.push(...keysOf(row));
    }
    if (evicted.length) await tx.linkPreviewCache.deleteMany({ where: { id: { in: evicted } } });
    return { removedImageKeys };
  });
}

/**
 * Counts a real read against the space (30 a minute) and, for the composer, the person (10 a
 * minute), in the database so the API and every worker share the budget. False when over a
 * limit: the caller shows no preview and caches nothing. Advisory locks make the count-then-insert
 * one step per space and, for a composer read, per person too (their budget spans every space).
 * The space lock is always taken first, so two reads never wait on each other in a cycle.
 */
export async function reserveLinkPreviewRead(
  prisma: Pick<PrismaClient, "$transaction">,
  input: { spaceId: string; userId?: string; source: LinkPreviewReadSource; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - READ_WINDOW_MS);
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`link-preview-reads:${input.spaceId}`}))`;
    const actor = input.source === "composer" ? input.userId : undefined;
    if (actor) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`link-preview-reads:user:${actor}`}))`;
    }
    const spaceReads = await tx.linkPreviewRead.count({
      where: { spaceId: input.spaceId, createdAt: { gte: since } },
    });
    if (spaceReads >= LINK_PREVIEW_SPACE_READS_PER_MINUTE) return false;
    if (actor) {
      const actorReads = await tx.linkPreviewRead.count({
        where: { userId: actor, source: "composer", createdAt: { gte: since } },
      });
      if (actorReads >= LINK_PREVIEW_ACTOR_READS_PER_MINUTE) return false;
    }
    await tx.linkPreviewRead.deleteMany({
      where: {
        spaceId: input.spaceId,
        createdAt: { lt: new Date(now.getTime() - READ_ROW_RETENTION_MS) },
      },
    });
    await tx.linkPreviewRead.create({
      data: {
        spaceId: input.spaceId,
        userId: input.source === "composer" ? input.userId : null,
        source: input.source,
        createdAt: now,
      },
    });
    return true;
  });
}

/** Drops expired cache rows and spent read counters. Returns the images to delete from the store. */
export async function purgeLinkPreviewState(
  prisma: Pick<PrismaClient, "$transaction">,
  now = new Date(),
): Promise<{ removedImages: Array<{ spaceId: string; key: string }> }> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const expired = await tx.linkPreviewCache.findMany({
      where: { expiresAt: { lte: now } },
      select: { id: true, spaceId: true, imageKey: true, iconKey: true },
      take: 1000,
    });
    // Guarded by the select's own cutoff: a row refreshed since keeps its new content and keys.
    let purged = expired;
    if (expired.length) {
      const ids = expired.map((row) => row.id);
      const { count } = await tx.linkPreviewCache.deleteMany({
        where: { id: { in: ids }, expiresAt: { lte: now } },
      });
      if (count < expired.length) {
        const kept = new Set(
          (
            await tx.linkPreviewCache.findMany({ where: { id: { in: ids } }, select: { id: true } })
          ).map((row) => row.id),
        );
        purged = expired.filter((row) => !kept.has(row.id));
      }
    }
    await tx.linkPreviewRead.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - READ_ROW_RETENTION_MS) } },
    });
    return {
      removedImages: purged.flatMap((row) =>
        [row.imageKey, row.iconKey].flatMap((key) => (key ? [{ spaceId: row.spaceId, key }] : [])),
      ),
    };
  });
}

// ---- Writing the preview ----------------------------------------------------------------

function isPreviewBlock(block: unknown): boolean {
  return Boolean(
    block && typeof block === "object" && (block as { kind?: unknown }).kind === "link_preview",
  );
}

/**
 * The bot an event of this thread is attributed to when the message names none: the thread's
 * own, or a group's first member. A message that has an author keeps it (a group's second bot).
 */
async function eventBotIdForThread(
  tx: Prisma.TransactionClient,
  threadId: string,
): Promise<string | null> {
  const thread = await tx.thread.findUnique({
    where: { id: threadId },
    select: { botId: true, groupId: true },
  });
  if (!thread) return null;
  if (thread.botId) return thread.botId;
  if (!thread.groupId) return null;
  const member = await tx.chatGroupMember.findFirst({
    where: { groupId: thread.groupId },
    orderBy: { createdAt: "asc" },
    select: { botId: true },
  });
  return member?.botId ?? null;
}

function blockOf(payload: Prisma.JsonValue): { kind?: unknown; url?: unknown } {
  const block = (payload as { block?: unknown } | null)?.block;
  return block && typeof block === "object" ? block : {};
}

/**
 * The message a link's blocks go under, read under the thread lock while it is still on the
 * thread's chain, with what it already holds: an inline marker (the opt-out it was sent with, or
 * an old inline card), whether its one card slot is taken (a card, or a removal), the card shown,
 * and the keys of its mentions.
 */
async function previewTarget(
  tx: Prisma.TransactionClient,
  input: { threadId: string; messageId: string },
) {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
  const [message] = await tx.$queryRaw<
    Array<{ id: string; sessionId: string; botId: string | null; payload: Prisma.JsonValue }>
  >`
    SELECT e.id, e."sessionId", e."botId", e.payload FROM session_entries e
    JOIN sessions s ON s.id = e."sessionId" AND s."threadId" = ${input.threadId} AND s.kind = 'thread'
    WHERE e.id = ${input.messageId} AND ${ENTRY_ON_CHAIN}`;
  if (!message) return null;
  const entries = await tx.sessionEntry.findMany({
    where: {
      sessionId: message.sessionId,
      type: "link.preview",
      payload: { path: ["target"], equals: message.id },
    },
    orderBy: { seq: "asc" },
    select: { id: true, payload: true },
  });
  const cards = entries.filter((entry) => blockOf(entry.payload).kind === "link_preview");
  const mentionKeys = new Set(
    entries.flatMap((entry) => {
      const { kind, url } = blockOf(entry.payload);
      const key = kind === "link_mention" && typeof url === "string" ? linkKey(url) : null;
      return key ? [key] : [];
    }),
  );
  const removals = await tx.sessionEntry.findMany({
    where: {
      sessionId: message.sessionId,
      type: "link.preview.removed",
      OR: [message.id, ...cards.map((card) => card.id)].map((target) => ({
        payload: { path: ["target"], equals: target },
      })),
    },
    select: { payload: true },
  });
  const removed = new Set(
    removals.map((removal) => (removal.payload as { target: string }).target),
  );
  const inline = blocksOf(message).some(isPreviewBlock);
  return {
    message,
    botId: message.botId ?? (await eventBotIdForThread(tx, input.threadId)),
    inline,
    cardTaken: inline || cards.length > 0 || removed.size > 0,
    shown: cards.findLast((card) => !removed.has(card.id)),
    mentionKeys,
  };
}

/**
 * On `appended`, `artifactIds` are the artifacts the written entries show; the caller discards
 * the others.
 */
export type AppendLinkBlocksResult =
  | { outcome: "appended"; seq: number; artifactIds: string[] }
  | { outcome: "gone" | "present" };

/**
 * Attaches a message's card and mentions in the one short transaction that holds the thread lock,
 * one `link.preview` entry per block, each naming the one artifact it shows, the card in one feed
 * event and the mentions in the next. Idempotent: the card is written only while the message's
 * card slot is free (no card, no removal), and a mention only for a link key the message has no
 * mention for yet, so a rerun completes a partial set without a duplicate. A message sent with its
 * preview off (or gone from the thread) gets nothing.
 */
export async function appendLinkBlocks(
  prisma: Pick<PrismaClient, "$transaction">,
  input: {
    spaceId: string;
    threadId: string;
    messageId: string;
    blocks: Array<LinkPreviewCard | LinkMentionBlock>;
  },
): Promise<AppendLinkBlocksResult> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const target = await previewTarget(tx, input);
    if (!target?.botId) return { outcome: "gone" } as const;
    if (target.inline) return { outcome: "present" } as const;
    let cardTaken = target.cardTaken;
    const keys = new Set(target.mentionKeys);
    const written = input.blocks.filter((block) => {
      if (block.kind === "link_preview") {
        if (cardTaken) return false;
        cardTaken = true;
        return true;
      }
      const key = linkKey(block.url);
      if (!key || keys.has(key)) return false;
      keys.add(key);
      return true;
    });
    if (written.length === 0) return { outcome: "present" } as const;
    // A client released before mentions drops a whole feed event that holds one, so the card
    // goes alone in the first event and the mentions follow in a second.
    const events = [
      written.filter((block) => block.kind === "link_preview"),
      written.filter((block) => block.kind === "link_mention"),
    ];
    const artifactIds: string[] = [];
    for (const blocks of events) {
      for (const block of blocks) {
        const artifactId =
          block.kind === "link_preview" ? block.image?.artifactId : block.icon?.artifactId;
        if (artifactId) artifactIds.push(artifactId);
        await appendCardStateInTransaction(tx, {
          type: "link.preview",
          feedBotId: target.botId,
          payload: {
            target: EntryId.parse(target.message.id),
            block,
            ...(artifactId ? { artifactId } : {}),
          },
        });
      }
      endThreadFeedEvent(tx, input.threadId);
    }
    return {
      outcome: "appended",
      seq: await threadEventSeq(tx, input.threadId),
      artifactIds,
    } as const;
  });
}

export type RemoveLinkPreviewResult =
  | { outcome: "removed"; seq: number; artifacts: Array<{ id: string; storageKey: string }> }
  | { outcome: "unchanged" }
  | { outcome: "gone" };

/**
 * Removes the message's card, or marks it as having none when no card arrived yet, so a read
 * still in flight cannot add one, and deletes the card's image artifact row. Mentions and their
 * icons stay. A second call finds the removal and writes nothing. The caller deletes the returned
 * artifacts' bytes afterwards.
 */
export async function removeLinkPreviewBlock(
  prisma: Pick<PrismaClient, "$transaction">,
  input: { spaceId: string; threadId: string; messageId: string },
): Promise<RemoveLinkPreviewResult> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const target = await previewTarget(tx, input);
    if (!target?.botId) return { outcome: "gone" } as const;
    if (target.cardTaken && !target.shown) return { outcome: "unchanged" } as const;
    await appendCardStateInTransaction(tx, {
      type: "link.preview.removed",
      feedBotId: target.botId,
      payload: { target: EntryId.parse(target.shown?.id ?? target.message.id) },
    });
    const artifactId = (target.shown?.payload as { artifactId?: string } | undefined)?.artifactId;
    const artifacts = artifactId
      ? await tx.artifact.findMany({
          where: { id: artifactId, isLinkPreview: true, previewMessageId: target.message.id },
          select: { id: true, storageKey: true },
        })
      : [];
    if (artifacts.length) {
      await tx.artifact.deleteMany({ where: { id: { in: artifacts.map((row) => row.id) } } });
    }
    return {
      outcome: "removed",
      seq: await threadEventSeq(tx, input.threadId),
      artifacts,
    } as const;
  });
}

export interface OrphanPreviewArtifact {
  id: string;
  storageKey: string;
  spaceId: string;
  userId: string;
  botId: string | null;
}

/**
 * Preview artifacts that no message shows any more: their message's session went (thread or bot
 * deleted: the foreign key nulled `previewMessageId`), or no preview entry ever named them. The
 * caller deletes the bytes, then the rows with `deleteLinkPreviewArtifactRows`.
 */
export async function findOrphanPreviewArtifacts(
  prisma: Pick<PrismaClient, "artifact" | "sessionEntry">,
  options: { spaceId?: string; now?: Date } = {},
): Promise<OrphanPreviewArtifact[]> {
  const now = options.now ?? new Date();
  const scope = options.spaceId ? { spaceId: options.spaceId } : {};
  const select = { id: true, storageKey: true, spaceId: true, userId: true, botId: true } as const;
  const detached = await prisma.artifact.findMany({
    where: { isLinkPreview: true, previewMessageId: null, ...scope },
    select,
    take: SWEEP_BATCH,
  });
  const unattached = await prisma.artifact.findMany({
    where: {
      isLinkPreview: true,
      previewMessageId: { not: null },
      createdAt: { lt: new Date(now.getTime() - UNATTACHED_ARTIFACT_GRACE_MS) },
      ...scope,
    },
    select,
    orderBy: { createdAt: "asc" },
    take: SWEEP_BATCH,
  });
  const shown = unattached.length
    ? await prisma.sessionEntry.findMany({
        where: {
          type: "link.preview",
          OR: unattached.map((row) => ({ payload: { path: ["artifactId"], equals: row.id } })),
        },
        select: { payload: true },
      })
    : [];
  const shownIds = new Set(
    shown.map((entry) => (entry.payload as { artifactId?: string }).artifactId),
  );
  return [...detached, ...unattached.filter((row) => !shownIds.has(row.id))];
}

export async function deleteLinkPreviewArtifactRows(
  prisma: Pick<PrismaClient, "artifact">,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  await prisma.artifact.deleteMany({ where: { id: { in: ids }, isLinkPreview: true } });
}
