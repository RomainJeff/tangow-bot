import type { NewSession, SessionEntryDraft } from "@rakazo/adapter-kit";
import { nextSessionEntry, SessionAppendError, sessionEntryNonce } from "@rakazo/adapter-kit";
import type { SessionEntry } from "@rakazo/contracts";
import { SessionEntrySchema, SessionId } from "@rakazo/contracts";
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
): Promise<SessionId> {
  await tx.conversationSession.createMany({ data: [session], skipDuplicates: true });
  if (session.kind === "subagent") return session.id;
  const main = await tx.conversationSession.findFirstOrThrow({
    where: { threadId: session.threadId, kind: "thread" },
    select: { id: true },
  });
  return SessionId.parse(main.id);
}

/**
 * Append an entry as the session's new head. Appends to a session serialize on its row lock, and a
 * draft whose clientNonce is already in the session returns that entry without taking a seq. An
 * entry of a thread session also lands on the thread's events feed as `session.entry.appended`; a
 * subagent session has no thread and no feed.
 */
export async function appendSessionEntryInTransaction(
  tx: Prisma.TransactionClient,
  draft: SessionEntryDraft,
): Promise<SessionEntry> {
  // Thread before session, in the mode every thread writer uses, so a message write that appends an
  // entry cannot deadlock with this. The session row takes NO KEY so that the foreign key checks of
  // child session and run inserts do not wait on it.
  const [thread] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM threads
    WHERE id = (SELECT "threadId" FROM sessions WHERE id = ${draft.sessionId})
    FOR UPDATE`;
  const [session] = await tx.$queryRaw<Array<{ nextEntrySeq: number; spaceId: string }>>`
    SELECT "nextEntrySeq", "spaceId" FROM sessions WHERE id = ${draft.sessionId}
    FOR NO KEY UPDATE`;
  if (!session) {
    throw new SessionAppendError("unknown_session", `Session ${draft.sessionId} does not exist`);
  }
  await assertRunCanWriteHistory(tx, draft.runId);
  const nonce = sessionEntryNonce(draft);
  if (nonce !== undefined) {
    const [delivered] = await tx.$queryRaw<SessionEntryRow[]>`
      SELECT * FROM session_entries
      WHERE "sessionId" = ${draft.sessionId} AND payload ->> 'clientNonce' = ${nonce}`;
    if (delivered) return sessionEntryFromRow(delivered);
  }
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
  const entry = nextSessionEntry(sanitizeJsonValue(draft), session.nextEntrySeq, head);
  if (thread) {
    const botId = entry.botId ?? draft.feedBotId;
    if (botId === undefined) {
      throw new SessionAppendError(
        "no_feed_bot",
        `Entry for session ${draft.sessionId} names no bot to show it under on thread ${thread.id}`,
      );
    }
    await appendEventInTransaction(tx, {
      spaceId: session.spaceId,
      threadId: thread.id,
      botId,
      type: "session.entry.appended",
      payload: { entry },
      runId: entry.runId,
    });
  }
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
  await tx.conversationSession.update({
    where: { id: entry.sessionId },
    data: { nextEntrySeq: { increment: 1 } },
    select: { id: true },
  });
  return entry;
}
