import { randomUUID } from "node:crypto";
import type { NewSession, SessionEntryDraft } from "@rakazo/adapter-kit";
import { nextSessionEntry, SessionAppendError, sessionEntryNonce } from "@rakazo/adapter-kit";
import type {
  EntryId,
  MessageBlock,
  RunOutcome,
  SessionEntry,
  SessionEntryOf,
  SessionEntryType,
} from "@rakazo/contracts";
import { SessionEntrySchema, SessionId } from "@rakazo/contracts";
import { SessionEntryDecodeError, sanitizeJsonValue } from "@rakazo/core";
import { Prisma } from "./client.js";
import { RunHistoryWriteError } from "./messages.js";

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

/** The threads a transaction locked for its appends, and the feed event that carries them. */
type TransactionLog = { threadOf: Map<string, string | null>; eventOf: Map<string, string> };
const transactionLogs = new WeakMap<Prisma.TransactionClient, TransactionLog>();

function transactionLog(tx: Prisma.TransactionClient): TransactionLog {
  let log = transactionLogs.get(tx);
  if (!log) {
    log = { threadOf: new Map(), eventOf: new Map() };
    transactionLogs.set(tx, log);
  }
  return log;
}

/**
 * Append an entry as the session's new head. Appends to a session serialize on its row lock, and a
 * draft whose clientNonce is already in the session returns that entry without taking a seq. The
 * entries a transaction appends to a thread session reach the thread's feed as one
 * `session.entry.appended` event; a subagent session has no thread and no feed.
 */
