import type { ArtifactStore } from "@rakazo/adapter-kit";
import {
  createThumbnailDataUrl,
  type LinkPreviewServiceDeps,
  previewStoreContext,
  removePreviewBytes,
  resolveLinkPreview,
} from "@rakazo/adapters";
import type { Actor, LinkPreviewDraft } from "@rakazo/contracts";
import {
  IsolationError,
  type PrismaClient,
  removeLinkPreviewBlock,
  type ThreadEvents,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** A composer read is cut at this deadline, or as soon as the client goes away. */
export const COMPOSER_PREVIEW_DEADLINE_MS = 10_000;
/** Composer reads one person may have running at once, in this process. */
export const COMPOSER_PREVIEWS_IN_FLIGHT = 3;

export interface InFlightGuard {
  /** The release function, or undefined when the key already has `max` calls running. */
  acquire(key: string): (() => void) | undefined;
}

export function createInFlightGuard(max: number): InFlightGuard {
  const active = new Map<string, number>();
  return {
    acquire(key) {
      const count = active.get(key) ?? 0;
      if (count >= max) return undefined;
      active.set(key, count + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (active.get(key) ?? 1) - 1;
        if (left <= 0) active.delete(key);
        else active.set(key, left);
      };
    },
  };
}

const composerInFlight = createInFlightGuard(COMPOSER_PREVIEWS_IN_FLIGHT);

export interface LinkPreviewApiDeps {
  prisma: PrismaClient;
  artifacts: ArtifactStore;
  events: Pick<ThreadEvents, "notify">;
  /** Test seams of the page reader and the per-person in-flight cap. */
  linkPreview?: Pick<LinkPreviewServiceDeps, "read" | "readDeps" | "now"> & {
    inFlight?: InFlightGuard;
  };
}

/** A thread the actor may write to: theirs, in their space, with a live bot or group. */
const writableThread = (actor: Actor) => ({
  spaceId: actor.spaceId,
  userId: actor.userId,
  OR: [{ bot: { archivedAt: null } }, { group: { archivedAt: null } }],
});

/**
 * `links.preview`: what a link would look like, for the composer. Access to the thread is
 * checked before anything else (cache, quota, network), and every refusal is the same error.
 * Whatever goes wrong afterwards (a refused address, a missing page, a limit) is the same null.
 * No artifact is created: the thumbnail travels inline.
 */
export async function previewLinkForComposer(
  deps: LinkPreviewApiDeps,
  actor: Actor,
  input: { threadId: string; url: string },
  signal: AbortSignal,
): Promise<LinkPreviewDraft | null> {
  const thread = await deps.prisma.thread.findFirst({
    where: { id: input.threadId, ...writableThread(actor) },
    select: { id: true },
  });
  if (!thread) throw new IsolationError();

  const release = (deps.linkPreview?.inFlight ?? composerInFlight).acquire(actor.userId);
  if (!release) return null;
  try {
    const service: LinkPreviewServiceDeps = {
      prisma: deps.prisma,
      artifacts: deps.artifacts,
      ...deps.linkPreview,
    };
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(COMPOSER_PREVIEW_DEADLINE_MS)]);
    const preview = await resolveLinkPreview(
      service,
      { spaceId: actor.spaceId, userId: actor.userId, source: "composer" },
      input.url,
      deadline,
    );
    if (!preview) return null;
    let thumbnail: string | undefined;
    if (preview.image) {
      thumbnail = await deps.artifacts
        .get(preview.image.key, previewStoreContext(actor, "link-preview:thumbnail"))
        .then((bytes) => createThumbnailDataUrl(bytes))
        .catch(() => undefined);
    }
    return {
      format: preview.format,
      ...(preview.format !== "photo" && preview.title ? { title: preview.title } : {}),
      ...(thumbnail ? { thumbnail } : {}),
    };
  } finally {
    release();
  }
}

/**
 * `messages.removeLinkPreview`: swaps the card for the removal marker under the thread lock,
 * deletes the card image, and tells every open surface. Calling it again changes nothing and
 * emits nothing. A message outside the actor's own threads is the usual isolation error.
 */
export async function removeMessageLinkPreview(
  deps: LinkPreviewApiDeps,
  actor: Actor,
  input: { messageId: string },
): Promise<void> {
  const message = await deps.prisma.message.findFirst({
    where: { id: input.messageId, thread: writableThread(actor) },
    select: { id: true, threadId: true },
  });
  if (!message) throw new IsolationError();
  const removed = await removeLinkPreviewBlock(deps.prisma, {
    spaceId: actor.spaceId,
    threadId: message.threadId,
    messageId: message.id,
  });
  if (removed.outcome === "gone") throw new IsolationError();
  if (removed.outcome === "unchanged") return;
  await removePreviewBytes(
    deps.artifacts,
    actor,
    removed.artifacts.map((artifact) => artifact.storageKey),
  );
  await deps.events.notify(message.threadId, removed.seq).catch((error) => {
    getLogger().error("link preview removal realtime notification", error);
  });
}
