import { randomUUID } from "node:crypto";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import { Prisma, type PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { archiveGroupsLeftWithoutBots } from "./groups.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";
import { deleteOwnerVolumes } from "./volumes.js";

/** Per member, per organization: one person cannot fan out unbounded boundaries. */
const MAX_SPACES_PER_MEMBER = 32;

export class SpaceLimitError extends Error {
  constructor() {
    super("Space limit reached");
    this.name = "SpaceLimitError";
  }
}

export class InvalidSpaceNameError extends Error {
  constructor() {
    super("Space name must be between 1 and 60 characters");
    this.name = "InvalidSpaceNameError";
  }
}

export class SpaceNotFoundError extends Error {
  constructor() {
    super("Space not found");
    this.name = "SpaceNotFoundError";
  }
}

export class CannotDeleteDefaultSpaceError extends Error {
  constructor() {
    super("The default space cannot be deleted");
    this.name = "CannotDeleteDefaultSpaceError";
  }
}

export class CannotDeleteLastSpaceError extends Error {
  constructor() {
    super("The last remaining space cannot be deleted");
    this.name = "CannotDeleteLastSpaceError";
  }
}

export class SpaceNotEmptyError extends Error {
  constructor() {
    super("Delete its bots and groups first");
    this.name = "SpaceNotEmptyError";
  }
}

export class CannotDeleteSpaceAsNonOwnerError extends Error {
  constructor() {
    super("Only the space owner can delete it");
    this.name = "CannotDeleteSpaceAsNonOwnerError";
  }
}

export class SpaceDeletionInProgressError extends Error {
  constructor() {
    super("Space deletion is already in progress");
    this.name = "SpaceDeletionInProgressError";
  }
}

export const SPACE_DELETION_CLAIM_TIMEOUT_MS = 5 * 60_000;

type SpaceClient = Pick<
  PrismaClient,
  | "space"
  | "member"
  | "spaceMember"
  | "spaceModelPreference"
  | "spaceVoicePreference"
  | "memoryDocument"
  | "notificationPreference"
  | "bot"
  | "chatGroup"
>;

interface CreateSpaceInput {
  spaceId: string;
  spaceMembershipId: string;
  organizationId: string;
  userId: string;
  name: string;
  createdAt: Date;
}

async function createSpace(prisma: SpaceClient, input: CreateSpaceInput): Promise<void> {
  await prisma.space.create({
    data: {
      id: input.spaceId,
      organizationId: input.organizationId,
      name: input.name,
      createdByUserId: input.userId,
      createdAt: input.createdAt,
    },
  });
  await prisma.spaceMember.create({
    data: {
      id: input.spaceMembershipId,
      spaceId: input.spaceId,
      organizationId: input.organizationId,
      userId: input.userId,
      role: "owner",
      createdAt: input.createdAt,
    },
  });
}

async function createSpaceDefaults(
  prisma: SpaceClient,
  input: { spaceId: string; userId: string; memoryContent: string },
): Promise<void> {
  const memory = { spaceId: input.spaceId, userId: input.userId, scope: "user", path: "MEMORY.md" };
  if (!(await prisma.memoryDocument.findFirst({ where: memory, select: { id: true } }))) {
    await prisma.memoryDocument.create({ data: { ...memory, content: input.memoryContent } });
  }
  await prisma.notificationPreference.createMany({
    data: { spaceId: input.spaceId, userId: input.userId },
    skipDuplicates: true,
  });
}

async function copyProviderPreferences(
  prisma: SpaceClient,
  input: {
    sourceSpaceId: string;
    targetSpaceId: string;
    userId: string;
    createdAt: Date;
  },
): Promise<void> {
  const [modelPreferences, voicePreferences] = await Promise.all([
    prisma.spaceModelPreference.findMany({
      where: { spaceId: input.sourceSpaceId, userId: input.userId },
    }),
    prisma.spaceVoicePreference.findMany({
      where: { spaceId: input.sourceSpaceId, userId: input.userId },
    }),
  ]);
  await Promise.all([
    modelPreferences.length
      ? prisma.spaceModelPreference.createMany({
          data: modelPreferences.map((preference) => ({
            spaceId: input.targetSpaceId,
            userId: input.userId,
            credentialId: preference.credentialId,
            modelId: preference.modelId,
            isDefault: preference.isDefault,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          })),
          skipDuplicates: true,
        })
      : Promise.resolve(),
    voicePreferences.length
      ? prisma.spaceVoicePreference.createMany({
          data: voicePreferences.map((preference) => ({
            spaceId: input.targetSpaceId,
            userId: input.userId,
            credentialId: preference.credentialId,
            voiceId: preference.voiceId,
            isDefault: preference.isDefault,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          })),
          skipDuplicates: true,
        })
      : Promise.resolve(),
  ]);
}

/** Create a privacy boundary in the caller's own organization, never in one they joined. */
export async function createSpaceForMember(
  prisma: PrismaClient,
  input: {
    currentSpaceId: string;
    userId: string;
    name: string;
  },
): Promise<{ id: string; name: string }> {
  const name = input.name.trim();
  if (!name || name.length > 60) throw new InvalidSpaceNameError();
  const spaceId = randomUUID();
  const spaceMembershipId = randomUUID();
  const createdAt = new Date();

  await withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const [currentMembership, ownOrganization] = await Promise.all([
          tx.spaceMember.findUnique({
            where: {
              spaceId_userId: {
                spaceId: input.currentSpaceId,
                userId: input.userId,
              },
            },
            select: { id: true },
          }),
          tx.member.findFirst({
            where: { userId: input.userId, role: "owner" },
            orderBy: { createdAt: "asc" },
            select: { organizationId: true },
          }),
        ]);
        if (!currentMembership || !ownOrganization) throw new IsolationError();
        const count = await tx.spaceMember.count({
          where: {
            userId: input.userId,
            organizationId: ownOrganization.organizationId,
          },
        });
        if (count >= MAX_SPACES_PER_MEMBER) throw new SpaceLimitError();
        await createSpace(tx, {
          spaceId,
          spaceMembershipId,
          organizationId: ownOrganization.organizationId,
          userId: input.userId,
          name,
          createdAt,
        });
        await createSpaceDefaults(tx, {
          spaceId,
          userId: input.userId,
          memoryContent: "# Space memory\n\n",
        });
        await copyProviderPreferences(tx, {
          sourceSpaceId: input.currentSpaceId,
          targetSpaceId: spaceId,
          userId: input.userId,
          createdAt,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );

  return { id: spaceId, name };
}

type EmptySpaceDeleteInput = {
  currentSpaceId: string;
  userId: string;
  spaceId: string;
};

/** Serialize content creation with the empty-space deletion claim. */
export async function lockSpaceForContentCreation(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; userId: string },
): Promise<{ organizationId: string }> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${input.spaceId}, 0))::text AS "lock"
  `);
  const membership = await tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
    select: {
      organizationId: true,
      space: { select: { deletingAt: true } },
    },
  });
  if (!membership) throw new IsolationError();
  if (membership.space.deletingAt) throw new SpaceDeletionInProgressError();
  return { organizationId: membership.organizationId };
}

async function lockSpaceDeletion(tx: Prisma.TransactionClient, spaceId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${spaceId}, 0))::text AS "lock"
  `);
}

