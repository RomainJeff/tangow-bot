import type { ArtifactStore, SessionEntryDraft } from "@rakazo/adapter-kit";
import type { LinkPreviewCard, MessageBlock } from "@rakazo/contracts";
import { EntryId, SessionId } from "@rakazo/contracts";
import {
  appendRunBlocksInTransaction,
  appendSessionEntryInTransaction,
  type PrismaClient,
} from "@rakazo/db";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";

/**
 * A Postgres for the tests of what reads and writes a thread's messages: PGlite with the
 * migrations applied, emptied between tests, and an in-memory artifact store. Offline and
 * deterministic; PGlite runs one transaction at a time, so concurrent writers serialize.
 */
export interface ThreadDb {
  prisma: PrismaClient;
  artifacts: ArtifactStore & { keys(): string[] };
  reset(): Promise<void>;
  close(): Promise<void>;
  seedThread(input: {
    id: string;
    spaceId?: string;
    userId?: string;
    botId?: string;
    /** A group thread, its members in order. */
    group?: { id: string; memberBotIds: string[] };
  }): Promise<void>;
  /** A person's message, or a bot's words outside any run. */
  seedMessage(input: {
    id: string;
    threadId: string;
    blocks: MessageBlock[];
    from?: { botId: string };
    /** Brought in by an external channel. */
    external?: true;
  }): Promise<void>;
  /** A run and the messages it sent, written while it ran, then its final status. */
  seedRun(input: {
    id: string;
    threadId: string;
    botId?: string;
    status?: string;
    trigger?: string;
    updatedAt?: Date;
    messages?: Array<{ id: string; blocks: MessageBlock[]; midTurn?: true; toPerson?: true }>;
  }): Promise<void>;
  /** The preview a message shows now, and whether one was ever removed or refused. */
  previewOf(messageId: string): Promise<{ card?: LinkPreviewCard; removed: boolean }>;
}