export async function appendSessionEntryInTransaction(
  tx: Prisma.TransactionClient,
  draft: SessionEntryDraft,
): Promise<SessionEntry> {
  const log = transactionLog(tx);
  let threadId = log.threadOf.get(draft.sessionId);
  if (threadId === undefined) {
    // Thread before session, in the mode every thread writer uses, so a message write that appends
    // an entry cannot deadlock with this.
    const [thread] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM threads
      WHERE id = (SELECT "threadId" FROM sessions WHERE id = ${draft.sessionId})
      FOR UPDATE`;
    threadId = thread?.id ?? null;
    log.threadOf.set(draft.sessionId, threadId);
  }
  const feedBotId = draft.botId ?? draft.feedBotId;
  if (threadId && feedBotId === undefined) {
    throw new SessionAppendError(
      "no_feed_bot",
      `Entry for session ${draft.sessionId} names no bot to show it under on thread ${threadId}`,
    );
  }
  const nonce = sessionEntryNonce(draft);
  if (nonce !== undefined) {
    const [delivered] = await tx.$queryRaw<SessionEntryRow[]>`
      SELECT * FROM session_entries
      WHERE "sessionId" = ${draft.sessionId} AND payload ->> 'clientNonce' = ${nonce}`;
    if (delivered) return sessionEntryFromRow(delivered);
  }
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
  // The session row takes NO KEY so that the foreign key checks of child session and run inserts
  // do not wait on it.
  const [session] = await tx.$queryRaw<
    Array<{ nextEntrySeq: number; headEntryId: string | null; spaceId: string }>
  >`
    SELECT "nextEntrySeq", "headEntryId", "spaceId" FROM sessions WHERE id = ${draft.sessionId}
    FOR NO KEY UPDATE`;
  if (!session) {
    throw new SessionAppendError("unknown_session", `Session ${draft.sessionId} does not exist`);
  }
  const seq = session.nextEntrySeq;
  const entry = nextSessionEntry(
    sanitizeJsonValue(draft),
    seq,
    session.headEntryId === null ? null : { id: session.headEntryId, seq: seq - 1 },
  );
  const runId = entry.runId ?? null;
  const at = Prisma.sql`${entry.ts}::timestamptz AT TIME ZONE 'UTC'`;
  const eventId = threadId ? log.eventOf.get(threadId) : undefined;
  const newEventId = threadId && !eventId ? randomUUID() : undefined;
  const feed = eventId
    ? Prisma.sql`, appended AS (
        UPDATE events SET payload = jsonb_set(payload, '{entries}', (payload -> 'entries') || ${JSON.stringify(entry)}::jsonb)
        FROM e WHERE events.id = ${eventId})`
    : newEventId
      ? Prisma.sql`, t AS (
          UPDATE threads SET "nextEventSeq" = "nextEventSeq" + 1 FROM e WHERE threads.id = ${threadId}
          RETURNING threads."nextEventSeq" - 1 AS seq),
        appended AS (
          INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload, "runId", "createdAt")
          SELECT ${newEventId}, ${session.spaceId}, ${threadId}, ${feedBotId}, t.seq,
            'session.entry.appended', ${JSON.stringify({ entries: [entry] })}::jsonb, ${runId}, ${at}
          FROM t)`
      : Prisma.empty;
  // The run check reads a snapshot taken after the session lock, so it sees a cancel that
  // committed while this append waited.
  const written = await tx.$queryRaw<unknown[]>`
    WITH e AS (
      INSERT INTO session_entries (id, "sessionId", seq, "parentId", type, payload, "botId", "runId", "createdAt")
      SELECT ${entry.id}, ${entry.sessionId}, ${seq}, ${entry.parentId}, ${entry.type},
        ${JSON.stringify(entry.payload)}::jsonb, ${entry.botId ?? null}, ${runId}, ${at}
      WHERE ${runId}::text IS NULL
        OR EXISTS (SELECT 1 FROM runs WHERE id = ${runId} AND status <> 'cancelled')
      RETURNING id),
    s AS (
      UPDATE sessions SET "nextEntrySeq" = ${seq + 1}, "headEntryId" = ${entry.id}
      FROM e WHERE sessions.id = ${entry.sessionId})
    ${feed}
    SELECT 1 FROM e`;
  if (written.length === 0) throw new RunHistoryWriteError();
  if (threadId && newEventId) log.eventOf.set(threadId, newEventId);
  return entry;
}

type EntryBody<T extends SessionEntryType> = T extends unknown
  ? { type: T; payload: SessionEntryOf<T>["payload"] }
  : never;
type RunBlockBody = EntryBody<
  "assistant.text" | "assistant.reasoning" | "assistant.ask" | "assistant.choice"
>;
type BlockOf<K extends MessageBlock["kind"]> = Extract<MessageBlock, { kind: K }>;

const asText = (block: MessageBlock): RunBlockBody => ({
  type: "assistant.text",
  payload: { blocks: [block] },
});

const RUN_BLOCK_ENTRY: {
  [K in MessageBlock["kind"]]: ((block: BlockOf<K>) => RunBlockBody) | null;
} = {
  text: asText,
  card: asText,
  app_connect: asText,
  connect: asText,
  computer: asText,
  meta: asText,
  chart: asText,
  child_bot: asText,
  skill_draft: asText,
  mcp_approval: asText,
  image: asText,
  file: asText,
  channel_message: asText,
  link_preview: asText,
  reasoning: (block) => ({ type: "assistant.reasoning", payload: { text: block.text } }),
  ask: (block) => ({ type: "assistant.ask", payload: { block } }),
  choice: (block) => ({ type: "assistant.choice", payload: { block } }),
  progress: null,
  steps: null,
  subagent: null,
  handoff: null,
  bot_message_sent: null,
  bot_message_received: null,
  routine_run: null,
};

/**
 * Append the entries of a message a run published, one per block, to the run's own session. The
 * first entry takes the message's id, so whatever points at the message points at the entry.
 */
export async function appendRunBlocksInTransaction(
  tx: Prisma.TransactionClient,
  message: { id: string; runId: string; botId: string },
  blocks: readonly MessageBlock[],
  append: typeof appendSessionEntryInTransaction = appendSessionEntryInTransaction,
): Promise<void> {
  const bodies = blocks.flatMap((block) => {
    const toEntry = RUN_BLOCK_ENTRY[block.kind] as ((block: MessageBlock) => RunBlockBody) | null;
    return toEntry ? [toEntry(block)] : [];
  });
  if (bodies.length === 0) return;
  const run = await tx.run.findUniqueOrThrow({
    where: { id: message.runId },
    select: { sessionId: true },
  });
  for (const [index, body] of bodies.entries()) {
    await append(tx, {
      ...body,
      ...(index === 0 ? { id: message.id as EntryId } : {}),
      sessionId: run.sessionId as SessionId,
      botId: message.botId,
      runId: message.runId,
    } as SessionEntryDraft);
  }
}

/**
 * Rewind the log to just before the user message the thread was cut at: its entry carries the
 * message's id. A message with no entry predates the log, so everything the log holds came after
 * it, and a clear cuts that as a rewind past the first entry would.
 */
export async function appendRewindInTransaction(
  tx: Prisma.TransactionClient,
  input: { sessionId: SessionId; messageId: string; feedBotId: string },
): Promise<void> {
  const target = await tx.sessionEntry.findFirst({
    where: { id: input.messageId, sessionId: input.sessionId },
    select: { parentId: true },
  });
  const { sessionId, feedBotId } = input;
  await appendSessionEntryInTransaction(
    tx,
    target?.parentId
      ? { type: "rewind", sessionId, parentId: target.parentId as EntryId, payload: {}, feedBotId }
      : { type: "clear", sessionId, payload: {}, feedBotId },
  );
}

/**
 * Record who holds the bot's computer when it changes hands from the holder the log last saw, the
 * bot when it saw none. A release follows only a takeover the log saw granted, so control a
 * teaching session borrowed leaves no trace.
 */
export async function appendComputerControlInTransaction(
  tx: Prisma.TransactionClient,
  input: { sessionId: SessionId; botId: string; holder: "user" | "bot" },
): Promise<void> {
  const last = await tx.sessionEntry.findFirst({
    where: { sessionId: input.sessionId, type: "computer.control" },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  const lastHolder = (last?.payload as { holder?: string } | undefined)?.holder ?? "bot";
  if (lastHolder === input.holder) return;
  await appendSessionEntryInTransaction(tx, {
    type: "computer.control",
    sessionId: input.sessionId,
    botId: input.botId,
    payload: { holder: input.holder },
  });
}

type RunEnding =
  | { status: "completed" }
  | { status: "failed"; error: string }
  | { status: "cancelled"; by?: string };

/**
 * Close a run's log with how the run ended. A run that never wrote `run.started` has no log to
 * close and a closed one stays closed, so every way a run ends can call this. Usage defaults to
 * what the run recorded.
 */
export async function appendRunFinishedInTransaction(
  tx: Prisma.TransactionClient,
  runId: string,
  ending: RunEnding,
  usage?: RunOutcome["usage"],
): Promise<void> {
  const logged = await tx.sessionEntry.findMany({
    where: { runId, type: { in: ["run.started", "run.finished"] } },
    select: { type: true, sessionId: true, botId: true },
  });
  const started = logged.find((entry) => entry.type === "run.started");
  if (!started?.botId || logged.some((entry) => entry.type === "run.finished")) return;
  const recorded = usage
    ? undefined
    : await tx.usageRecord.aggregate({
        where: { runId },
        _sum: { inputTokens: true, outputTokens: true },
      });
  await appendSessionEntryInTransaction(tx, {
    type: "run.finished",
    sessionId: started.sessionId as SessionId,
    botId: started.botId,
    runId,
    payload: {
      ...ending,
      usage: usage ?? {
        inputTokens: recorded?._sum.inputTokens ?? 0,
        outputTokens: recorded?._sum.outputTokens ?? 0,
      },
    },
  });
}
