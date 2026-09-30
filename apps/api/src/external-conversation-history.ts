import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { loadMessagePage } from "./thread-message-pages.js";

export async function externalConversationHistory(
  prisma: PrismaClient,
  actor: Actor,
  input: { externalConversationId: string; before?: number },
) {
  const conversation = await prisma.externalConversation.findFirst({
    where: {
      id: input.externalConversationId,
      spaceId: actor.spaceId,
      userId: actor.userId,
    },
    include: { thread: { select: { id: true } } },
  });
  if (!conversation?.thread) throw new IsolationError();
  const page = await loadMessagePage(
    prisma,
    conversation.thread.id,
    input.before,
    100,
    undefined,
    true,
  );
  const sources = await prisma.externalMessage.findMany({
    where: {
      externalConversationId: conversation.id,
      threadMessageId: { in: page.messages.map((message) => message.id) },
    },
    select: { threadMessageId: true, senderName: true },
  });
  const latest = await prisma.externalMessage.findFirst({
    where: { externalConversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    select: { status: true, replyThreadId: true },
  });
  return {
    ...page,
    authors: Object.fromEntries(
      sources
        .filter((source) => source.threadMessageId)
        .map((source) => [source.threadMessageId!, source.senderName]),
    ),
    latestStatus: latest?.status ?? null,
    sourceUrl:
      conversation.provider === "slack"
        ? `https://app.slack.com/client/${encodeURIComponent(conversation.workspaceId)}/${encodeURIComponent(conversation.externalKey)}`
        : null,
  };
}
