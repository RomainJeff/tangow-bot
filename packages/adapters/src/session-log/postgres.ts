import type {
  NewSession,
  RunSearchInput,
  SessionEntryDraft,
  SessionLog,
} from "@tangow/adapter-kit";
import { assertEntryCount, SessionReadError } from "@tangow/adapter-kit";
import type {
  RunSearchLimitation,
  RunSearchPage,
  SessionEntry,
  SessionId,
} from "@tangow/contracts";
import { CARD_STATE_TYPES, EntryId } from "@tangow/contracts";
import { compactionFirst } from "@tangow/core";
import type { PrismaClient, SessionEntryRow } from "@tangow/db";
import {
  appendSessionEntryInTransaction,
  createSessionInTransaction,
  Prisma,
  sessionEntryFromRow,
} from "@tangow/db";

import {
  boundedSearchPage,
  openRunSearch,
  RUN_SEARCH_BATCH_ENTRIES,
  RUN_SEARCH_CHAIN_ENTRIES,
  RUN_SEARCH_RECORD_BYTES,
  RUN_SEARCH_SCAN_ENTRIES,
  searchExcerpt,
  searchRunSessions,
} from "./run-search.js";

const HEAD = Prisma.sql`ORDER BY e.seq DESC LIMIT 1`;
/** The last seq a compaction `e` covers, where a tail that met it ends; -1 for any other entry. */
const COVERED_UP_TO = Prisma.sql`CASE WHEN e.type = 'compaction'
  THEN (e.payload ->> 'coveredUpToSeq')::int ELSE -1 END`;

export class PostgresSessionLog implements SessionLog<Prisma.TransactionClient> {
  constructor(private readonly prisma: PrismaClient) {}

  createSession(tx: Prisma.TransactionClient, session: NewSession): Promise<SessionId> {
    return createSessionInTransaction(tx, session);
  }

  append(tx: Prisma.TransactionClient, draft: SessionEntryDraft): Promise<SessionEntry> {
    return appendSessionEntryInTransaction(tx, draft);
  }

  async readTail(
    sessionId: SessionId,
    { maxEntries }: { maxEntries?: number } = {},
  ): Promise<SessionEntry[]> {
    if (maxEntries !== undefined) assertEntryCount("maxEntries", maxEntries);
    return compactionFirst(
      await this.walk(sessionId, HEAD, { stopAt: COVERED_UP_TO, limit: maxEntries }),
    );
  }