export async function openThreadDb(): Promise<ThreadDb> {
  const database = await openPgliteDatabase();
  const { prisma } = database;
  const store = new Map<string, Uint8Array>();
  let blobs = 0;
  const artifacts: ThreadDb["artifacts"] = {
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { stream: false },
    }),
    async put(artifact) {
      const id = `blob-${++blobs}`;
      store.set(id, artifact.bytes);
      return { id, hash: String(artifact.bytes.byteLength) };
    },
    async get(id) {
      const bytes = store.get(id);
      if (!bytes) throw new Error("ENOENT");
      return bytes;
    },
    async remove(id) {
      store.delete(id);
    },
    keys: () => [...store.keys()],
  };
  const tables = (
    await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
  ).map(({ tablename }) => `"${tablename}"`);

  async function owner(spaceId: string, userId: string) {
    await prisma.user.upsert({
      where: { id: userId },
      create: { id: userId, name: userId, email: `${userId}@rakazo.test` },
      update: {},
    });
    const organizationId = `org-${spaceId}`;
    await prisma.organization.upsert({
      where: { id: organizationId },
      create: { id: organizationId, name: spaceId, slug: organizationId, createdAt: new Date() },
      update: {},
    });
    await prisma.space.upsert({
      where: { id: spaceId },
      create: { id: spaceId, organizationId, name: spaceId },
      update: {},
    });
  }

  async function bot(id: string, spaceId: string, userId: string) {
    await prisma.bot.upsert({
      where: { id },
      create: { id, spaceId, userId, name: id, color: "#00C46A" },
      update: {},
    });
  }

  /** The thread, its main session, and the bot its feed shows a person's message under. */
  async function sessionOf(threadId: string) {
    const thread = await prisma.thread.findUniqueOrThrow({
      where: { id: threadId },
      include: { group: { include: { members: { orderBy: { createdAt: "asc" }, take: 1 } } } },
    });
    const feedBotId = thread.botId ?? thread.group?.members[0]?.botId;
    if (!feedBotId) throw new Error(`Thread ${threadId} has no bot`);
    return { ...thread, feedBotId, sessionId: SessionId.parse(thread.sessionId) };
  }

  return {
    prisma,
    artifacts,
    async reset() {
      await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(", ")} CASCADE`);
      store.clear();
    },
    close: () => database.close(),
    async seedThread({ id, spaceId = "space-1", userId = "user-1", botId = "bot-1", group }) {
      await owner(spaceId, userId);
      if (group) {
        await prisma.chatGroup.create({ data: { id: group.id, spaceId, userId, name: group.id } });
        for (const [index, memberId] of group.memberBotIds.entries()) {
          await bot(memberId, spaceId, userId);
          await prisma.chatGroupMember.create({
            data: { groupId: group.id, botId: memberId, createdAt: new Date(index) },
          });
        }
        await prisma.thread.create({ data: { id, spaceId, userId, groupId: group.id } });
        return;
      }
      await bot(botId, spaceId, userId);
      await prisma.thread.create({ data: { id, spaceId, userId, botId } });
    },
    async seedMessage({ id, threadId, blocks, from, external }) {
      const thread = await sessionOf(threadId);
      await prisma.$transaction((tx) =>
        appendSessionEntryInTransaction(tx, {
          id: EntryId.parse(id),
          sessionId: thread.sessionId,
          ...(from
            ? { type: "bot.text", botId: from.botId, payload: { blocks } }
            : {
                type: "user.message",
                feedBotId: thread.feedBotId,
                payload: { blocks, source: external ? "channel" : "app" },
              }),
        } as SessionEntryDraft),
      );
      if (!external) return;
      const conversation = await prisma.externalConversation.create({
        data: {
          provider: "slack",
          workspaceId: "T1",
          externalKey: `channel:${id}`,
          conversationId: "C1",
          spaceId: thread.spaceId,
          botId: thread.feedBotId,
          userId: thread.userId,
        },
      });
      await prisma.externalMessage.create({
        data: {
          externalConversationId: conversation.id,
          providerEventId: id,
          senderId: "U1",
          senderName: "Ada",
          content: "",
          threadMessageId: id,
        },
      });
    },
    async seedRun({
      id,
      threadId,
      botId,
      status = "completed",
      trigger = "user",
      updatedAt,
      messages = [],
    }) {
      const thread = await sessionOf(threadId);
      const runBotId = botId ?? thread.feedBotId;
      const task = await prisma.task.create({
        data: {
          spaceId: thread.spaceId,
          botId: runBotId,
          threadId,
          userId: thread.userId,
          prompt: "",
          status: "running",
        },
      });
      await prisma.run.create({
        data: {
          id,
          spaceId: thread.spaceId,
          botId: runBotId,
          threadId,
          taskId: task.id,
          userId: thread.userId,
          status: "running",
          trigger,
        },
      });
      for (const { id: messageId, blocks, midTurn, toPerson } of messages) {
        await prisma.$transaction((tx) =>
          appendRunBlocksInTransaction(
            tx,
            {
              id: messageId,
              runId: id,
              botId: runBotId,
              ...(midTurn ? { midTurn } : {}),
              ...(toPerson ? { toPerson } : {}),
            },
            blocks,
          ),
        );
      }
      await prisma.run.update({
        where: { id },
        data: { status, ...(updatedAt ? { updatedAt } : {}) },
      });
    },
    async previewOf(messageId) {
      const previews = await prisma.sessionEntry.findMany({
        where: { type: "link.preview", payload: { path: ["target"], equals: messageId } },
        orderBy: { seq: "asc" },
        select: { id: true, payload: true },
      });
      const removals = await prisma.sessionEntry.findMany({
        where: {
          type: "link.preview.removed",
          OR: [messageId, ...previews.map((preview) => preview.id)].map((target) => ({
            payload: { path: ["target"], equals: target },
          })),
        },
        select: { payload: true },
      });
      const removed = new Set(removals.map((row) => (row.payload as { target: string }).target));
      const shown = previews.findLast((preview) => !removed.has(preview.id));
      return {
        ...(shown ? { card: (shown.payload as { block: LinkPreviewCard }).block } : {}),
        removed: removed.size > 0,
      };
    },
  };
}
