import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

/** What a scoped lookup throws when the caller may not see the resource; any other message marks a server invariant. */
export const RESOURCE_NOT_FOUND = "Resource not found";

export class IsolationError extends Error {
  constructor(message = RESOURCE_NOT_FOUND) {
    super(message);
    this.name = "IsolationError";
  }
}

/** Unique (spaceId, userId, name) collision when renaming a bot section. */
export class BotSectionNameConflictError extends Error {
  constructor(message = "Section name already used") {
    super(message);
    this.name = "BotSectionNameConflictError";
  }
}

export async function requireMembership(
  prisma: PrismaClient,
  userId: string,
  requestedSpaceId?: string | null,
): Promise<Actor> {
  const findMembership = (spaceId?: string | null) =>
    prisma.spaceMember.findFirst({
      where: { userId, ...(spaceId ? { spaceId } : {}) },
      orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
      include: { member: { include: { user: true } } },
    });
  // A selection gone stale (removed, or the Space or its owner deleted) lands in the user's own
  // Space instead of locking out every request; the client follows the Space bootstrap returns.
  const membership =
    (requestedSpaceId ? await findMembership(requestedSpaceId) : null) ?? (await findMembership());
  if (!membership) {
    throw new IsolationError("No personal space");
  }
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
  });
  return {
    userId: membership.userId,
    spaceId: membership.spaceId,
    email: membership.member.user.email,
    isDeploymentOwner: settings?.ownerUserId === membership.userId,
  };
}

export function scoped<T extends { spaceId: string; userId?: string }>(
  actor: Actor,
  record: T | null,
): T {
  if (!record || record.spaceId !== actor.spaceId) {
    throw new IsolationError();
  }
  if (record.userId && record.userId !== actor.userId) {
    throw new IsolationError();
  }
  return record;
}
