import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapUserSpace } from "./bootstrap-user.js";
import type { PrismaClient } from "./client.js";
import { openPgliteDatabase, type PgliteDatabase } from "./pglite.test-support.js";
import {
  acceptSpaceInvitation,
  CannotRemoveSpaceOwnerError,
  createSpaceForMember,
  createSpaceInvitations,
  listSpaceMembers,
  NotSpaceOwnerError,
  previewSpaceInvitation,
  removeSpaceMember,
  revokeSpaceInvitation,
  SpaceInvitationForAnotherEmailError,
  SpaceInvitationUnavailableError,
} from "./spaces.js";

const env = { signupsEnabled: "true", signupAllowlist: undefined };

describe("Space invite links", () => {
  let database: PgliteDatabase;
  let prisma: PrismaClient;
  let ownerHome: string;
  let shared: string;
  let guestHome: string;

  async function user(id: string, name: string): Promise<string> {
    await prisma.user.create({
      data: { id, name, email: `${id}@rakazo.test` },
    });
    return (await bootstrapUserSpace(prisma, { id }, env)).spaceId;
  }

  async function invite(email: string): Promise<string> {
    const [invitation] = await createSpaceInvitations(prisma, {
      spaceId: shared,
      userId: "owner",
      emails: [email],
    });
    return invitation!.id;
  }

  async function spaceIdsOf(userId: string): Promise<string[]> {
    const rows = await prisma.spaceMember.findMany({
      where: { userId },
      select: { spaceId: true },
    });
    return rows.map((row) => row.spaceId).sort();
  }

  beforeAll(async () => {
    database = await openPgliteDatabase();
    prisma = database.prisma;
    ownerHome = await user("owner", "Ada");
    guestHome = await user("guest", "Grace");
    await user("stranger", "Sam");
    shared = (
      await createSpaceForMember(prisma, {
        currentSpaceId: ownerHome,
        userId: "owner",
        name: "Family",
      })
    ).id;
    const credential = await prisma.userModelCredential.create({
      data: {
        userId: "guest",
        provider: "test",
        label: "Test",
        secretId: "fake-secret",
      },
    });
    await prisma.spaceModelPreference.create({
      data: {
        spaceId: guestHome,
        userId: "guest",
        credentialId: credential.id,
        modelId: "test/model",
        isDefault: true,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  it("joins only the invited Space, once, as the invited email, with the guest's own model", async () => {
    const token = await invite(" Guest@Rakazo.test");
    await expect(previewSpaceInvitation(prisma, { token, userId: "stranger" })).resolves.toEqual({
      spaceName: "Family",
      inviterName: "Ada",
      email: "guest@rakazo.test",
      forYou: false,
    });
    await expect(acceptSpaceInvitation(prisma, { token, userId: "stranger" })).rejects.toThrow(
      SpaceInvitationForAnotherEmailError,
    );

    await expect(acceptSpaceInvitation(prisma, { token, userId: "guest" })).resolves.toEqual({
      spaceId: shared,
    });
    expect(await spaceIdsOf("guest")).toEqual([guestHome, shared].sort());
    const preference = await prisma.spaceModelPreference.findFirst({
      where: { spaceId: shared, userId: "guest" },
      select: { modelId: true, isDefault: true },
    });
    expect(preference).toEqual({ modelId: "test/model", isDefault: true });

    await expect(previewSpaceInvitation(prisma, { token, userId: "guest" })).resolves.toBeNull();
    expect(await spaceIdsOf("stranger")).toHaveLength(1);
  });

  it("refuses expired and revoked links, and extends a re-invited email's link", async () => {
    const token = await invite("stranger@rakazo.test");
    await prisma.spaceInvitation.update({
      where: { id: token },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(acceptSpaceInvitation(prisma, { token, userId: "stranger" })).rejects.toThrow(
      SpaceInvitationUnavailableError,
    );

    const live = await invite("stranger@rakazo.test");
    expect(live).not.toBe(token);
    await prisma.spaceInvitation.update({
      where: { id: live },
      data: { expiresAt: new Date(Date.now() + 1000) },
    });
    expect(await invite("STRANGER@rakazo.test")).toBe(live);
    const [extended] = (await listSpaceMembers(prisma, { spaceId: shared, userId: "owner" }))
      .invitations;
    expect(extended!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 60_000);

    await revokeSpaceInvitation(prisma, { spaceId: shared, userId: "owner", invitationId: live });
    await expect(
      acceptSpaceInvitation(prisma, { token: live, userId: "stranger" }),
    ).rejects.toThrow(SpaceInvitationUnavailableError);
    expect(await spaceIdsOf("stranger")).toHaveLength(1);
  });

  it("invites several emails at once and skips people already in", async () => {
    const invitations = await createSpaceInvitations(prisma, {
      spaceId: shared,
      userId: "owner",
      emails: ["guest@rakazo.test", "new-1@rakazo.test", "new-2@rakazo.test", "New-1@rakazo.test"],
    });
    expect(invitations.map((invitation) => invitation.email)).toEqual([
      "new-1@rakazo.test",
      "new-2@rakazo.test",
    ]);
    const view = await listSpaceMembers(prisma, { spaceId: shared, userId: "owner" });
    expect(view.invitations.map((invitation) => invitation.email)).toEqual([
      "new-1@rakazo.test",
      "new-2@rakazo.test",
    ]);
    for (const { id } of invitations) {
      await revokeSpaceInvitation(prisma, { spaceId: shared, userId: "owner", invitationId: id });
    }
  });

  it("lets only the owner manage members and invite links", async () => {
    await expect(
      createSpaceInvitations(prisma, {
        spaceId: shared,
        userId: "guest",
        emails: ["stranger@rakazo.test"],
      }),
    ).rejects.toThrow(NotSpaceOwnerError);
    await expect(
      removeSpaceMember(prisma, {
        spaceId: shared,
        userId: "guest",
        memberUserId: "owner",
      }),
    ).rejects.toThrow(NotSpaceOwnerError);
    await expect(
      removeSpaceMember(prisma, {
        spaceId: shared,
        userId: "owner",
        memberUserId: "owner",
      }),
    ).rejects.toThrow(CannotRemoveSpaceOwnerError);

    const guestView = await listSpaceMembers(prisma, {
      spaceId: shared,
      userId: "guest",
    });
    expect(guestView).toEqual({
      members: [
        { userId: "owner", name: "Ada", image: null, isOwner: true },
        { userId: "guest", name: "Grace", image: null, isOwner: false },
      ],
      invitations: [],
    });
  });

  it("creates the guest's new Spaces in their own organization", async () => {
    const created = await createSpaceForMember(prisma, {
      currentSpaceId: shared,
      userId: "guest",
      name: "Mine",
    });
    const space = await prisma.space.findUniqueOrThrow({
      where: { id: created.id },
      select: { organizationId: true },
    });
    expect(space.organizationId).toBe(guestHome);
  });

  it("removes a member and lets them rejoin with a new link", async () => {
    await removeSpaceMember(prisma, {
      spaceId: shared,
      userId: "owner",
      memberUserId: "guest",
    });
    expect(await spaceIdsOf("guest")).not.toContain(shared);

    const token = await invite("guest@rakazo.test");
    await expect(acceptSpaceInvitation(prisma, { token, userId: "guest" })).resolves.toEqual({
      spaceId: shared,
    });
    expect(await spaceIdsOf("guest")).toContain(shared);
    expect(
      await prisma.memoryDocument.count({
        where: { spaceId: shared, userId: "guest", scope: "user", path: "MEMORY.md" },
      }),
    ).toBe(1);
  });
});
