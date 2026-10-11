import { randomUUID } from "node:crypto";
import type { NewSession, SessionEntryDraft, SessionLog } from "@rakazo/adapter-kit";
import { nextSessionEntry, SessionAppendError, sessionEntryNonce } from "@rakazo/adapter-kit";
import type {
  EntryId,
  MessageBlock,
  RunOutcome,
  SessionEntry,
  SessionEntryOf,
  SessionEntryType,
} from "@rakazo/contracts";
import {
  isRunTrace,
  SessionEntrySchema,
  SessionId,
  USER_MESSAGE_CLIENT_NONCE_PREFIX,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, SessionEntryDecodeError, sanitizeJsonValue } from "@rakazo/core";
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

/**
 * The epoch semantic memory files a session's compacted summaries under: the seq of its newest
 * clear or rewind that cut a summarized turn, 0 before any. Either leaves the summaries filed
 * before it unrecalled, and a summary saved while it landed fails the re-check.
 */
export async function historyGeneration(
  prisma: Pick<Prisma.TransactionClient, "sessionEntry">,
  sessionId: string,
): Promise<number> {
  const cut = await prisma.sessionEntry.findFirst({
    where: {
      sessionId,
      OR: [{ type: "clear" }, { type: "rewind", payload: { path: ["cutsSummary"], equals: true } }],
    },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return cut?.seq ?? 0;
}

export async function createSessionInTransaction(
  tx: Prisma.TransactionClient,
  session: NewSession,
): Promise<SessionId> {
  await tx.conversationSession.createMany({ data: [session], skipDuplicates: true });
  if (session.kind !== "thread") return session.id;
  const main = await tx.conversationSession.findFirstOrThrow({
    where: { threadId: session.threadId, kind: "thread" },
    select: { id: true },
  });
  return SessionId.parse(main.id);
}

/** The `session.entry.appended` event that carries a transaction's entries to one thread. */
type ThreadFeed = {
  eventId: string;
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string | null;
  entries: SessionEntry[];
};
type Route = { sessionId: SessionId; threadId: string | null; originSessionId?: SessionId };
type Lineage = { mainSessionId: SessionId; threadId: string | null; child: boolean };
/** What a transaction already resolved: each session's lineage, and its feed event per thread. */
type TransactionLog = { lineageOf: Map<string, Lineage>; feedOf: Map<string, ThreadFeed> };
const transactionLogs = new WeakMap<Prisma.TransactionClient, TransactionLog>();

function transactionLog(tx: Prisma.TransactionClient): TransactionLog {
  let log = transactionLogs.get(tx);
  if (!log) {
    log = { lineageOf: new Map(), feedOf: new Map() };
    transactionLogs.set(tx, log);
  }
  return log;
}

/**
 * The one rule for which session an entry lands in. A child session, a routine's or a helper's at
 * any depth, keeps its run's trace; whatever else is addressed to it, an ask, an approval, a card
 * the person must act on, the person's answer, rises to its thread's main session, the top-most
 * ancestor, with that child as its `originSessionId`. Every append locks that thread before any
 * session row, in the mode every thread writer uses, so neither a message write nor a stop, which
 * takes the thread, then the run, then the session, can deadlock with it.
 */
async function routeOf(tx: Prisma.TransactionClient, draft: SessionEntryDraft): Promise<Route> {
  const log = transactionLog(tx);
  let lineage = log.lineageOf.get(draft.sessionId);
  if (!lineage) {
    const [found] = await tx.$queryRaw<
      Array<{ mainSessionId: string; threadId: string | null; child: boolean }>
    >`
      WITH RECURSIVE ancestry AS (
        SELECT id, "parentSessionId", "threadId", 0 AS depth FROM sessions WHERE id = ${draft.sessionId}
        UNION ALL
        SELECT s.id, s."parentSessionId", s."threadId", ancestry.depth + 1
        FROM sessions s JOIN ancestry ON s.id = ancestry."parentSessionId"),
      main AS (SELECT id, "threadId", depth FROM ancestry ORDER BY depth DESC LIMIT 1),
      thread AS (SELECT id FROM threads WHERE id = (SELECT "threadId" FROM main) FOR UPDATE)
      SELECT main.id AS "mainSessionId", thread.id AS "threadId", main.depth > 0 AS child
      FROM main LEFT JOIN thread ON true`;
    lineage = {
      mainSessionId: (found?.mainSessionId ?? draft.sessionId) as SessionId,
      threadId: found?.threadId ?? null,
      child: found?.child ?? false,
    };
    log.lineageOf.set(draft.sessionId, lineage);
  }
  if (!lineage.child) return { sessionId: draft.sessionId, threadId: lineage.threadId };
  return isRunTrace(draft)
    ? { sessionId: draft.sessionId, threadId: null }
    : {
        sessionId: lineage.mainSessionId,
        threadId: lineage.threadId,
        originSessionId: draft.sessionId,
      };
}

function insertFeedEvent(feed: ThreadFeed, at: Prisma.Sql, gate: Prisma.Sql) {
  return Prisma.sql`t AS (
      UPDATE threads SET "nextEventSeq" = "nextEventSeq" + 1 ${gate} WHERE threads.id = ${feed.threadId}
      RETURNING threads."nextEventSeq" - 1 AS seq),
    inserted AS (
      INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload, "runId", "createdAt")
      SELECT ${feed.eventId}, ${feed.spaceId}, ${feed.threadId}, ${feed.botId}, t.seq,
        'session.entry.appended', ${JSON.stringify({ entries: feed.entries })}::jsonb, ${feed.runId}, ${at}
      FROM t)`;
}

/**
 * Append an entry as the new head of the session `routeOf` lands it in. Appends to a session
 * serialize on its row lock, and a draft whose clientNonce is already in the session returns that
 * entry without taking a seq. The entries a transaction appends to a thread session reach the
 * thread's feed as one `session.entry.appended` event; a subagent or routine session has no thread
 * and no feed.
 */
export async function appendSessionEntryInTransaction(
  tx: Prisma.TransactionClient,
  addressed: SessionEntryDraft,
): Promise<SessionEntry> {
  const log = transactionLog(tx);
  const { sessionId, threadId, originSessionId } = await routeOf(tx, addressed);
  const draft = (
    originSessionId
      ? { ...addressed, sessionId, payload: { ...addressed.payload, originSessionId } }
      : { ...addressed, sessionId }
  ) as SessionEntryDraft;
  const feedBotId = draft.botId ?? draft.feedBotId;
  if (threadId && feedBotId === undefined) {
    throw new SessionAppendError(
      "no_feed_bot",
      `Entry for session ${draft.sessionId} names no bot to show it under on thread ${threadId}`,
    );
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
  // After the session lock, so a duplicate delivery waits for the first and finds its entry.
  const nonce = sessionEntryNonce(draft);
  if (nonce !== undefined) {
    const [delivered] = await tx.$queryRaw<SessionEntryRow[]>`
      SELECT * FROM session_entries
      WHERE "sessionId" = ${draft.sessionId} AND payload ->> 'clientNonce' = ${nonce}`;
    if (delivered) return sessionEntryFromRow(delivered);
  }
  const seq = session.nextEntrySeq;
  const entry = nextSessionEntry(
    sanitizeJsonValue(draft),
    seq,
    session.headEntryId === null ? null : { id: session.headEntryId, seq: seq - 1 },
  );
  const runId = entry.runId ?? null;
  const at = Prisma.sql`${entry.ts}::timestamptz AT TIME ZONE 'UTC'`;
  const feed = threadId ? log.feedOf.get(threadId) : undefined;
  const newFeed: ThreadFeed | undefined =
    threadId && feedBotId && !feed
      ? {
          eventId: randomUUID(),
          spaceId: session.spaceId,
          threadId,
          botId: feedBotId,
          runId,
          entries: [entry],
        }
      : undefined;
  const feedSql = feed
    ? Prisma.sql`, appended AS (
        UPDATE events SET payload = jsonb_set(payload, '{entries}', (payload -> 'entries') || ${JSON.stringify(entry)}::jsonb)
        FROM e WHERE events.id = ${feed.eventId}
        RETURNING events.id)`
    : newFeed
      ? Prisma.sql`, ${insertFeedEvent(newFeed, at, Prisma.sql`FROM e`)}`
      : Prisma.empty;
  // A run writes nothing once cancelled, and nothing of its own once it finished in this session.
  // The skills it learnt are written for it once it ended, however it ended. The checks read a
  // snapshot taken after the session lock, so they see a cancel or a finish that committed while
  // this append waited.
  const runScoped = /^(run|assistant|tool)\./.test(entry.type);
  const afterTheRun = entry.type === "skill.learnt";
  const written = await tx.$queryRaw<Array<{ fed: boolean }>>`
    WITH e AS (
      INSERT INTO session_entries (id, "sessionId", seq, "parentId", type, payload, "botId", "runId", "createdAt")
      SELECT ${entry.id}, ${entry.sessionId}, ${seq}, ${entry.parentId}, ${entry.type},
        ${JSON.stringify(entry.payload)}::jsonb, ${entry.botId ?? null}, ${runId}, ${at}
      WHERE (${runId}::text IS NULL OR ${afterTheRun}
          OR EXISTS (SELECT 1 FROM runs WHERE id = ${runId} AND status <> 'cancelled'))
        AND NOT (${runScoped} AND EXISTS (
          SELECT 1 FROM session_entries
          WHERE "sessionId" = ${entry.sessionId} AND "runId" = ${runId} AND type = 'run.finished'))
      RETURNING id),
    s AS (
      UPDATE sessions SET "nextEntrySeq" = ${seq + 1}, "headEntryId" = ${entry.id}
      FROM e WHERE sessions.id = ${entry.sessionId})
    ${feedSql}
    SELECT ${feed ? Prisma.sql`EXISTS (SELECT 1 FROM appended)` : Prisma.sql`true`} AS fed FROM e`;
  if (written.length === 0) {
    const [run] = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM runs WHERE id = ${runId}`;
    if (!run || run.status === "cancelled") throw new RunHistoryWriteError();
    throw new SessionAppendError(
      "run_finished",
      `Run ${runId} already finished in session ${entry.sessionId}`,
    );
  }
  if (newFeed) log.feedOf.set(newFeed.threadId, newFeed);
  if (!feed) return entry;
  feed.entries.push(entry);
  if (!written[0]?.fed) {
    // A truncate in this transaction deleted the event, so a new one carries its entries.
    feed.eventId = randomUUID();
    await tx.$queryRaw`WITH ${insertFeedEvent(feed, at, Prisma.empty)} SELECT 1`;
  }
  return entry;
}

type CardStateDraft = SessionEntryDraft extends infer Draft
  ? Draft extends {
      type:
        | "card.answered"
        | "effect.applied"
        | "link.preview"
        | "link.preview.removed"
        | "skill.draft";
    }
    ? Omit<Draft, "sessionId">
    : never
  : never;

/**
 * Append a card's later state to the session that holds its `payload.target`. A card older than
 * the log has no entry, so nothing is appended and the message row alone keeps its state.
 */
export async function appendCardStateInTransaction(
  tx: Prisma.TransactionClient,
  draft: CardStateDraft,
  append: typeof appendSessionEntryInTransaction = appendSessionEntryInTransaction,
): Promise<SessionEntry | undefined> {
  const target = await tx.sessionEntry.findUnique({
    where: { id: draft.payload.target },
    select: { sessionId: true },
  });
  if (!target) return undefined;
  return append(tx, {
    ...draft,
    sessionId: target.sessionId as SessionId,
  } as SessionEntryDraft);
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
  skill_source: null,
};

/**
 * Append the entries of a message a run published, one per block, to the run's own session. The
 * first entry takes the message's id, so whatever points at the message points at the entry. A
 * message the bot sent the person through `message_user` marks its text `toPerson`; its nonce
 * stays on the message row, since the entries' nonce index is unique across every type.
 */
export async function appendRunBlocksInTransaction(
  tx: Prisma.TransactionClient,
  message: { id: string; runId: string; botId: string; clientNonce?: string },
  blocks: readonly MessageBlock[],
  append: typeof appendSessionEntryInTransaction = appendSessionEntryInTransaction,
): Promise<void> {
  const toPerson = message.clientNonce?.startsWith(USER_MESSAGE_CLIENT_NONCE_PREFIX) ?? false;
  const bodies = blocks.flatMap((block): RunBlockBody[] => {
    const toEntry = RUN_BLOCK_ENTRY[block.kind] as ((block: MessageBlock) => RunBlockBody) | null;
    const body = toEntry?.(block);
    if (!body) return [];
    return toPerson && body.type === "assistant.text"
      ? [{ ...body, payload: { ...body.payload, toPerson: true } }]
      : [body];
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
 * it, and a clear cuts that as a rewind past the first entry would. A compaction the rewind cuts
 * off whose summary ends before the message still describes turns that remain, so it is written
 * again on top of the rewind and the next read starts from it; one whose summary reaches the
 * message describes turns that are gone, and the rewind says so.
 */
export async function appendRewindInTransaction(
  tx: Prisma.TransactionClient,
  input: { sessionId: SessionId; messageId: string; feedBotId: string },
): Promise<void> {
  const { sessionId, feedBotId } = input;
  const target = await tx.sessionEntry.findFirst({
    where: { id: input.messageId, sessionId },
    select: { seq: true, parentId: true },
  });
  if (!target?.parentId) {
    await appendSessionEntryInTransaction(tx, { type: "clear", sessionId, payload: {}, feedBotId });
    return;
  }
  const cutOff = await newestCompactionAfter(tx, sessionId, target.seq);
  const cutsSummary = cutOff !== undefined && cutOff.payload.coveredUpToSeq >= target.seq;
  const rewind = await appendSessionEntryInTransaction(tx, {
    type: "rewind",
    sessionId,
    parentId: target.parentId as EntryId,
    payload: cutsSummary ? { cutsSummary } : {},
    feedBotId,
  });
  if (cutOff && !cutsSummary) {
    await appendSessionEntryInTransaction(tx, {
      type: "compaction",
      sessionId,
      parentId: rewind.id,
      payload: cutOff.payload,
      feedBotId,
    });
  }
}

/** The first compaction on the chain walking back from the head, among the entries after `seq`. */
async function newestCompactionAfter(
  tx: Prisma.TransactionClient,
  sessionId: SessionId,
  seq: number,
): Promise<SessionEntryOf<"compaction"> | undefined> {
  const [row] = await tx.$queryRaw<SessionEntryRow[]>`
    WITH RECURSIVE chain AS (
      SELECT e.* FROM session_entries e JOIN sessions s ON e.id = s."headEntryId"
      WHERE s.id = ${sessionId} AND e.seq > ${seq}
      UNION ALL
      SELECT e.* FROM session_entries e JOIN chain ON e.id = chain."parentId"
      WHERE chain.type <> 'compaction' AND e."sessionId" = ${sessionId} AND e.seq > ${seq}
    )
    SELECT * FROM chain WHERE type = 'compaction'`;
  const entry = row && sessionEntryFromRow(row);
  return entry?.type === "compaction" ? entry : undefined;
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
 * Give a routine run its own session under its thread's main session, point the run at it, and
 * mark the routine's start in the main session. The run opens its log once, so this runs once.
 */
export async function openRoutineSessionInTransaction(
  tx: Prisma.TransactionClient,
  run: { id: string; spaceId: string; threadId: string; botId: string },
  started: Omit<SessionEntryOf<"routine.started">["payload"], "sessionId">,
  log: Pick<SessionLog<Prisma.TransactionClient>, "createSession" | "append"> = {
    createSession: createSessionInTransaction,
    append: appendSessionEntryInTransaction,
  },
): Promise<SessionId> {
  // Thread, then run, then session, as finalize and every canceller take them.
  const [thread] = await tx.$queryRaw<Array<{ sessionId: string }>>`
    SELECT "sessionId" FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
  const parentSessionId = SessionId.parse(thread?.sessionId);
  const sessionId = await log.createSession(tx, {
    kind: "routine",
    id: SessionId.parse(randomUUID()),
    spaceId: run.spaceId,
    parentSessionId,
  });
  await tx.run.updateMany({ where: { id: run.id }, data: { sessionId } });
  await log.append(tx, {
    type: "routine.started",
    sessionId: parentSessionId,
    botId: run.botId,
    runId: run.id,
    payload: { sessionId, ...started },
  });
  return sessionId;
}

/**
 * Close a run's log with how the run ended, and a routine run's mark in its thread with its final
 * words, `result`. A run that never wrote `run.started` has no log to close and a closed one stays
 * closed, so every way a run ends can call this. A cancel closes only a run still active, any other
 * ending only the run whose status already says so. Usage defaults to what the run recorded.
 */
export async function appendRunFinishedInTransaction(
  tx: Prisma.TransactionClient,
  runId: string,
  ending: RunEnding,
  { usage, result = "" }: { usage?: RunOutcome["usage"]; result?: string } = {},
): Promise<void> {
  // Thread, then run, then session, as finalize and every canceller take them, so that the run's
  // status and its log are read after whichever of them committed first.
  await tx.$queryRaw`
    SELECT id FROM threads WHERE id = (SELECT "threadId" FROM runs WHERE id = ${runId}) FOR UPDATE`;
  const [run] = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT status FROM runs WHERE id = ${runId} FOR NO KEY UPDATE`;
  const endingNow =
    ending.status === "cancelled"
      ? ACTIVE_RUN_STATUSES.some((status) => status === run?.status)
      : run?.status === ending.status;
  if (!endingNow) return;
  const logged = await tx.sessionEntry.findMany({
    where: { runId, type: { in: ["run.started", "run.finished"] } },
    select: {
      type: true,
      sessionId: true,
      botId: true,
      session: { select: { kind: true, parentSessionId: true } },
    },
  });
  const started = logged.find((entry) => entry.type === "run.started");
  if (!started?.botId || logged.some((entry) => entry.type === "run.finished")) return;
  const recorded = usage
    ? undefined
    : await tx.usageRecord.aggregate({
        where: { runId },
        _sum: { inputTokens: true, outputTokens: true },
      });
  const outcome = {
    ...ending,
    usage: usage ?? {
      inputTokens: recorded?._sum.inputTokens ?? 0,
      outputTokens: recorded?._sum.outputTokens ?? 0,
    },
  };
  await appendSessionEntryInTransaction(tx, {
    type: "run.finished",
    sessionId: started.sessionId as SessionId,
    botId: started.botId,
    runId,
    payload: outcome,
  });
  const { kind, parentSessionId } = started.session;
  if (kind !== "routine" || !parentSessionId) return;
  await appendSessionEntryInTransaction(tx, {
    type: "routine.finished",
    sessionId: parentSessionId as SessionId,
    botId: started.botId,
    runId,
    payload: { ...outcome, result },
  });
}
