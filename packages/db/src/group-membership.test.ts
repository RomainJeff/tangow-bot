import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapUserSpace } from "./bootstrap-user.js";
import type { PrismaClient } from "./client.js";
import { createGroupRepos } from "./groups.js";
import { openPgliteDatabase, type PgliteDatabase } from "./pglite.test-support.js";
import { createRepos } from "./repos.js";
import { IsolationError } from "./scope.js";
import { acceptSpaceInvitation, createSpaceForMember, createSpaceInvitation } from "./spaces.js";

const env = { signupsEnabled: "true", signupAllowlist: undefined };

describe("people in a group", () => {
  let database: PgliteDatabase;
  let prisma: PrismaClient;
  let space: string;
  let groupId: string;

  const actor = (userId: string) => ({
    userId,
    spaceId: space,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  });

  beforeAll(async () => {
    database = await openPgliteDatabase();
    prisma = database.prisma;
    for (const id of ["creator", "person", "outsider"]) {
      await prisma.user.create({ data: { id, name: id, email: `${id}@rakazo.test` } });
    }
    const home = (await bootstrapUserSpace(prisma, { id: "creator" }, env)).spaceId;
    for (const id of ["person", "outsider"]) await bootstrapUserSpace(prisma, { id }, env);
    space = (
      await createSpaceForMember(prisma, { currentSpaceId: home, userId: "creator", name: "Team" })
    ).id;
    for (const id of ["person", "outsider"]) {
      const { token } = await createSpaceInvitation(prisma, { spaceId: space, userId: "creator" });
      await acceptSpaceInvitation(prisma, { token, userId: id });
    }
    const bot = await createRepos(prisma).createBot(actor("creator"), {
      name: "Helper",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    groupId = (
      await createGroupRepos(prisma).createGroup(actor("creator"), {
        name: "Crew",
        botIds: [bot.id],
      })
    ).id;
    await prisma.chatGroupPerson.create({ data: { groupId, userId: "person" } });
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  it("opens the group to its people and to no one else in the Space", async () => {
    const groups = createGroupRepos(prisma);
    await expect(groups.getGroupTarget(actor("person"), groupId)).resolves.toMatchObject({
      id: groupId,
    });
    expect((await groups.listGroups(actor("person"))).map((group) => group.id)).toEqual([groupId]);
    await expect(groups.getGroupTarget(actor("outsider"), groupId)).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(await groups.listGroups(actor("outsider"))).toEqual([]);
  });

  it("lets a person pin it for themselves but leaves changing it to its creator", async () => {
    const groups = createGroupRepos(prisma);
    const pinned = await groups.updateGroup(actor("person"), { groupId, pinned: true });
    expect(pinned.group.pinned).toBe(true);
    expect((await groups.listGroups(actor("creator")))[0]?.pinned).toBe(false);

    await expect(
      groups.updateGroup(actor("person"), { groupId, name: "Renamed" }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(groups.archiveGroup(actor("person"), groupId)).rejects.toBeInstanceOf(
      IsolationError,
    );
    await expect(groups.removeGroup(actor("person"), groupId)).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect((await groups.getGroupTarget(actor("creator"), groupId)).name).toBe("Crew");
  });
});
