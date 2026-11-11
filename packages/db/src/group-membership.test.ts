import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapUserSpace } from "./bootstrap-user.js";
import type { PrismaClient } from "./client.js";
import { createGroupRepos, groupThreadPeople } from "./groups.js";
import { createThreadMessage } from "./messages.js";
import { openPgliteDatabase, type PgliteDatabase } from "./pglite.test-support.js";
import { createRepos } from "./repos.js";
import { IsolationError } from "./scope.js";
import { acceptSpaceInvitation, createSpaceForMember, createSpaceInvitations } from "./spaces.js";

const env = { signupsEnabled: "true", signupAllowlist: undefined };

describe("people in a group", () => {
  let database: PgliteDatabase;
  let prisma: PrismaClient;
  let space: string;
  let groupId: string;
  let botId: string;

  const actor = (userId: string) => ({
    userId,
    spaceId: space,
    email: `${userId}@tangow.test`,
    isDeploymentOwner: false,
  });

  beforeAll(async () => {
    database = await openPgliteDatabase();
    prisma = database.prisma;
    for (const id of ["creator", "person", "outsider"]) {
      await prisma.user.create({ data: { id, name: id, email: `${id}@tangow.test` } });
    }
    const home = (await bootstrapUserSpace(prisma, { id: "creator" }, env)).spaceId;
    for (const id of ["person", "outsider"]) await bootstrapUserSpace(prisma, { id }, env);
    space = (
      await createSpaceForMember(prisma, { currentSpaceId: home, userId: "creator", name: "Team" })
    ).id;
    for (const id of ["person", "outsider"]) {
      const [invitation] = await createSpaceInvitations(prisma, {
        spaceId: space,
        userId: "creator",
        emails: [`${id}@tangow.test`],
      });
      await acceptSpaceInvitation(prisma, { token: invitation!.id, userId: id });
    }
    const bot = await createRepos(prisma).createBot(actor("creator"), {
      name: "Helper",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    botId = bot.id;
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

  it("marks a person's message unread for the group's other people, not for its writer", async () => {
    const thread = await prisma.thread.findUniqueOrThrow({ where: { groupId } });
    await prisma.chatGroupPerson.updateMany({ where: { groupId }, data: { unread: false } });
    const entry = await createThreadMessage(prisma, {
      threadId: thread.id,
      role: "user",
      blocks: [{ kind: "text", text: "Hello" }],
      authorId: "person",
      feedBotId: botId,
    });
    expect(entry.payload).toMatchObject({ authorId: "person" });
    const marks = await prisma.chatGroupPerson.findMany({
      where: { groupId },
      select: { userId: true, unread: true },
      orderBy: { userId: "asc" },
    });
    expect(marks).toEqual([
      { userId: "creator", unread: true },
      { userId: "person", unread: false },
    ]);
  });

  it("still names someone who wrote in the group after they leave it", async () => {
    const thread = await prisma.thread.findUniqueOrThrow({ where: { groupId } });
    await prisma.chatGroupPerson.create({ data: { groupId, userId: "outsider" } });
    await createThreadMessage(prisma, {
      threadId: thread.id,
      role: "user",
      blocks: [{ kind: "text", text: "Bye" }],
      authorId: "outsider",
      feedBotId: botId,
    });
    await prisma.chatGroupPerson.delete({
      where: { groupId_userId: { groupId, userId: "outsider" } },
    });
    const people = await groupThreadPeople(prisma, { groupId, sessionId: thread.sessionId });
    expect(people.map((person) => person.userId)).toEqual(["creator", "person", "outsider"]);
  });

  it("keeps an archived group whose last bot was deleted for its creator to delete", async () => {
    const groups = createGroupRepos(prisma);
    const lone = await groups.createGroup(actor("creator"), { name: "Orphan", botIds: [botId] });
    // What deleting a bot shared with the creator leaves: no bot, archived, history kept.
    await prisma.chatGroupMember.deleteMany({ where: { groupId: lone.id } });
    await prisma.chatGroup.update({ where: { id: lone.id }, data: { archivedAt: new Date() } });

    const archived = await groups.listGroups(actor("creator"), { archived: true });
    expect(archived.find((group) => group.id === lone.id)?.members).toEqual([]);
    await expect(groups.restoreGroup(actor("creator"), lone.id)).rejects.toBeInstanceOf(
      IsolationError,
    );
    await expect(groups.removeGroup(actor("creator"), lone.id)).resolves.toEqual({
      contextBotId: undefined,
      artifactStorageKeys: [],
    });
  });
});
