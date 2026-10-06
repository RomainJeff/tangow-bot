import type { ArtifactStore } from "@rakazo/adapter-kit";
import {
  deleteLinkPreviewArtifactRows,
  findOrphanPreviewArtifacts,
  type PrismaClient,
  purgeLinkPreviewState,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { previewStoreContext, removePreviewBytes } from "./service.js";

/**
 * Deletes the card images no message shows any more: the thread was cleared or rewound, the bot
 * or group went away (the foreign key nulled the artifact's message), or the card was never
 * attached. Bytes first, then the rows, so a failure leaves rows to retry from. Never throws.
 */
export async function sweepOrphanPreviewArtifacts(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  options: { spaceId?: string; now?: Date } = {},
): Promise<number> {
  try {
    const orphans = await findOrphanPreviewArtifacts(deps.prisma, options);
    const removed: string[] = [];
    for (const orphan of orphans) {
      try {
        await deps.artifacts.remove(
          orphan.storageKey,
          previewStoreContext(orphan, "link-preview:sweep"),
        );
        removed.push(orphan.id);
      } catch {
        // Keep the row: the next sweep tries again.
      }
    }
    await deleteLinkPreviewArtifactRows(deps.prisma, removed);
    return removed.length;
  } catch (error) {
    getLogger().warn("link preview artifact sweep failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return 0;
  }
}

const PURGE_INTERVAL_MS = 10 * 60_000;

/**
 * The periodic clean-up the job reconciler calls on every tick: expired cache rows and their
 * images, spent read counters, and card images no message shows. Runs at most once per interval.
 */
export function createLinkPreviewPurge(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  options: { intervalMs?: number; now?: () => Date } = {},
): () => Promise<void> {
  let lastRun = 0;
  return async () => {
    const now = options.now?.() ?? new Date();
    if (now.getTime() - lastRun < (options.intervalMs ?? PURGE_INTERVAL_MS)) return;
    lastRun = now.getTime();
    const { removedImages } = await purgeLinkPreviewState(deps.prisma, now);
    for (const image of removedImages) {
      await removePreviewBytes(deps.artifacts, { spaceId: image.spaceId, userId: "system" }, [
        image.key,
      ]);
    }
    await sweepOrphanPreviewArtifacts(deps, { now });
  };
}
