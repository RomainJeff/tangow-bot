import type { NewSession, SessionEntryDraft } from "@rakazo/adapter-kit";
import { nextSessionEntry, SessionAppendError, sessionEntryNonce } from "@rakazo/adapter-kit";
import type { SessionEntry } from "@rakazo/contracts";
import { SessionEntrySchema } from "@rakazo/contracts";
import { SessionEntryDecodeError, sanitizeJsonValue } from "@rakazo/core";
import type { Prisma } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { assertRunCanWriteHistory } from "./messages.js";

/** A `session_entries` row, as Prisma and `$queryRaw` both return it. */
export interface SessionEntryRow {
  id: string;
  sessionId: string;
  seq: number;
  parentId: string | null;
  type: string;
  payload: unknown;
  botId: string | null;
  runId: string | null;
  createdAt: Date;
}

export function sessionEntryFromRow(row: SessionEntryRow): SessionEntry {
  const parsed = SessionEntrySchema.safeParse({
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    parentId: row.parentId,
    ts: row.createdAt.toISOString(),
    ...(row.botId === null ? {} : { botId: row.botId }),
    ...(row.runId === null ? {} : { runId: row.runId }),
    type: row.type,
    payload: row.payload,
  });
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(entry)"}: ${issue.message}`)
    .join("; ");
  throw new SessionEntryDecodeError(`Invalid session entry ${row.id}: ${issues}`);
}

export async function createSessionInTransaction(
  tx: Prisma.TransactionClient,
  session: NewSession,
): Promise<void> {
  await tx.conversationSession.createMany({ data: [session], skipDuplicates: true });
}

/**
 * Append an entry as the session's new head. The seq bump on the session row is the append lock.
 * An entry of a thread session also lands on the thread's events feed as `session.entry.appended`;
 * a subagent session has no thread and no feed. Of two concurrent deliveries of one clientNonce,
 * the later fails on the session_entries_sessionId_clientNonce_key index, and its retry returns
 * the first entry.
 */
export async function appendSessionEntryInTransaction(
  tx: Prisma.TransactionClient,
  draft: SessionEntryDraft,
): Promise<SessionEntry> {
  const nonce = sessionEntryNonce(draft);
  if (nonce !== undefined) {
    const [delivered] = await tx.$queryRaw<SessionEntryRow[]>`
      SELECT * FROM session_entries
      WHERE "sessionId" = ${draft.sessionId} AND payload ->> 'clientNonce' = ${nonce}`;
    if (delivered) return sessionEntryFromRow(delivered);
  }
  // Thread before session, the order every thread writer locks in: message and event seq bumps
  // lock the thread row first, so a message write that appends an entry cannot deadlock with this.
  const [thread] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM threads
    WHERE id = (SELECT "threadId" FROM sessions WHERE id = ${draft.sessionId})
    FOR NO KEY UPDATE`;
  const [session] = await tx.$queryRaw<Array<{ seq: number; spaceId: string }>>`
    UPDATE sessions SET "nextEntrySeq" = "nextEntrySeq" + 1 WHERE id = ${draft.sessionId}
    RETURNING "nextEntrySeq" - 1 AS seq, "spaceId"`;
  if (!session) {
    throw new SessionAppendError("unknown_session", `Session ${draft.sessionId} does not exist`);
  }
  await assertRunCanWriteHistory(tx, draft.runId);
  const head = await tx.sessionEntry.findFirst({
    where: { sessionId: draft.sessionId },
    orderBy: { seq: "desc" },
    select: { id: true, seq: true },
  });
  if (draft.type === "rewind") {
    const target = await tx.sessionEntry.findFirst({
      where: { id: draft.parentId, sessionId: draft.sessionId },
      select: { id: true },
    });
    if (!target) {
      throw new SessionAppendError(
        "missing_parent",
        `Rewind target ${draft.parentId} is not in session ${draft.sessionId}`,
      );
    }
  }
  const entry = nextSessionEntry(sanitizeJsonValue(draft), session.seq, head);
  await tx.sessionEntry.create({
    data: {
      id: entry.id,
      sessionId: entry.sessionId,
      seq: entry.seq,
      parentId: entry.parentId,
      type: entry.type,
      payload: entry.payload as Prisma.InputJsonValue,
      botId: entry.botId,
      runId: entry.runId,
      createdAt: new Date(entry.ts),
    },
    select: { id: true },
  });
  if (thread) {
    await appendEventInTransaction(tx, {
      spaceId: session.spaceId,
      threadId: thread.id,
      botId: entry.botId ?? (await threadBotId(tx, thread.id)),
      type: "session.entry.appended",
      payload: { entry },
      runId: entry.runId,
    });
  }
  return entry;
}

/**
 * The bot a thread's feed attributes a bot-less entry to: the thread's bot, the bot of its external
 * conversation, or a group's first member.
 */
async function threadBotId(tx: Prisma.TransactionClient, threadId: string): Promise<string> {
  const [owner] = await tx.$queryRaw<Array<{ botId: string | null }>>`
    SELECT COALESCE(
      t."botId",
      c."botId",
      (SELECT m."botId" FROM chat_group_members m
       WHERE m."groupId" = t."groupId" ORDER BY m."createdAt", m.id LIMIT 1)
    ) AS "botId"
    FROM threads t LEFT JOIN external_conversations c ON c.id = t."externalConversationId"
    WHERE t.id = ${threadId}`;
  if (!owner?.botId) throw new Error(`Thread ${threadId} has no bot to attribute its entries to`);
  return owner.botId;
}
