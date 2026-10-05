import type { MessageBlock } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";

/** Group turns use channel inputs and their own outputs, never private thread history. */
export function loadRunHistoryMessages(
  prisma: PrismaClient,
  run: { id: string; threadId: string },
  limit: number,
  channelId?: string,
) {
  return prisma.message.findMany({
    where: {
      threadId: run.threadId,
      ...(channelId
        ? {
            OR: [
              {
                role: "user",
                blocks: { array_contains: [{ kind: "channel_message", channelId }] },
              },
              { role: "bot", runId: run.id },
            ],
          }
        : {}),
    },
    orderBy: { seq: "desc" },
    take: limit,
    select: {
      id: true,
      threadId: true,
      seq: true,
      role: true,
      runId: true,
      botId: true,
      blocks: true,
      replyToMessageId: true,
      replyQuote: true,
      replyTo: { select: { id: true, threadId: true, role: true, blocks: true } },
    },
  });
}

export interface CreateThreadMessageInput {
  threadId: string;
  role: "user" | "bot" | "system";
  blocks: MessageBlock[];
  botId?: string;
  replyToMessageId?: string;
  replyQuote?: string;
  runId?: string;
  clientNonce?: string;
  markUnread?: boolean;
}

export async function createThreadMessage(prisma: PrismaClient, input: CreateThreadMessageInput) {
  return prisma.$transaction((tx: Prisma.TransactionClient) =>
    createThreadMessageInTransaction(tx, input),
  );
}

export async function createThreadMessageInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateThreadMessageInput,
) {
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: {
      nextMessageSeq: { increment: 1 },
      unread: (input.markUnread ?? input.role === "bot") ? true : undefined,
    },
    select: { nextMessageSeq: true },
  });
  await assertRunCanWriteHistory(tx, input.runId);
  return tx.message.create({
    data: {
      threadId: input.threadId,
      seq: thread.nextMessageSeq - 1,
      role: input.role,
      blocks: input.blocks as Prisma.InputJsonValue,
      botId: input.botId,
      replyToMessageId: input.replyToMessageId,
      replyQuote: input.replyQuote,
      runId: input.runId,
      clientNonce: input.clientNonce,
    },
  });
}

/**
 * The payload of a `thread.message.updated` event that rewrites a stored message's blocks. It
 * names the message and carries the identity fields `thread.message.created` carries, so a client
 * that rebuilds the message from the event alone still shows its reply quote. Clients merge it
 * into the message they already hold: author, run and ordering come from there.
 */
export function messageUpdatedPayload(
  message: {
    id: string;
    role: string;
    replyToMessageId?: string | null;
    replyQuote?: string | null;
  },
  blocks: unknown[],
): Record<string, unknown> {
  return {
    messageId: message.id,
    role: message.role,
    blocks,
    ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    ...(message.replyQuote ? { replyQuote: message.replyQuote } : {}),
  };
}

export class RunHistoryWriteError extends Error {
  constructor() {
    super("Run cannot write thread history");
    this.name = "RunHistoryWriteError";
  }
}

export async function assertRunCanWriteHistory(
  tx: Prisma.TransactionClient,
  runId?: string,
): Promise<{ status: string; startedAt: Date | null } | undefined> {
  if (!runId) return;
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: { status: true, startedAt: true },
  });
  if (!run || run.status === "cancelled") {
    throw new RunHistoryWriteError();
  }
  return run;
}
