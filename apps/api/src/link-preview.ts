import type { ArtifactStore } from "@rakazo/adapter-kit";
import {
  createThumbnailDataUrl,
  type LinkPreviewServiceDeps,
  previewStoreContext,
  removePreviewBytes,
  resolveLinkPreviewDetailed,
  resolveLinkPreviewWithDeviceHead,
} from "@rakazo/adapters";
import type { Actor, LinkPreviewDraft } from "@rakazo/contracts";
import { LINK_PREVIEW_COMPOSER_DEADLINE_MS } from "@rakazo/contracts";
import {
  IsolationError,
  type PrismaClient,
  removeLinkPreviewBlock,
  type ThreadEvents,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

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
  linkPreview?: Pick<LinkPreviewServiceDeps, "read" | "readFromHead" | "readDeps" | "now"> & {
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
 *
 * `deviceReadable` is the one thing a draft adds: the site refused the server (or answered with a
 * passing 429 or 5xx), so the sender's device may read the page and call again with its `pageHead`.
 * The server uses a `pageHead` only while it is still refused for that link, and ignores it
 * otherwise; no other failure reason is told apart.
 */
export async function previewLinkForComposer(
  deps: LinkPreviewApiDeps,
  actor: Actor,
  input: { threadId: string; url: string; pageHead?: string; pageHeadType?: string },
  signal: AbortSignal,
): Promise<LinkPreviewDraft | null> {
  const thread = await deps.prisma.thread.findFirst({
    where: { id: input.threadId, ...writableThread(actor) },
    select: { id: true },
  });
  if (!thread) throw new IsolationError();

  const release = (deps.linkPreview?.inFlight ?? composerInFlight).acquire(actor.userId);
  if (!release) return null;
  let ephemeralKey: string | undefined;
  try {
    const service: LinkPreviewServiceDeps = {
      prisma: deps.prisma,
      artifacts: deps.artifacts,
      ...deps.linkPreview,
      // The reader skips an optional icon it would not have time to finish.
      readDeps: {
        ...deps.linkPreview?.readDeps,
        deadlineAt: Date.now() + LINK_PREVIEW_COMPOSER_DEADLINE_MS,
      },
    };
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(LINK_PREVIEW_COMPOSER_DEADLINE_MS),
    ]);
    const scope = { spaceId: actor.spaceId, userId: actor.userId, source: "composer" as const };
    const { preview, deviceReadable, ephemeralImageKey } = input.pageHead
      ? await resolveLinkPreviewWithDeviceHead(
          service,
          scope,
          input.url,
          input.pageHead,
          deadline,
          input.pageHeadType,
        )
      : await resolveLinkPreviewDetailed(service, scope, input.url, deadline);
    ephemeralKey = ephemeralImageKey;
    // A refusal has no card to show, but still tells the device it may read.
    if (!preview) return deviceReadable ? { format: "compact", deviceReadable: true } : null;
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
      ...(thumbnail && preview.image?.fit ? { thumbnailFit: preview.image.fit } : {}),
      ...(deviceReadable ? { deviceReadable: true as const } : {}),
    };
  } finally {
    // A device-read card the cache does not keep: its image served this draft, nothing else.
    if (ephemeralKey) await removePreviewBytes(deps.artifacts, actor, [ephemeralKey]);
    release();
  }
}

/**
 * `messages.removeLinkPreview`: removes the message's card under the thread lock, deletes the card
 * image, and tells every open surface. Calling it again changes nothing and emits nothing. A
 * message outside the actor's own threads is the usual isolation error.
 */
export async function removeMessageLinkPreview(
  deps: LinkPreviewApiDeps,
  actor: Actor,
  input: { messageId: string },
): Promise<void> {
  const message = await deps.prisma.sessionEntry.findFirst({
    where: { id: input.messageId, session: { kind: "thread", thread: writableThread(actor) } },
    select: { id: true, session: { select: { threadId: true } } },
  });
  const threadId = message?.session.threadId;
  if (!message || !threadId) throw new IsolationError();
  const removed = await removeLinkPreviewBlock(deps.prisma, {
    spaceId: actor.spaceId,
    threadId,
    messageId: message.id,
  });
  if (removed.outcome === "gone") throw new IsolationError();
  if (removed.outcome === "unchanged") return;
  await removePreviewBytes(
    deps.artifacts,
    actor,
    removed.artifacts.map((artifact) => artifact.storageKey),
  );
  await deps.events.notify(threadId, removed.seq).catch((error) => {
    getLogger().error("link preview removal realtime notification", error);
  });
}
