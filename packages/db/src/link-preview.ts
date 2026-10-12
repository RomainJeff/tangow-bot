import { createHash } from "node:crypto";
import type { LinkPreviewCard } from "@rakazo/contracts";
import { EntryId } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { appendCardStateInTransaction, blocksOf, threadEventSeq } from "./sessions.js";

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
 * Where an entry came from. `restricted`: the site refused the server (401, 402, 403, 451), so the
 * entry is a fallback card or a bare failure, and the sender's device may still read the page.
 * `device`: the head was read by the sender's device and the server fetched the image; such an
 * entry is stored under that person's own key (`linkPreviewDeviceKeyHash`). Absent means
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
 * lost their row, for the caller to delete from the store. An advisory lock per space makes the
 * read-then-write one step, so two parallel stores of one link never both miss the replaced image.
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
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`link-preview-cache:${input.spaceId}`}))`;
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

/**
 * The message a preview goes under, read under the thread lock, with what it holds of a preview: an
 * opt-out marker it was sent with, its preview entries, and whether one was removed.
 */
async function previewTarget(
  tx: Prisma.TransactionClient,
  input: { threadId: string; messageId: string },
) {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
  const message = await tx.sessionEntry.findFirst({
    where: { id: input.messageId, session: { threadId: input.threadId, kind: "thread" } },
    select: { id: true, sessionId: true, botId: true, payload: true },
  });
  if (!message) return null;
  const previews = await tx.sessionEntry.findMany({
    where: {
      sessionId: message.sessionId,
      type: "link.preview",
      payload: { path: ["target"], equals: message.id },
    },
    orderBy: { seq: "asc" },
    select: { id: true },
  });
  const removals = await tx.sessionEntry.findMany({
    where: {
      sessionId: message.sessionId,
      type: "link.preview.removed",
      OR: [message.id, ...previews.map((preview) => preview.id)].map((target) => ({
        payload: { path: ["target"], equals: target },
      })),
    },
    select: { payload: true },
  });
  const removed = new Set(
    removals.map((removal) => (removal.payload as { target: string }).target),
  );
  return {
    message,
    botId: message.botId ?? (await eventBotIdForThread(tx, input.threadId)),
    marked: previews.length > 0 || removed.size > 0 || blocksOf(message).some(isPreviewBlock),
    shown: previews.findLast((preview) => !removed.has(preview.id)),
  };
}

export type AppendLinkPreviewResult =
  | { outcome: "appended"; seq: number }
  | { outcome: "gone" | "present" };

/**
 * Attaches a preview card to a message: the one short transaction that holds the thread lock. If
 * the message is not the thread's, or already has a preview, a removed one or the opt-out marker,
 * nothing is written. The entry reaches the thread's feed under the message's own bot.
 */
export async function appendLinkPreviewBlock(
  prisma: Pick<PrismaClient, "$transaction">,
  input: { spaceId: string; threadId: string; messageId: string; block: LinkPreviewCard },
): Promise<AppendLinkPreviewResult> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const target = await previewTarget(tx, input);
    if (!target?.botId) return { outcome: "gone" } as const;
    if (target.marked) return { outcome: "present" } as const;
    await appendCardStateInTransaction(tx, {
      type: "link.preview",
      feedBotId: target.botId,
      payload: {
        target: EntryId.parse(target.message.id),
        block: input.block,
        ...(input.block.image ? { artifactId: input.block.image.artifactId } : {}),
      },
    });
    return { outcome: "appended", seq: await threadEventSeq(tx, input.threadId) } as const;
  });
}

export type RemoveLinkPreviewResult =
  | { outcome: "removed"; seq: number; artifacts: Array<{ id: string; storageKey: string }> }
  | { outcome: "unchanged" }
  | { outcome: "gone" };

/**
 * Removes the message's preview, or marks it as having none when no card arrived yet, so a read
 * still in flight cannot add one, and deletes the card's image artifact rows. A second call finds
 * the removal and writes nothing. The caller deletes the returned artifacts' bytes afterwards.
 */
export async function removeLinkPreviewBlock(
  prisma: Pick<PrismaClient, "$transaction">,
  input: { spaceId: string; threadId: string; messageId: string },
): Promise<RemoveLinkPreviewResult> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const target = await previewTarget(tx, input);
    if (!target?.botId) return { outcome: "gone" } as const;
    if (target.marked && !target.shown) return { outcome: "unchanged" } as const;
    await appendCardStateInTransaction(tx, {
      type: "link.preview.removed",
      feedBotId: target.botId,
      payload: { target: EntryId.parse(target.shown?.id ?? target.message.id) },
    });
    const artifacts = await tx.artifact.findMany({
      where: { isLinkPreview: true, previewMessageId: target.message.id },
      select: { id: true, storageKey: true },
    });
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
