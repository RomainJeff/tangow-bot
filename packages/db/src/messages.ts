import { randomUUID } from "node:crypto";
import type { SessionEntryDraft } from "@rakazo/adapter-kit";
import type { MessageBlock, SessionEntry, SessionEntryOf } from "@rakazo/contracts";
import { EntryId, SessionId } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { markThreadUnread } from "./groups.js";
import { appendRunBlocksInTransaction, appendSessionEntryInTransaction } from "./sessions.js";

export interface CreateThreadMessageInput {
  threadId: string;
  role: "user" | "system";
  blocks: MessageBlock[];
  replyToMessageId?: string;
  replyQuote?: string;
  clientNonce?: string;
  markUnread?: boolean;
  /** Where a person's message came from; a channel post is told by its block. */
  source?: SessionEntryOf<"user.message">["payload"]["source"];
  /** The bot whose feed shows the entry, for a thread with no bot of its own. */
  feedBotId?: string;
  /** The bots a group send addresses, in the order it dispatches them. */
  targets?: string[];
  /** Who wrote a person's message in a group; absent, the thread's own person. */
  authorId?: string;
}

/** A person's message whose clientNonce the thread already holds: the first delivery stands. */
export class DuplicateMessageError extends Error {
  constructor(readonly entry: SessionEntry) {
    super(`Message ${entry.id} already carries this clientNonce`);
    this.name = "DuplicateMessageError";
  }
}

export async function createThreadMessage(prisma: PrismaClient, input: CreateThreadMessageInput) {
  return prisma.$transaction((tx: Prisma.TransactionClient) =>
    createThreadMessageInTransaction(tx, input),
  );
}

/** A person's message, or a system note, as the newest entry of the thread's main session. */
export async function createThreadMessageInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateThreadMessageInput,
): Promise<SessionEntry> {
  const thread = await markThread(
    tx,
    input.threadId,
    input.markUnread ?? false,
    input.role === "user" ? { userId: input.authorId } : undefined,
  );
  const id = EntryId.parse(randomUUID());
  const entry = await appendSessionEntryInTransaction(tx, {
    ...threadMessageEntry(input),
    id,
    sessionId: thread.sessionId,
    feedBotId: input.feedBotId ?? thread.botId ?? undefined,
  } as SessionEntryDraft);
  if (entry.id !== id) throw new DuplicateMessageError(entry);
  return entry;
}

function threadMessageEntry(input: CreateThreadMessageInput) {
  if (input.role === "system") {
    const text = input.blocks
      .flatMap((block) => ("text" in block && typeof block.text === "string" ? [block.text] : []))
      .join("\n");
    return { type: "system.note", payload: { text } } as const;
  }
  return {
    type: "user.message",
    payload: {
      blocks: input.blocks,
      ...(input.replyToMessageId
        ? {
            replyTo: {
              entryId: input.replyToMessageId as EntryId,
              ...(input.replyQuote ? { quote: input.replyQuote } : {}),
            },
          }
        : {}),
      ...(input.clientNonce ? { clientNonce: input.clientNonce } : {}),
      ...(input.targets ? { targets: input.targets } : {}),
      ...(input.authorId ? { authorId: input.authorId } : {}),
      source:
        input.source ??
        (input.blocks.some((block) => block.kind === "channel_message") ? "channel" : "app"),
    },
  } as const;
}

export interface CreateBotMessageInput {
  threadId: string;
  botId: string;
  blocks: MessageBlock[];
  /** The run that wrote the words; without one they are the bot's words outside any run. */
  runId?: string;
  toPerson?: true;
  midTurn?: true;
  markUnread?: boolean;
}

/**
 * A bot's words in a thread: a run's blocks as its entries, or a `bot.text` outside any run. The
 * thread turns unread unless the caller says otherwise. Returns the first entry's id, none when no
 * block makes an entry.
 */
export async function createBotMessageInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateBotMessageInput,
  append: typeof appendSessionEntryInTransaction = appendSessionEntryInTransaction,
): Promise<EntryId | undefined> {
  const thread = await markThread(tx, input.threadId, input.markUnread ?? true);
  const id = EntryId.parse(randomUUID());
  if (input.runId) {
    const written = await appendRunBlocksInTransaction(
      tx,
      {
        id,
        runId: input.runId,
        botId: input.botId,
        toPerson: input.toPerson,
        midTurn: input.midTurn,
      },
      input.blocks,
      append,
    );
    return written ? id : undefined;
  }
  await append(tx, {
    id,
    type: "bot.text",
    sessionId: thread.sessionId,
    botId: input.botId,
    payload: { blocks: input.blocks },
  });
  return id;
}

/**
 * The thread an entry goes in. `unread` turns it unread for everyone; a person's message in a
 * group (`author`, the thread's own person when no id is given) is unread for its other people.
 */
async function markThread(
  tx: Prisma.TransactionClient,
  threadId: string,
  unread: boolean,
  author?: { userId?: string },
) {
  const thread = await tx.thread.findUniqueOrThrow({
    where: { id: threadId },
    select: {
      id: true,
      sessionId: true,
      botId: true,
      memberBotId: true,
      groupId: true,
      userId: true,
    },
  });
  if (unread) await markThreadUnread(tx, thread);
  else if (author && thread.groupId) {
    await markThreadUnread(tx, thread, author.userId ?? thread.userId);
  }
  return {
    sessionId: SessionId.parse(thread.sessionId),
    botId: thread.botId ?? thread.memberBotId,
  };
}
