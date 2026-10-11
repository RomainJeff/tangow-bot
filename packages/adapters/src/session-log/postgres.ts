import type { NewSession, SessionEntryDraft, SessionLog } from "@rakazo/adapter-kit";
import { assertEntryCount, SessionReadError } from "@rakazo/adapter-kit";
import type { SessionEntry, SessionId } from "@rakazo/contracts";
import { EntryId } from "@rakazo/contracts";
import { compactionFirst } from "@rakazo/core";
import type { PrismaClient, SessionEntryRow } from "@rakazo/db";
import {
  appendSessionEntryInTransaction,
  createSessionInTransaction,
  Prisma,
  sessionEntryFromRow,
} from "@rakazo/db";

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
  ): Promise<SessionEntry[]> {
    assertEntryCount("limit", limit);
    const start =
      before === undefined
        ? HEAD
        : Prisma.sql`AND e.id = (
            SELECT "parentId" FROM session_entries WHERE id = ${before} AND "sessionId" = ${sessionId}
          )`;
    return this.walk(sessionId, start, { stopAt: Prisma.sql`-1`, limit });
  }

  async readRun(runId: string): Promise<SessionEntry[]> {
    const rows = await this.prisma.sessionEntry.findMany({
      where: { runId },
      orderBy: { seq: "asc" },
    });
    return rows.map(sessionEntryFromRow);
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
  ): Promise<SessionEntry[]> {
    const underLimit = limit === undefined ? Prisma.empty : Prisma.sql`AND chain.depth < ${limit}`;
    const rows = await this.prisma.$queryRaw<Array<SessionEntryRow & { missingParent: boolean }>>`
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
