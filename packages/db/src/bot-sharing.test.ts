import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapUserSpace } from "./bootstrap-user.js";
import { getBotSharing, setBotSharing, sharedBotThread } from "./bot-sharing.js";
import type { PrismaClient } from "./client.js";
import { openPgliteDatabase, type PgliteDatabase } from "./pglite.test-support.js";
import { createRepos } from "./repos.js";
import { IsolationError } from "./scope.js";
import {
  acceptSpaceInvitation,
  createSpaceForMember,
  createSpaceInvitations,
  removeSpaceMember,
} from "./spaces.js";

const env = { signupsEnabled: "true", signupAllowlist: undefined };

describe("sharing a bot", () => {
  let database: PgliteDatabase;
  let prisma: PrismaClient;
  let space: string;
  let botId: string;
  let ownerThreadId: string;

  const actor = (userId: string) => ({
    userId,
    spaceId: space,
    email: `${userId}@tangow.test`,
    isDeploymentOwner: false,
  });
  /** A run going in a person's thread with the bot. */
  const startRun = async (userId: string, threadId: string) => {
    const owned = { spaceId: space, botId, threadId, userId };
    const task = await prisma.task.create({
      data: { ...owned, prompt: "Work", status: "running" },
    });
    return prisma.run.create({
      data: { ...owned, taskId: task.id, status: "running", trigger: "user" },
    });
  };
  const listed = async (userId: string) =>
    (await createRepos(prisma).listBots(actor(userId))).find((bot) => bot.id === botId);

  beforeAll(async () => {
    database = await openPgliteDatabase();
    prisma = database.prisma;
    for (const id of ["owner", "dana", "sam"]) {
      await prisma.user.create({ data: { id, name: id, email: `${id}@tangow.test` } });
      await bootstrapUserSpace(prisma, { id }, env);
    }
    const ownerHome = (await prisma.spaceMember.findFirstOrThrow({ where: { userId: "owner" } }))
      .spaceId;
    space = (
      await createSpaceForMember(prisma, {
        currentSpaceId: ownerHome,
        userId: "owner",
        name: "Team",
      })
    ).id;
    for (const userId of ["dana", "sam"]) {
      const [invitation] = await createSpaceInvitations(prisma, {
        spaceId: space,
        userId: "owner",
        emails: [`${userId}@tangow.test`],
      });
      await acceptSpaceInvitation(prisma, { token: invitation!.id, userId });
    }
  }, 60_000);

  beforeEach(async () => {
    const bot = await createRepos(prisma).createBot(actor("owner"), {
      name: "Release notes",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    botId = bot.id;
    ownerThreadId = bot.threadId;
  });

  afterAll(async () => {
    await database?.close();
  });

  it("gives everyone in the Space their own thread and leaves the owner's alone", async () => {
    await setBotSharing(prisma, actor("owner"), { botId, visibility: "space", userIds: [] });

    const dana = await listed("dana");
    const sam = await listed("sam");
    expect(dana).toMatchObject({ isOwner: false, pinned: false, sectionId: null });
    expect(new Set([dana?.threadId, sam?.threadId, ownerThreadId]).size).toBe(3);
    expect((await sharedBotThread(prisma, actor("dana"), botId))?.thread.id).toBe(dana?.threadId);
    expect(await listed("owner")).toMatchObject({ isOwner: true, threadId: ownerThreadId });
    expect(await prisma.thread.findUniqueOrThrow({ where: { id: ownerThreadId } })).toMatchObject({
      botId,
      memberBotId: null,
      userId: "owner",
    });
  });

  it("hides the thread of someone unshared and stops their runs, in groups too", async () => {
    await setBotSharing(prisma, actor("owner"), { botId, visibility: "people", userIds: ["dana"] });
    const target = await sharedBotThread(prisma, actor("dana"), botId);
    const run = await startRun("dana", target!.thread.id);
    const group = await prisma.chatGroup.create({
      data: {
        spaceId: space,
        userId: "owner",
        name: "Crew",
        members: { create: { botId } },
        people: { create: [{ userId: "owner" }, { userId: "dana" }] },
      },
    });
    const groupThread = await prisma.thread.create({
      data: { spaceId: space, userId: "owner", groupId: group.id },
    });
    const groupRun = await startRun("dana", groupThread.id);
    const ownerRun = await startRun("owner", groupThread.id);

    await setBotSharing(prisma, actor("owner"), {
      botId,
      visibility: "private",
      userIds: ["dana"],
    });

    expect(await listed("dana")).toBeUndefined();
    expect(await sharedBotThread(prisma, actor("dana"), botId)).toBeNull();
    expect(await prisma.thread.findUnique({ where: { id: target!.thread.id } })).not.toBeNull();
    const status = async (runId: string) =>
      (await prisma.run.findUniqueOrThrow({ where: { id: runId } })).status;
    expect([await status(run.id), await status(groupRun.id), await status(ownerRun.id)]).toEqual([
      "cancelled",
      "cancelled",
      "running",
    ]);
    expect(await prisma.botShare.findMany({ where: { botId } })).toEqual([]);
  });

  it("declares no app until its owner does, and keeps them when a share leaves them out", async () => {
    const gmail = { kind: "app" as const, connectorId: "composio", provider: "gmail" };
    expect(await getBotSharing(prisma, actor("owner"), botId)).toMatchObject({ connectors: [] });

    await setBotSharing(prisma, actor("owner"), {
      botId,
      visibility: "space",
      userIds: [],
      connectors: [gmail],
    });
    await setBotSharing(prisma, actor("owner"), { botId, visibility: "people", userIds: ["dana"] });

    expect(await getBotSharing(prisma, actor("owner"), botId)).toEqual({
      visibility: "people",
      userIds: ["dana"],
      connectors: [gmail],
    });
  });

  it("declares only the MCP servers its owner gave it, and keeps one its owner deleted", async () => {
    const server = async (userId: string, slug: string, given = true) => {
      const row = await prisma.mcpServer.create({
        data: { spaceId: space, userId, slug, name: slug, transport: "streamable_http" },
      });
      if (given) {
        await prisma.botMcpServer.create({
          data: { spaceId: space, userId, botId, serverId: row.id },
        });
      }
      return row;
    };
    const mine = await server("owner", `linear-${botId}`);
    const notGiven = await server("owner", `github-${botId}`, false);
    const danas = await server("dana", `notion-${botId}`);
    const share = (serverIds: string[]) =>
      setBotSharing(prisma, actor("owner"), {
        botId,
        visibility: "space",
        userIds: [],
        connectors: serverIds.map((serverId) => ({ kind: "mcp" as const, serverId })),
      });

    await expect(share([danas.id])).rejects.toBeInstanceOf(IsolationError);
    await expect(share([notGiven.id])).rejects.toBeInstanceOf(IsolationError);
    await share([mine.id]);
    await prisma.mcpServer.delete({ where: { id: mine.id } });
    await setBotSharing(prisma, actor("owner"), { botId, visibility: "people", userIds: ["dana"] });
    await expect(share([mine.id])).resolves.toMatchObject({
      connectors: [{ kind: "mcp", serverId: mine.id }],
    });
  });

  it("drops the access of a removed member, stops their runs and keeps their thread", async () => {
    await setBotSharing(prisma, actor("owner"), { botId, visibility: "people", userIds: ["sam"] });
    const threadId = (await listed("sam"))!.threadId;
    const run = await startRun("sam", threadId);

    await removeSpaceMember(prisma, { spaceId: space, userId: "owner", memberUserId: "sam" });

    expect(await prisma.botShare.findMany({ where: { botId } })).toEqual([]);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "cancelled",
    );
    expect(await prisma.thread.findUnique({ where: { id: threadId } })).not.toBeNull();
  });
});