type ClaimedSpaceDeleteInput = EmptySpaceDeleteInput & { claimId: string };

type SpaceDeleteDb = Pick<PrismaClient, "spaceMember" | "bot" | "chatGroup" | "computer">;

async function spaceMemberIds(db: Pick<PrismaClient, "spaceMember">, spaceId: string) {
  const members = await db.spaceMember.findMany({ where: { spaceId }, select: { userId: true } });
  return members.map((member) => member.userId);
}

async function assertEmptySpaceDeletable(
  db: SpaceDeleteDb,
  input: EmptySpaceDeleteInput,
): Promise<{
  memberships: Array<{
    spaceId: string;
    role: string;
    createdAt: Date;
    space: { isDefault: boolean };
  }>;
  computers: Array<{ homeKey: string; kind: string; providerRef: string }>;
}> {
  const memberships = await db.spaceMember.findMany({
    where: { userId: input.userId },
    select: {
      spaceId: true,
      role: true,
      createdAt: true,
      space: { select: { isDefault: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!memberships.some((membership) => membership.spaceId === input.currentSpaceId)) {
    throw new IsolationError();
  }
  const targetMembership = memberships.find((membership) => membership.spaceId === input.spaceId);
  if (!targetMembership) throw new SpaceNotFoundError();
  if (targetMembership.role !== "owner") throw new CannotDeleteSpaceAsNonOwnerError();
  if (targetMembership.space.isDefault) throw new CannotDeleteDefaultSpaceError();
  if (memberships.length <= 1) throw new CannotDeleteLastSpaceError();
  // A removed person's bots and groups are hidden from the owner and go with the Space.
  const member = { userId: { in: await spaceMemberIds(db, input.spaceId) } };
  const [botCount, groupCount, computers] = await Promise.all([
    db.bot.count({ where: { spaceId: input.spaceId, ...member } }),
    db.chatGroup.count({ where: { spaceId: input.spaceId, ...member } }),
    db.computer.findMany({
      where: { spaceId: input.spaceId, providerRef: { not: null } },
      select: { homeKey: true, kind: true, providerRef: true },
    }),
  ]);
  if (botCount > 0 || groupCount > 0) throw new SpaceNotEmptyError();
  return {
    memberships,
    computers: computers.flatMap((computer) =>
      computer.providerRef
        ? [
            {
              homeKey: computer.homeKey,
              kind: computer.kind,
              providerRef: computer.providerRef,
            },
          ]
        : [],
    ),
  };
}

/** Claim an empty Space before external teardown.
 *
 * Content creation takes the same advisory lock and rejects a claimed Space,
 * so no bot or group can appear after this emptiness check. A stale claim may
 * be retried after five minutes if a process exits. Takeover is safe because
 * provider destroy is idempotent (missing remotes succeed), every worker
 * verifies its claim token before and after each destroy, provider-handle
 * clearing is conditioned on the claim token, and no worker releases its
 * claim after external teardown starts — so content can never be unblocked
 * while an old destroy may still be in flight. */
export async function claimEmptySpaceDeletionForMember(
  prisma: PrismaClient,
  input: EmptySpaceDeleteInput,
): Promise<{
  claimId: string;
  recovered: boolean;
  computers: Array<{ homeKey: string; kind: string; providerRef: string }>;
}> {
  const claimId = randomUUID();
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        const planned = await assertEmptySpaceDeletable(tx, input);
        const lifecycle = await tx.space.findUnique({
          where: { id: input.spaceId },
          select: { deletingAt: true },
        });
        const claimedBefore = new Date(Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS);
        const claimed = await tx.space.updateMany({
          where: {
            id: input.spaceId,
            OR: [{ deletingAt: null }, { deletingAt: { lt: claimedBefore } }],
          },
          data: { deletingAt: new Date(), deletionClaimId: claimId },
        });
        if (claimed.count === 0) throw new SpaceDeletionInProgressError();
        return {
          claimId,
          recovered: Boolean(lifecycle?.deletingAt),
          computers: planned.computers,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Renew an active claim while provider teardown is in flight. */
export async function renewSpaceDeletionClaim(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<boolean> {
  const renewed = await prisma.space.updateMany({
    where: {
      id: input.spaceId,
      deletionClaimId: input.claimId,
      memberships: { some: { userId: input.userId, role: "owner" } },
    },
    data: { deletingAt: new Date() },
  });
  return renewed.count === 1;
}

/** Release only this caller's deletion claim after teardown or validation fails. */
export async function releaseSpaceDeletionClaim(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<void> {
  await prisma.space.updateMany({
    where: {
      id: input.spaceId,
      deletionClaimId: input.claimId,
      memberships: { some: { userId: input.userId, role: "owner" } },
    },
    data: { deletingAt: null, deletionClaimId: null },
  });
}

/** Delete an empty, non-default privacy boundary.
 *
 * Only the SpaceMember owner may delete, and only empty spaces: bots
 * (including archived) and groups would otherwise orphan sandbox computers and
 * files that `destroyBot` cleans up per bot. Callers must destroy any leftover
 * team sandboxes and clear those providerRefs before invoking this so a failed
 * `sandbox.destroy` cannot lose the only persisted handle, and a failed delete
 * cannot leave a stale ref to a destroyed sandbox. Callers should surface
 * `SpaceNotEmptyError` as "delete its bots and groups first" so an empty space
 * is always deletable in two steps without an onboarding trap. Returns the
 * space the client should switch to when the active space was deleted (the
 * current space when deleting another; otherwise the default, else the oldest
 * remaining). */
export async function deleteEmptySpaceForMember(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<{ id: string }> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        const claim = await tx.space.findFirst({
          where: { id: input.spaceId, deletionClaimId: input.claimId },
          select: { id: true },
        });
        if (!claim) throw new SpaceDeletionInProgressError();
        const planned = await assertEmptySpaceDeletable(tx, input);
        await deleteOwnerVolumes(tx, { spaceId: input.spaceId });
        await tx.space.delete({ where: { id: input.spaceId } });
        if (input.spaceId !== input.currentSpaceId) {
          return { id: input.currentSpaceId };
        }
        const remaining = planned.memberships.filter(
          (membership) => membership.spaceId !== input.spaceId,
        );
        const fallback =
          remaining.find(
            (membership) => membership.space.isDefault && membership.role === "owner",
          ) ?? remaining[0];
        if (!fallback) throw new CannotDeleteLastSpaceError();
        return { id: fallback.spaceId };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export const SPACE_INVITATION_TTL_MS = 7 * 24 * 60 * 60_000;

export class NotSpaceOwnerError extends Error {
  constructor() {
    super("Only the space owner can manage members");
    this.name = "NotSpaceOwnerError";
  }
}

export class CannotRemoveSpaceOwnerError extends Error {
  constructor() {
    super("The space owner cannot be removed");
    this.name = "CannotRemoveSpaceOwnerError";
  }
}

export class SpaceInvitationUnavailableError extends Error {
  constructor() {
    super("This invite link has expired or was already used");
    this.name = "SpaceInvitationUnavailableError";
  }
}

export class SpaceInvitationForAnotherEmailError extends Error {
  constructor() {
    super("This invite is for another email");
    this.name = "SpaceInvitationForAnotherEmailError";
  }
}

export interface SpaceInvitationRow {
  /** Also the link token: the invite only works for the account with `email`. */
  id: string;
  email: string;
  expiresAt: Date;
}

const invitationRow = { id: true, email: true, expiresAt: true } as const;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function userEmail(
  db: Pick<PrismaClient, "user">,
  userId: string,
): Promise<string | undefined> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  return user ? normalizeEmail(user.email) : undefined;
}

async function requireSpaceOwner(
  db: Pick<PrismaClient, "spaceMember">,
  input: { spaceId: string; userId: string },
): Promise<{ organizationId: string }> {
  const membership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
    select: { organizationId: true, role: true },
  });
  if (!membership) throw new SpaceNotFoundError();
  if (membership.role !== "owner") throw new NotSpaceOwnerError();
  return { organizationId: membership.organizationId };
}

/**
 * Invite each email that is not already in the Space. Inviting an email again keeps its link
 * and restarts its expiry, so a link already sent keeps working.
 */
export async function createSpaceInvitations(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string; emails: string[] },
): Promise<SpaceInvitationRow[]> {
  await requireSpaceOwner(prisma, input);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SPACE_INVITATION_TTL_MS);
  const requested = [...new Set(input.emails.map(normalizeEmail))];
  const members = await prisma.spaceMember.findMany({
    where: {
      spaceId: input.spaceId,
      member: { user: { email: { in: requested, mode: "insensitive" } } },
    },
    select: { member: { select: { user: { select: { email: true } } } } },
  });
  const joined = new Set(members.map((row) => normalizeEmail(row.member.user.email)));
  const [, ...invitations] = await prisma.$transaction([
    prisma.spaceInvitation.deleteMany({
      where: { spaceId: input.spaceId, expiresAt: { lte: now } },
    }),
    ...requested
      .filter((email) => !joined.has(email))
      .map((email) =>
        prisma.spaceInvitation.upsert({
          where: { spaceId_email: { spaceId: input.spaceId, email } },
          create: {
            id: randomUUID(),
            spaceId: input.spaceId,
            createdByUserId: input.userId,
            email,
            expiresAt,
            createdAt: now,
          },
          update: { expiresAt },
          select: invitationRow,
        }),
      ),
  ]);
  return invitations;
}

export async function revokeSpaceInvitation(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string; invitationId: string },
): Promise<void> {
  await requireSpaceOwner(prisma, input);
  await prisma.spaceInvitation.deleteMany({
    where: { id: input.invitationId, spaceId: input.spaceId },
  });
}

/** What the accept screen shows before the person commits; null once the link is spent. */
export async function previewSpaceInvitation(
  prisma: PrismaClient,
  input: { token: string; userId: string },
): Promise<{ spaceName: string; inviterName: string; email: string; forYou: boolean } | null> {
  const invitation = await prisma.spaceInvitation.findUnique({
    where: { id: input.token },
    select: {
      email: true,
      expiresAt: true,
      space: { select: { name: true } },
      createdByUser: { select: { name: true } },
    },
  });
  if (!invitation || invitation.expiresAt <= new Date()) return null;
  return {
    spaceName: invitation.space.name,
    inviterName: invitation.createdByUser.name,
    email: invitation.email,
    forYou: (await userEmail(prisma, input.userId)) === invitation.email,
  };
}

/**
 * Consume a live link and join its Space, only as the account with the invited email.
 * A person already in the Space keeps the link unspent.
 */
export async function acceptSpaceInvitation(
  prisma: PrismaClient,
  input: { token: string; userId: string },
): Promise<{ spaceId: string }> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const now = new Date();
        const invitation = await tx.spaceInvitation.findUnique({
          where: { id: input.token },
          select: {
            spaceId: true,
            email: true,
            space: { select: { organizationId: true } },
          },
        });
        if (!invitation) throw new SpaceInvitationUnavailableError();
        if ((await userEmail(tx, input.userId)) !== invitation.email) {
          throw new SpaceInvitationForAnotherEmailError();
        }
        const { spaceId } = invitation;
        const { organizationId } = invitation.space;
        const existing = await tx.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId, userId: input.userId } },
          select: { id: true },
        });
        if (existing) return { spaceId };
        const consumed = await tx.spaceInvitation.deleteMany({
          where: { id: input.token, expiresAt: { gt: now } },
        });
        if (consumed.count !== 1) throw new SpaceInvitationUnavailableError();
        await tx.member.upsert({
          where: {
            organizationId_userId: { organizationId, userId: input.userId },
          },
          create: {
            id: randomUUID(),
            organizationId,
            userId: input.userId,
            role: "member",
            createdAt: now,
          },
          update: {},
        });
        await tx.spaceMember.create({
          data: {
            id: randomUUID(),
            spaceId,
            organizationId,
            userId: input.userId,
            role: "member",
            createdAt: now,
          },
        });
        await createSpaceDefaults(tx, {
          spaceId,
          userId: input.userId,
          memoryContent: "# Space memory\n\n",
        });
        const home = await tx.spaceMember.findFirst({
          where: {
            userId: input.userId,
            role: "owner",
            space: { isDefault: true },
          },
          orderBy: { createdAt: "asc" },
          select: { spaceId: true },
        });
        if (home) {
          await copyProviderPreferences(tx, {
            sourceSpaceId: home.spaceId,
            targetSpaceId: spaceId,
            userId: input.userId,
            createdAt: now,
          });
        }
        return { spaceId };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export interface SpaceMembersView {
  members: Array<{
    userId: string;
    name: string;
    image: string | null;
    isOwner: boolean;
  }>;
  /** Live invites, listed only for the owner. */
  invitations: SpaceInvitationRow[];
}

