import { createHash } from "node:crypto";
import type { LinkPreviewCard } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { messageUpdatedPayload } from "./messages.js";

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
 * Where an entry came from. `restricted`: the site refused the server (401, 402, 403, 451), so the
 * entry is a fallback card or a bare failure, and the sender's device may still read the page.
 * `device`: the head was read by the sender's device; the server fetched the image. Absent means
 * `server`.
 */
export type LinkPreviewCacheSource = "server" | "restricted" | "device";

export type CachedLinkPreview =
  | {
      status: "ok";
      format: "large" | "photo" | "compact";
      title?: string;
      image?: { key: string; width: number; height: number; bytes: number; fit?: "contain" };
      source?: LinkPreviewCacheSource;
    }
  | { status: "failed"; source?: LinkPreviewCacheSource };

type CacheRow = {
  status: string;
  format: string | null;
  title: string | null;
  imageKey: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  imageBytes: number;
  imageFit: string | null;
  source: string;
};

function toSource(value: string): LinkPreviewCacheSource {
  return value === "restricted" || value === "device" ? value : "server";
}

function toCached(row: CacheRow): CachedLinkPreview | null {
  const source = toSource(row.source);
  if (row.status === "failed") return { status: "failed", source };
  if (row.status !== "ok") return null;
  if (row.format !== "large" && row.format !== "photo" && row.format !== "compact") return null;
  return {
    status: "ok",
    source,
    format: row.format,
    ...(row.title ? { title: row.title } : {}),
    ...(row.imageKey && row.imageWidth && row.imageHeight
      ? {
          image: {
            key: row.imageKey,
            width: row.imageWidth,
            height: row.imageHeight,
            bytes: row.imageBytes,
            ...(row.imageFit === "contain" ? { fit: "contain" as const } : {}),
          },
        }
      : {}),
  };
}

/** A live (unexpired) cache entry of this space, or null. */
export async function findCachedLinkPreview(
  prisma: Pick<PrismaClient, "linkPreviewCache">,
  spaceId: string,
  keyHash: string,
  now = new Date(),
): Promise<CachedLinkPreview | null> {
  const row = await prisma.linkPreviewCache.findUnique({
    where: { spaceId_keyHash: { spaceId, keyHash } },
  });
  if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
  return toCached(row);
}

/**
 * Stores one entry (replacing an older one of the same key), then evicts the space's oldest
 * entries past the 500-entry / 100 MB caps. Returns the storage keys of the image bytes that
 * lost their row, for the caller to delete from the store.
 */
export async function storeLinkPreviewCache(
  prisma: Pick<PrismaClient, "$transaction">,
  input: { spaceId: string; keyHash: string; entry: CachedLinkPreview; now?: Date },
): Promise<{ removedImageKeys: string[] }> {
  const now = input.now ?? new Date();
  const { entry } = input;
  const data =
    entry.status === "failed"
      ? {
          status: "failed",
          format: null,
          title: null,
          imageKey: null,
          imageWidth: null,
          imageHeight: null,
          imageBytes: 0,
          imageFit: null,
          source: entry.source ?? "server",
        }
      : {
          status: "ok",
          format: entry.format,
          title: entry.title ?? null,
          imageKey: entry.image?.key ?? null,
          imageWidth: entry.image?.width ?? null,
          imageHeight: entry.image?.height ?? null,
          imageBytes: entry.image?.bytes ?? 0,
          imageFit: entry.image?.fit ?? null,
          source: entry.source ?? "server",
        };
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const removedImageKeys: string[] = [];
    const where = { spaceId_keyHash: { spaceId: input.spaceId, keyHash: input.keyHash } };
    const previous = await tx.linkPreviewCache.findUnique({ where });
    if (previous?.imageKey && previous.imageKey !== data.imageKey) {
      removedImageKeys.push(previous.imageKey);
    }
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
      select: { id: true, keyHash: true, imageKey: true, imageBytes: true },
    });
    let count = rows.length;
    let bytes = rows.reduce((sum, row) => sum + row.imageBytes, 0);
    const evicted: string[] = [];
    for (const row of rows) {
      if (count <= LINK_PREVIEW_CACHE_MAX_ENTRIES && bytes <= LINK_PREVIEW_CACHE_MAX_BYTES) break;
      // The entry just written is the newest: it is only reached when it alone is over the cap.
      if (row.keyHash === input.keyHash) break;
      evicted.push(row.id);
      count -= 1;
      bytes -= row.imageBytes;
      if (row.imageKey) removedImageKeys.push(row.imageKey);
    }
    if (evicted.length) await tx.linkPreviewCache.deleteMany({ where: { id: { in: evicted } } });
    return { removedImageKeys };
  });
}

