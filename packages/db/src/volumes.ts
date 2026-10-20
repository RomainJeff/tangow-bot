import { LIVE_WORKER_STATES, WORKER_TTL_SECONDS } from "@rakazo/core";
import { Prisma } from "./client.js";

/** A bot owns its private volume; a space owns its shared one, and is deleted only once empty. */
export type VolumeOwnerRef = { botId: string } | { spaceId: string };

/** A worker of the owner may still write its volumes. Release it, then retry. */
export class OwnerWorkerLiveError extends Error {
  constructor() {
    super("A worker may still be running on these volumes; try again shortly");
    this.name = "OwnerWorkerLiveError";
  }
}

const UNRELEASED = new Set<string>([...LIVE_WORKER_STATES, "releasing"]);

/**
 * Deletes the owner's volume rows inside the owner's deletion transaction, never their provider
 * volumes: those are swept once no row names them. Locks in the workers' order (the owner's runs,
 * their workers' attempts, then the volumes by id) and refuses while a worker of the owner's runs
 * is not confirmed gone, unless its TTL has passed and the provider has ended it.
 */
export async function deleteOwnerVolumes(
  tx: Prisma.TransactionClient,
  owner: VolumeOwnerRef,
  now = new Date(),
): Promise<void> {
  const ownedRuns =
    "botId" in owner
      ? Prisma.sql`r."botId" = ${owner.botId}`
      : Prisma.sql`r."spaceId" = ${owner.spaceId}`;
  await tx.$queryRaw`SELECT r.id FROM runs r WHERE ${ownedRuns} ORDER BY r.id FOR UPDATE`;
  const workers = await tx.$queryRaw<{ workerState: string; workerEnsureAt: Date | null }[]>`
    SELECT a."workerState", a."workerEnsureAt" FROM attempts a JOIN runs r ON r.id = a."runId"
    WHERE ${ownedRuns} AND a."workerState" IS NOT NULL
    ORDER BY a.id FOR UPDATE OF a`;
  const expired = new Date(now.getTime() - WORKER_TTL_SECONDS * 1000);
  const volumes = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM volumes
    WHERE ${
      "botId" in owner
        ? Prisma.sql`kind = 'bot_private' AND "botId" = ${owner.botId}`
        : Prisma.sql`"spaceId" = ${owner.spaceId}`
    }
    ORDER BY id FOR UPDATE`;
  if (
    workers.some(
      (worker) => UNRELEASED.has(worker.workerState) && (worker.workerEnsureAt ?? now) > expired,
    )
  ) {
    throw new OwnerWorkerLiveError();
  }
  if (volumes.length > 0) {
    await tx.$executeRaw`DELETE FROM volumes WHERE id = ANY(${volumes.map((volume) => volume.id)})`;
  }
}