  readPage(
    sessionId: SessionId,
    { before, limit }: { before?: EntryId; limit: number },
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<SessionEntry[]> {
    assertEntryCount("limit", limit);
    const start =
      before === undefined
        ? HEAD
        : Prisma.sql`AND e.id = (
            SELECT "parentId" FROM session_entries WHERE id = ${before} AND "sessionId" = ${sessionId}
          )`;
    return this.walk(sessionId, start, { stopAt: Prisma.sql`-1`, limit }, tx);
  }

  async readAround(
    sessionId: SessionId,
    entryId: EntryId,
    limit: number,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<SessionEntry[]> {
    assertEntryCount("limit", limit);
    const older = Math.floor(limit / 2);
    const rows = await tx.$queryRaw<SessionEntryRow[]>`
      WITH RECURSIVE chain AS (
        (SELECT e.id, e.seq, e."parentId", 0 AS depth,
            CASE WHEN e.id = ${entryId} THEN 0 END AS "targetDepth"
          FROM session_entries e WHERE e."sessionId" = ${sessionId} ${HEAD})
        UNION ALL
        SELECT e.id, e.seq, e."parentId", chain.depth + 1,
          COALESCE(chain."targetDepth", CASE WHEN e.id = ${entryId} THEN chain.depth + 1 END)
        FROM session_entries e
        JOIN chain ON e.id = chain."parentId" AND e."sessionId" = ${sessionId} AND e.seq < chain.seq
        WHERE chain."targetDepth" IS NULL OR chain.depth < chain."targetDepth" + ${older}
      ),
      bounds AS (
        SELECT max("targetDepth") AS target, max(depth) AS oldest FROM chain
      )
      SELECT e.* FROM chain
      JOIN bounds ON bounds.target IS NOT NULL
      JOIN session_entries e ON e.id = chain.id AND e."sessionId" = ${sessionId}
      WHERE chain.depth >= bounds.target - (${limit - 1} - (bounds.oldest - bounds.target))
      ORDER BY e.seq`;
    return rows.map(sessionEntryFromRow);
  }

  async readRun(runId: string, { limit }: { limit?: number } = {}): Promise<SessionEntry[]> {
    if (limit !== undefined) assertEntryCount("limit", limit);
    const newest = limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${limit}`;
    const rows = await this.prisma.$queryRaw<SessionEntryRow[]>`
      WITH run AS (SELECT * FROM session_entries WHERE "runId" = ${runId})
      SELECT * FROM (
        SELECT * FROM run
        UNION ALL
        SELECT answer.* FROM run ask
        JOIN session_entries answer ON answer."sessionId" = ask."sessionId"
          AND answer.type = 'user.message' AND answer.seq > ask.seq
          AND answer.payload -> 'replyTo' ->> 'entryId' = ask.id
        WHERE ask.type IN ('assistant.ask', 'assistant.choice')
        UNION ALL
        SELECT state.* FROM (SELECT "sessionId", min(seq) AS seq FROM run GROUP BY "sessionId") start
        JOIN session_entries state ON state."sessionId" = start."sessionId" AND state.seq > start.seq
        WHERE state.type IN (${Prisma.join(CARD_STATE_TYPES)})
          AND state.payload ->> 'target' IN (SELECT id FROM run)
        ORDER BY "createdAt" DESC, seq DESC ${newest}
      ) entries ORDER BY "createdAt", seq`;
    return rows.map(sessionEntryFromRow);
  }

  searchRun(
    input: RunSearchInput,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<RunSearchPage> {
    return searchRunSessions(
      input,
      (id) => this.searchState(id, tx),
      (page) => this.searchRunSession(page, tx),
    );
  }

  private async searchState(sessionId: SessionId, tx: Prisma.TransactionClient) {
    const [state] = await tx.$queryRaw<
      Array<{ id: string | null; seq: number | null; cut: number }>
    >`
      SELECT h.id, h.seq, COALESCE((SELECT max(seq) FROM session_entries
        WHERE "sessionId" = ${sessionId} AND type IN ('rewind', 'clear')), -1) AS cut
      FROM sessions s LEFT JOIN LATERAL (
        SELECT id, seq FROM session_entries WHERE "sessionId" = s.id ORDER BY seq DESC LIMIT 1
      ) h ON true WHERE s.id = ${sessionId}`;
    return {
      head: state?.id ? { id: EntryId.parse(state.id), seq: state.seq! } : null,
      cut: state?.cut ?? -1,
    };
  }

  private async searchRunSession(
    input: RunSearchInput,
    tx: Prisma.TransactionClient,
  ): Promise<RunSearchPage> {
    const { sessionId, runId, botId } = input.scope;
    const cursor = openRunSearch(input, await this.searchState(sessionId, tx));
    if ("status" in cursor) return cursor;
    const chain = Prisma.sql`WITH RECURSIVE chain AS (
      (SELECT id, seq, "parentId", 1 AS depth FROM session_entries
        WHERE "sessionId" = ${sessionId} ORDER BY seq DESC LIMIT 1)
      UNION ALL
      SELECT e.id, e.seq, e."parentId", c.depth + 1 FROM session_entries e
      JOIN chain c ON e.id = c."parentId" AND e."sessionId" = ${sessionId} AND e.seq < c.seq
      WHERE c.depth < ${RUN_SEARCH_CHAIN_ENTRIES}
    )`;
    const [membership] = await tx.$queryRaw<
      Array<{ present: boolean; truncated: boolean; broken: boolean; position: boolean }>
    >`
      ${chain} SELECT
        EXISTS(SELECT 1 FROM chain WHERE id = ${cursor.head?.id ?? ""} AND seq = ${cursor.head?.seq ?? -1}) AS present,
        EXISTS(SELECT 1 FROM chain WHERE depth = ${RUN_SEARCH_CHAIN_ENTRIES} AND "parentId" IS NOT NULL) AS truncated,
        EXISTS(SELECT 1 FROM chain c WHERE c."parentId" IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM session_entries p WHERE p.id = c."parentId" AND p."sessionId" = ${sessionId} AND p.seq < c.seq)) AS broken,
        ${cursor.after} = -1 OR EXISTS(SELECT 1 FROM chain WHERE seq = ${cursor.after}) AS position`;
    if (cursor.head && !membership?.present)
      return { status: "unavailable", reason: "stale_cursor" };
    if (!membership?.position) return { status: "unavailable", reason: "invalid_cursor" };
    if (!cursor.head) return boundedSearchPage(input, cursor, [], false, []);
    const limitations: RunSearchLimitation[] = [];
    if (membership?.truncated) limitations.push("scan_limit");
    if (membership?.broken) limitations.push("unreadable_records");
    const candidates: Array<{
      seq: number;
      hit?: {
        runId: string;
        sessionId: SessionId;
        entryId: EntryId;
        ts: string;
        excerpt: string;
      };
    }> = [];
    let after = cursor.after;
    let more = false;
    let hits = 0;
    while (candidates.length < RUN_SEARCH_SCAN_ENTRIES) {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          seq: number;
          createdAt: Date;
          oversized: boolean;
          text: string | null;
        }>
      >`
        ${chain}, candidates AS MATERIALIZED (
          SELECT e.id, e.seq, e."createdAt", e.type,
            CASE WHEN octet_length(e.payload::text) <= ${RUN_SEARCH_RECORD_BYTES} THEN e.payload END AS payload,
            octet_length(e.payload::text) > ${RUN_SEARCH_RECORD_BYTES} AS oversized
          FROM chain c JOIN session_entries e ON e.id = c.id
          WHERE e.seq > ${after} AND e.seq <= ${cursor.head.seq}
            AND e."runId" = ${runId} AND e."botId" = ${botId}
            AND e.type IN ('assistant.text', 'tool.result', 'subagent', 'routine.finished')
            AND (e.type <> 'tool.result' OR EXISTS (
              SELECT 1 FROM chain cc JOIN session_entries call ON call.id = cc.id
              WHERE call.type = 'tool.call' AND call."runId" = ${runId} AND call."botId" = ${botId}
                AND call.seq < e.seq AND call.payload ->> 'callId' = e.payload ->> 'callId'))
          ORDER BY e.seq LIMIT ${RUN_SEARCH_BATCH_ENTRIES + 1}
        )
        SELECT id, seq, "createdAt", oversized, CASE type
          WHEN 'tool.result' THEN payload ->> 'output'
          WHEN 'subagent' THEN payload ->> 'result'
          WHEN 'routine.finished' THEN payload ->> 'result'
          WHEN 'assistant.text' THEN (SELECT string_agg(b ->> 'text', E'\\n' ORDER BY n)
            FROM jsonb_array_elements(payload -> 'blocks') WITH ORDINALITY AS blocks(b, n)
            WHERE b ->> 'kind' = 'text') END AS text
        FROM candidates ORDER BY seq`;
      more = rows.length > RUN_SEARCH_BATCH_ENTRIES;
      for (const row of rows.slice(0, RUN_SEARCH_BATCH_ENTRIES)) {
        if (row.oversized) limitations.push("oversized_records");
        const excerpt = row.text === null ? undefined : searchExcerpt(input, row.text);
        candidates.push({
          seq: row.seq,
          ...(excerpt === undefined
            ? {}
            : {
                hit: {
                  runId,
                  sessionId,
                  entryId: EntryId.parse(row.id),
                  ts: row.createdAt.toISOString(),
                  excerpt,
                },
              }),
        });
        after = row.seq;
        if (excerpt !== undefined) hits++;
        if (hits > 10) {
          more = true;
          break;
        }
      }
      if (!more || hits > 10) break;
    }
    return boundedSearchPage(input, cursor, candidates, more, limitations);
  }

  async readEntry(sessionId: SessionId, entryId: EntryId): Promise<SessionEntry | undefined> {
    const row = await this.prisma.sessionEntry.findFirst({ where: { id: entryId, sessionId } });
    return row ? sessionEntryFromRow(row) : undefined;
  }

  /**
   * Walk parent links from the entry `start` selects, at most `limit` entries, and once an entry
   * whose `stopAt` is a seq was reached, only while the parent's seq is above it. Each step is a
   * primary key lookup, and a parent always has a lower seq, so the walk ends.
   */
  private async walk(
    sessionId: SessionId,
    start: Prisma.Sql,
    { stopAt, limit }: { stopAt: Prisma.Sql; limit?: number },
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<SessionEntry[]> {
    const underLimit = limit === undefined ? Prisma.empty : Prisma.sql`AND chain.depth < ${limit}`;
    const rows = await tx.$queryRaw<Array<SessionEntryRow & { missingParent: boolean }>>`
      WITH RECURSIVE chain AS (
        (SELECT e.*, 1 AS depth, ${stopAt} AS "stopAt"
          FROM session_entries e WHERE e."sessionId" = ${sessionId} ${start})
        UNION ALL
        SELECT e.*, chain.depth + 1,
          CASE WHEN chain."stopAt" >= 0 THEN chain."stopAt" ELSE ${stopAt} END
        FROM session_entries e
        JOIN chain ON e.id = chain."parentId" AND e."sessionId" = chain."sessionId" AND e.seq < chain.seq
        WHERE e.seq > chain."stopAt" ${underLimit}
      )
      SELECT id, "sessionId", seq, "parentId", type, payload, "botId", "runId", "createdAt",
        CASE WHEN chain.seq = min(chain.seq) OVER () AND chain."parentId" IS NOT NULL ${underLimit}
          THEN NOT EXISTS (
            SELECT 1 FROM session_entries p
            WHERE p.id = chain."parentId" AND p."sessionId" = chain."sessionId" AND p.seq < chain.seq)
          ELSE false END AS "missingParent"
      FROM chain ORDER BY seq`;
    const [oldest] = rows;
    if (oldest?.missingParent) {
      throw new SessionReadError(sessionId, EntryId.parse(oldest.parentId));
    }
    return rows.map(sessionEntryFromRow);
  }
}