/**
 * Counts a real read against the space (30 a minute) and, for the composer, the person (10 a
 * minute), in the database so the API and every worker share the budget. False when over a
 * limit: the caller shows no preview and caches nothing. The advisory lock makes the
 * count-then-insert one step per space.
 */
export async function reserveLinkPreviewRead(
  prisma: Pick<PrismaClient, "$transaction">,
  input: { spaceId: string; userId?: string; source: LinkPreviewReadSource; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - READ_WINDOW_MS);
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`link-preview-reads:${input.spaceId}`}))`;
    const spaceReads = await tx.linkPreviewRead.count({
      where: { spaceId: input.spaceId, createdAt: { gte: since } },
    });
    if (spaceReads >= LINK_PREVIEW_SPACE_READS_PER_MINUTE) return false;
    if (input.source === "composer" && input.userId) {
      const actorReads = await tx.linkPreviewRead.count({
        where: { userId: input.userId, source: "composer", createdAt: { gte: since } },
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
      select: { id: true, spaceId: true, imageKey: true },
      take: 1000,
    });
    if (expired.length) {
      await tx.linkPreviewCache.deleteMany({
        where: { id: { in: expired.map((row) => row.id) } },
      });
    }
    await tx.linkPreviewRead.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - READ_ROW_RETENTION_MS) } },
    });
    return {
      removedImages: expired.flatMap((row) =>
        row.imageKey ? [{ spaceId: row.spaceId, key: row.imageKey }] : [],
      ),
    };
  });
}

// ---- Writing the block ------------------------------------------------------------------

function isPreviewBlock(block: unknown): boolean {
  return Boolean(
    block && typeof block === "object" && (block as { kind?: unknown }).kind === "link_preview",
  );
}

function isRemovalMarker(block: unknown): boolean {
  return isPreviewBlock(block) && (block as { removed?: unknown }).removed === true;
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

async function lockThread(tx: Prisma.TransactionClient, threadId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
}

export type AppendLinkPreviewResult =
  | { outcome: "appended"; seq: number }
  | { outcome: "gone" | "present" };

/**
 * Attaches a preview card to a message: the one short transaction that holds the thread lock.
 * The message is read again under the lock; if it is gone (thread cleared or rewound), or
 * already carries a card or the removal marker, nothing is written. The card is appended to
 * the raw stored array, so blocks this build does not know survive. The event is attributed to
 * the message's own bot and carries no run id: a run id would make clients drop that run's live
 * progress message.
 */
export async function appendLinkPreviewBlock(
  prisma: Pick<PrismaClient, "$transaction">,
  input: { spaceId: string; threadId: string; messageId: string; block: LinkPreviewCard },
): Promise<AppendLinkPreviewResult> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockThread(tx, input.threadId);
    const message = await tx.message.findFirst({
      where: { id: input.messageId, threadId: input.threadId },
      select: {
        id: true,
        role: true,
        blocks: true,
        botId: true,
        replyToMessageId: true,
        replyQuote: true,
      },
    });
    if (!message || !Array.isArray(message.blocks)) return { outcome: "gone" } as const;
    const stored = message.blocks as Prisma.InputJsonValue[];
    if (stored.some(isPreviewBlock)) return { outcome: "present" } as const;
    const botId = message.botId ?? (await eventBotIdForThread(tx, input.threadId));
    if (!botId) return { outcome: "gone" } as const;
    const blocks = [...stored, input.block as unknown as Prisma.InputJsonValue];
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId,
      type: "thread.message.updated",
      payload: messageUpdatedPayload(message, blocks),
    });
    return { outcome: "appended", seq: event.seq } as const;
  });
}

export type RemoveLinkPreviewResult =
  | { outcome: "removed"; seq: number; artifacts: Array<{ id: string; storageKey: string }> }
  | { outcome: "unchanged" }
  | { outcome: "gone" };

/**
 * Replaces the card by the removal marker (or adds the marker when the message has no card yet,
 * so a read still in flight cannot add one) and deletes the card's image artifact rows. A
 * second call finds the marker and writes nothing: no event, no change. The caller deletes the
 * returned artifacts' bytes after the commit.
 */
export async function removeLinkPreviewBlock(
  prisma: Pick<PrismaClient, "$transaction">,
  input: { spaceId: string; threadId: string; messageId: string },
): Promise<RemoveLinkPreviewResult> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockThread(tx, input.threadId);
    const message = await tx.message.findFirst({
      where: { id: input.messageId, threadId: input.threadId },
      select: {
        id: true,
        role: true,
        blocks: true,
        botId: true,
        replyToMessageId: true,
        replyQuote: true,
      },
    });
    if (!message || !Array.isArray(message.blocks)) return { outcome: "gone" } as const;
    const stored = message.blocks as Prisma.InputJsonValue[];
    const previews = stored.filter(isPreviewBlock);
    const hasCard = previews.some((block) => !isRemovalMarker(block));
    if (previews.length > 0 && !hasCard) return { outcome: "unchanged" } as const;
    const botId = message.botId ?? (await eventBotIdForThread(tx, input.threadId));
    if (!botId) return { outcome: "gone" } as const;
    const marker = { kind: "link_preview", removed: true } as const;
    const firstPreview = stored.findIndex(isPreviewBlock);
    const blocks: Prisma.InputJsonValue[] = [];
    stored.forEach((block, index) => {
      if (!isPreviewBlock(block)) blocks.push(block);
      else if (index === firstPreview) blocks.push(marker);
    });
    if (firstPreview < 0) blocks.push(marker);
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId,
      type: "thread.message.updated",
      payload: messageUpdatedPayload(message, blocks),
    });
    const artifacts = await tx.artifact.findMany({
      where: { isLinkPreview: true, previewMessageId: message.id },
      select: { id: true, storageKey: true },
    });
    if (artifacts.length) {
      await tx.artifact.deleteMany({ where: { id: { in: artifacts.map((row) => row.id) } } });
    }
    return { outcome: "removed", seq: event.seq, artifacts } as const;
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
 * Preview artifacts that no message shows any more: their message was deleted (thread cleared or
 * rewound, bot deleted: the foreign key nulled `previewMessageId`), or it never received the
 * card. The caller deletes the bytes, then the rows with `deleteLinkPreviewArtifactRows`.
 */
export async function findOrphanPreviewArtifacts(
  prisma: Pick<PrismaClient, "artifact">,
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
    select: { ...select, previewMessage: { select: { blocks: true } } },
    orderBy: { createdAt: "asc" },
    take: SWEEP_BATCH,
  });
  const lost = unattached.filter(
    (row) => !JSON.stringify(row.previewMessage?.blocks ?? null).includes(row.id),
  );
  return [...detached, ...lost].map(({ id, storageKey, spaceId, userId, botId }) => ({
    id,
    storageKey,
    spaceId,
    userId,
    botId,
  }));
}

export async function deleteLinkPreviewArtifactRows(
  prisma: Pick<PrismaClient, "artifact">,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  await prisma.artifact.deleteMany({ where: { id: { in: ids }, isLinkPreview: true } });
}
