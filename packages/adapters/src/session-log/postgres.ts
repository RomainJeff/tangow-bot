import type { NewSession, SessionEntryDraft, SessionLog } from "@rakazo/adapter-kit";
import { SessionReadError } from "@rakazo/adapter-kit";
import type { SessionEntry, SessionId } from "@rakazo/contracts";
import { EntryId } from "@rakazo/contracts";
import type { PrismaClient, SessionEntryRow } from "@rakazo/db";
import {
  appendSessionEntryInTransaction,
  createSessionInTransaction,
  Prisma,
  sessionEntryFromRow,
} from "@rakazo/db";

const HEAD = Prisma.sql`ORDER BY e.seq DESC LIMIT 1`;

export class PostgresSessionLog implements SessionLog<Prisma.TransactionClient> {
  constructor(private readonly prisma: PrismaClient) {}

  createSession(tx: Prisma.TransactionClient, session: NewSession): Promise<SessionId> {
    return createSessionInTransaction(tx, session);
  }

  append(tx: Prisma.TransactionClient, draft: SessionEntryDraft): Promise<SessionEntry> {
    return appendSessionEntryInTransaction(tx, draft);
  }

  readTail(sessionId: SessionId): Promise<SessionEntry[]> {
    return this.walk(sessionId, HEAD, Prisma.sql`chain.type <> 'compaction'`);
  }

  readPage(
    sessionId: SessionId,
    { before, limit }: { before?: EntryId; limit: number },
  ): Promise<SessionEntry[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError(`limit must be a positive integer, got ${limit}`);
    }
    const start =
      before === undefined
        ? HEAD
        : Prisma.sql`AND e.id = (
            SELECT "parentId" FROM session_entries WHERE id = ${before} AND "sessionId" = ${sessionId}
          )`;
    return this.walk(sessionId, start, Prisma.sql`chain.depth < ${limit}`);
  }

  async readRun(runId: string): Promise<SessionEntry[]> {
    const rows = await this.prisma.sessionEntry.findMany({
      where: { runId },
      orderBy: { seq: "asc" },
    });
    return rows.map(sessionEntryFromRow);
  }

  /**
   * Walk parent links from the entry `start` selects while `proceed` holds for the entry reached.
   * Each step is a primary key lookup, and a parent always has a lower seq, so the walk ends. A
   * parent the walk looks for and does not find throws `SessionReadError`.
   */
  private async walk(
    sessionId: SessionId,
    start: Prisma.Sql,
    proceed: Prisma.Sql,
  ): Promise<SessionEntry[]> {
    const rows = await this.prisma.$queryRaw<Array<SessionEntryRow & { wantsParent: boolean }>>`
      WITH RECURSIVE chain AS (
        (SELECT e.*, 1 AS depth FROM session_entries e WHERE e."sessionId" = ${sessionId} ${start})
        UNION ALL
        SELECT e.*, chain.depth + 1 FROM session_entries e
        JOIN chain ON e.id = chain."parentId" AND e."sessionId" = chain."sessionId" AND e.seq < chain.seq
        WHERE ${proceed}
      )
      SELECT id, "sessionId", seq, "parentId", type, payload, "botId", "runId", "createdAt",
        ${proceed} AS "wantsParent"
      FROM chain ORDER BY seq`;
    const [oldest] = rows;
    if (oldest?.wantsParent && oldest.parentId !== null) {
      throw new SessionReadError(sessionId, EntryId.parse(oldest.parentId));
    }
    return rows.map(sessionEntryFromRow);
  }
}