export async function listSpaceMembers(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string },
): Promise<SpaceMembersView> {
  const memberships = await prisma.spaceMember.findMany({
    where: { spaceId: input.spaceId },
    select: {
      userId: true,
      role: true,
      member: { select: { user: { select: { name: true, image: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });
  const caller = memberships.find((membership) => membership.userId === input.userId);
  if (!caller) throw new SpaceNotFoundError();
  const invitations =
    caller.role === "owner"
      ? await prisma.spaceInvitation.findMany({
          where: { spaceId: input.spaceId, expiresAt: { gt: new Date() } },
          select: invitationRow,
          // Invites sent together share createdAt.
          orderBy: [{ createdAt: "asc" }, { email: "asc" }],
        })
      : [];
  return {
    members: memberships.map((membership) => ({
      userId: membership.userId,
      name: membership.member.user.name,
      image: membership.member.user.image,
      isOwner: membership.role === "owner",
    })),
    invitations,
  };
}

export async function removeSpaceMember(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string; memberUserId: string },
): Promise<void> {
  const { organizationId } = await requireSpaceOwner(prisma, input);
  await prisma.$transaction(async (tx) => {
    // Bot creation holds this lock while it checks membership, so none can land after the archive.
    await lockSpaceDeletion(tx, input.spaceId);
    const target = await tx.spaceMember.findUnique({
      where: {
        spaceId_userId: { spaceId: input.spaceId, userId: input.memberUserId },
      },
      select: { role: true },
    });
    if (!target) return;
    if (target.role === "owner") throw new CannotRemoveSpaceOwnerError();
    await tx.spaceMember.delete({
      where: {
        spaceId_userId: { spaceId: input.spaceId, userId: input.memberUserId },
      },
    });
    // Archived, not deleted: archived bots claim no run, webhooks and channels included. Their
    // rows go with the Space.
    const leftovers = { spaceId: input.spaceId, userId: input.memberUserId };
    const archivedBots = await tx.bot.updateManyAndReturn({
      where: { ...leftovers, archivedAt: null },
      data: { archivedAt: new Date() },
      select: { id: true },
    });
    await archiveGroupsLeftWithoutBots(tx, {
      botIds: archivedBots.map((bot) => bot.id),
      ownerId: input.memberUserId,
    });
    await tx.routine.updateMany({ where: leftovers, data: { active: false, nextRunAt: null } });
    // Their threads with bots shared with them stay, hidden: membership gates access to them.
    await tx.botShare.deleteMany({
      where: { userId: input.memberUserId, bot: { spaceId: input.spaceId } },
    });
    // They leave the Space's groups too, and the runs they started in them stop below.
    await tx.chatGroupPerson.deleteMany({
      where: { userId: input.memberUserId, group: { spaceId: input.spaceId } },
    });
    // Archiving only stops new claims; a run already going would keep the Space's secrets.
    const activeRuns = await tx.run.findMany({
      where: {
        OR: [
          { bot: leftovers },
          { thread: { ...leftovers, memberBotId: { not: null } } },
          { ...leftovers, thread: { groupId: { not: null } } },
        ],
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      select: { id: true, taskId: true },
    });
    await cancelRunsInTransaction(tx, activeRuns, new Date());
    // A cancelled run waiting on a screen gives its computer back at once.
    await expireComputerExecutionLeases(tx, { runId: { in: activeRuns.map((run) => run.id) } });
    await tx.member.deleteMany({
      where: {
        organizationId,
        userId: input.memberUserId,
        role: { not: "owner" },
        spaceMemberships: { none: {} },
      },
    });
  });
}
