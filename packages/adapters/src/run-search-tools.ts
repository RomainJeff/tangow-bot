import type { RunSearchInput, SessionLog } from "@tangow/adapter-kit";
import { FactualRunRecapSchema, SessionId } from "@tangow/contracts";
import { matchesSearchQuery, snippetAroundMatch } from "@tangow/core";
import type { PrismaClient } from "@tangow/db";
import { ENTRY_ON_CHAIN, groupMembershipFilter, Prisma, sharedWithFilter } from "@tangow/db";
import { z } from "zod";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  RUN_SEARCH_MAX_BYTES,
  RUN_SEARCH_RECORD_BYTES,
  searchBinding,
} from "./session-log/run-search.js";

const Args = z
  .object({
    runId: z.string().min(1).max(200).optional(),
    query: z.string().max(160).default(""),
    cursor: z.string().max(2048).optional(),
  })
  .strict();
const CatalogCursor = z.object({
  binding: z.string(),
  before: z.object({ at: z.string().datetime(), id: z.string().min(1).max(200) }),
  snapshot: z.string().datetime(),
});
const DENIED = { status: "unavailable", reason: "not_found_or_denied" } as const;
const INVALID = { status: "unavailable", reason: "invalid_cursor" } as const;
type Actor = { userId: string; spaceId: string; threadId: string; botId: string };
type DbRun = NonNullable<Awaited<ReturnType<Prisma.TransactionClient["run"]["findUnique"]>>>;
type Redaction = RunSearchInput["redaction"];
type AuthorizedScope = Pick<
  RunSearchInput["scope"],
  "sessionId" | "raisedSessionId" | "authorizationKey"
>;
type Authorization =
  | AuthorizedScope
  | { status: "unavailable"; reason: "unreadable_records" | "scan_limit" }
  | undefined;

async function activeEntry(tx: Prisma.TransactionClient, sessionId: string, where: Prisma.Sql) {
  const [entry] = await tx.$queryRaw<
    Array<{ id: string; runId: string | null; botId: string | null; channel: boolean }>
  >`
    SELECT e.id, e."runId", e."botId",
      CASE WHEN e.type = 'user.message' THEN e.payload -> 'blocks' @> '[{"kind":"channel_message"}]'::jsonb
        ELSE false END AS channel
    FROM session_entries e
    WHERE e."sessionId" = ${sessionId} AND ${where} AND ${ENTRY_ON_CHAIN} LIMIT 1`;
  return entry;
}

async function authorizeRun(
  tx: Prisma.TransactionClient,
  actor: Actor,
  run: DbRun,
  mainId: string,
  states: Map<string, { cut: number; broken: boolean }>,
): Promise<Authorization> {
  const revisions: Array<{ sessionId: string; cut: number }> = [];
  const seen = new Set<string>();
  let currentRun = run;
  let currentId = run.sessionId;
  let anchoredInteractive = false;
  for (let depth = 0; depth < 16; depth++) {
    if (seen.has(currentId)) return undefined;
    seen.add(currentId);
    if (
      currentRun.userId !== actor.userId ||
      currentRun.spaceId !== actor.spaceId ||
      currentRun.threadId !== actor.threadId ||
      currentRun.botId !== actor.botId ||
      currentRun.trigger === "messaging"
    )
      return undefined;
    const session = await tx.conversationSession.findUnique({ where: { id: currentId } });
    if (!session || session.spaceId !== actor.spaceId) return undefined;
    let state = states.get(currentId);
    if (!state) {
      const [found] = await tx.$queryRaw<Array<{ cut: number; broken: boolean }>>`
        SELECT COALESCE((SELECT max(seq) FROM session_entries
          WHERE "sessionId" = ${currentId} AND type IN ('rewind', 'clear')), -1) AS cut,
          EXISTS(SELECT 1 FROM session_entries e WHERE e."sessionId" = ${currentId}
            AND e."parentId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM session_entries p
              WHERE p.id = e."parentId" AND p."sessionId" = e."sessionId" AND p.seq < e.seq)) AS broken`;
      if (!found) return undefined;
      state = found;
      states.set(currentId, state);
    }
    if (state.broken) return { status: "unavailable", reason: "unreadable_records" } as const;
    revisions.push({ sessionId: currentId, cut: state.cut });
    if (currentRun.sourceMessageId) {
      const source = await tx.sessionEntry.findUnique({
        where: { id: currentRun.sourceMessageId },
        select: { sessionId: true },
      });
      if (!source || (source.sessionId !== currentId && source.sessionId !== mainId))
        return undefined;
      const active = await activeEntry(
        tx,
        source.sessionId,
        Prisma.sql`e.id = ${currentRun.sourceMessageId}`,
      );
      if (!active || active.channel) return undefined;
    }
    if (session.kind === "thread") {
      if (session.id !== mainId || session.threadId !== actor.threadId) return undefined;
      if (
        !anchoredInteractive &&
        !(await activeEntry(
          tx,
          currentId,
          Prisma.sql`e."runId" = ${currentRun.id} AND e."botId" = ${actor.botId}`,
        ))
      )
        return undefined;
      return {
        sessionId: SessionId.parse(run.sessionId),
        ...(run.sessionId !== mainId ? { raisedSessionId: SessionId.parse(mainId) } : {}),
        authorizationKey: searchBinding({ actor, revisions }),
      };
    }
    if (!session.parentSessionId) return undefined;
    if (session.kind === "interactive") {
      if (session.parentSessionId !== mainId || !session.parentEntryId) return undefined;
      const anchor = await activeEntry(
        tx,
        mainId,
        currentRun.sourceMessageId
          ? Prisma.sql`e.id = ${session.parentEntryId} AND e.id = ${currentRun.sourceMessageId}`
          : Prisma.sql`e.id = ${session.parentEntryId} AND e.type = 'run.opened'
              AND e."runId" = ${currentRun.id} AND e."botId" = ${actor.botId}
              AND e.payload ->> 'sessionId' = ${session.id}`,
      );
      if (!anchor || anchor.channel) return undefined;
      anchoredInteractive = true;
      currentRun = { ...currentRun, sessionId: mainId };
    } else if (session.kind === "subagent") {
      if (!session.parentEntryId || !currentRun.parentRunId) return undefined;
      const launch = await activeEntry(
        tx,
        session.parentSessionId,
        Prisma.sql`
        e.id = ${session.parentEntryId} AND e.type = 'tool.call'
        AND e."runId" = ${currentRun.parentRunId} AND e."botId" = ${actor.botId}
        AND e.payload ->> 'name' = 'run_subagent'`,
      );
      if (!launch) return undefined;
      const parent = await tx.run.findUnique({ where: { id: currentRun.parentRunId } });
      if (!parent || parent.sessionId !== session.parentSessionId) return undefined;
      currentRun = parent;
    } else if (session.kind === "routine") {
      const launch = await activeEntry(
        tx,
        session.parentSessionId,
        Prisma.sql`
        e.type = 'routine.started' AND e."runId" = ${currentRun.id} AND e."botId" = ${actor.botId}
        AND e.payload ->> 'sessionId' = ${session.id}`,
      );
      if (!launch) return undefined;
      currentRun = { ...currentRun, sessionId: session.parentSessionId, sourceMessageId: null };
    } else return undefined;
    currentId = session.parentSessionId;
  }
  return { status: "unavailable", reason: "scan_limit" };
}

export async function searchRunsFromTool(
  deps: { prisma: PrismaClient; sessionLog: SessionLog<Prisma.TransactionClient> },
  callerRunId: string,
  args: unknown,
  redaction: Redaction,
) {
  const parsed = Args.safeParse(args);
  if (!parsed.success || (parsed.data.runId && !parsed.data.query.trim())) {
    return { status: "unavailable", reason: "invalid_input" };
  }
  const { runId, cursor, query } = parsed.data;
  return deps.prisma.$transaction(async (tx) => {
    const caller = await tx.run.findUnique({ where: { id: callerRunId } });
    if (!caller) return DENIED;
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${caller.threadId} FOR SHARE`;
    const actor: Actor = {
      userId: caller.userId,
      spaceId: caller.spaceId,
      threadId: caller.threadId,
      botId: caller.botId,
    };
    // A group's thread is its creator's; anyone in the group runs bots there.
    const thread = await tx.thread.findFirst({
      where: {
        id: actor.threadId,
        spaceId: actor.spaceId,
        OR: [{ userId: actor.userId }, { group: groupMembershipFilter(actor.userId) }],
      },
    });
    // In a member's thread with a shared bot, the bot is the owner's and the run the member's;
    // in a group, it is one the person who woke it owns or that is shared with them.
    const memberThread = Boolean(thread?.memberBotId) && thread?.memberBotId === actor.botId;
    const bot = await tx.bot.findFirst({
      where: {
        id: actor.botId,
        spaceId: actor.spaceId,
        archivedAt: null,
        ...(memberThread
          ? {}
          : thread?.groupId
            ? { OR: [{ userId: actor.userId }, sharedWithFilter(actor.userId)] }
            : { userId: actor.userId }),
      },
    });
    if (!thread || !bot || thread.externalConversationId) return DENIED;
    if (thread.botId !== actor.botId && !memberThread) {
      if (
        !thread.groupId ||
        !(await tx.chatGroup.findFirst({
          where: {
            id: thread.groupId,
            ...groupMembershipFilter(actor.userId, actor.spaceId),
            archivedAt: null,
            members: { some: { botId: actor.botId } },
          },
        }))
      )
        return DENIED;
    }
    const states = new Map<string, { cut: number; broken: boolean }>();
    const authorizedCaller = await authorizeRun(tx, actor, caller, thread.sessionId, states);
    if (!authorizedCaller) return DENIED;
    if ("status" in authorizedCaller) return authorizedCaller;
    if (runId) {
      const target = await tx.run.findUnique({ where: { id: runId } });
      if (!target) return DENIED;
      const scope = await authorizeRun(tx, actor, target, thread.sessionId, states);
      if (!scope) return DENIED;
      if ("status" in scope) return scope;
      return deps.sessionLog.searchRun(
        {
          scope: { ...scope, botId: actor.botId, runId },
          query: query.trim(),
          cursor,
          redaction,
        },
        tx,
      );
    }
    const binding = searchBinding({
      actor,
      query: query.trim().toLowerCase(),
      revision: authorizedCaller.authorizationKey,
    });
    const continuation = cursor ? CatalogCursor.safeParse(decodeSearchCursor(cursor)) : undefined;
    if (continuation && (!continuation.success || continuation.data.binding !== binding))
      return INVALID;
    const previous = continuation?.success ? continuation.data : undefined;
    const snapshot = previous?.snapshot ?? new Date().toISOString();
    if (previous && previous.before.at > snapshot) return INVALID;
    const rows = await tx.run.findMany({
      where: {
        ...actor,
        id: { not: callerRunId },
        createdAt: { lte: new Date(snapshot) },
        ...(previous
          ? {
              OR: [
                { createdAt: { lt: new Date(previous.before.at) } },
                { createdAt: new Date(previous.before.at), id: { lt: previous.before.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 33,
    });
    const limitations: string[] = [];
    const items: Array<{ runId: string; ts: string; status: string; excerpt: string }> = [];
    let last = previous?.before;
    let more = rows.length > 32;
    for (const row of rows.slice(0, 32)) {
      const position = { at: row.createdAt.toISOString(), id: row.id };
      const scope = await authorizeRun(tx, actor, row, thread.sessionId, states);
      if (scope && "status" in scope) limitations.push(scope.reason);
      if (scope && !("status" in scope)) {
        const [text] = await tx.$queryRaw<Array<{ text: string | null; oversized: boolean }>>`
          SELECT CASE WHEN octet_length(prompt) <= ${RUN_SEARCH_RECORD_BYTES} THEN prompt END AS text,
            octet_length(prompt) > ${RUN_SEARCH_RECORD_BYTES} AS oversized FROM tasks WHERE id = ${row.taskId}`;
        if (text?.oversized) limitations.push("oversized_records");
        const recaps = await tx.$queryRaw<Array<{ recap: unknown; oversized: boolean }>>`
          SELECT CASE WHEN octet_length(e.payload::text) <= ${RUN_SEARCH_RECORD_BYTES}
              THEN e.payload -> 'recap' END AS recap,
            octet_length(e.payload::text) > ${RUN_SEARCH_RECORD_BYTES} AS oversized
          FROM session_entries e WHERE e."sessionId" = ${thread.sessionId}
            AND e."runId" = ${row.id} AND e."botId" = ${actor.botId}
            AND e.type = 'run.recap' AND e.payload ->> 'sessionId' = ${row.sessionId}
            AND ${ENTRY_ON_CHAIN} ORDER BY e.seq DESC LIMIT 1`;
        const stored = recaps[0];
        if (stored?.oversized) limitations.push("oversized_records");
        const recap = FactualRunRecapSchema.safeParse(stored?.recap);
        const facts =
          recap.success && recap.data.state === "available"
            ? [
                ...(recap.data.facts.results ?? []),
                ...(recap.data.facts.decisions ?? []),
                ...(recap.data.facts.limits ?? []),
              ].join("\n")
            : "";
        const safe = redaction.redact([text?.text, facts].filter(Boolean).join("\n"));
        if (!query.trim() || matchesSearchQuery(query, safe)) {
          const item = {
            runId: row.id,
            ts: row.createdAt.toISOString(),
            status: row.status,
            excerpt: snippetAroundMatch(safe, query, 120),
          };
          const proposed = {
            status: "ok",
            items: [...items, item],
            nextCursor: encodeSearchCursor({ binding, before: position, snapshot }),
            incomplete: true,
          };
          if (
            items.length === 10 ||
            Buffer.byteLength(JSON.stringify(proposed)) > RUN_SEARCH_MAX_BYTES
          ) {
            if (items.length === 0) return { status: "unavailable", reason: "budget_too_small" };
            more = true;
            break;
          }
          items.push(item);
        }
      }
      last = position;
    }
    const result = {
      status: "ok",
      items,
      nextCursor: more && last ? encodeSearchCursor({ binding, before: last, snapshot }) : null,
      incomplete: more || limitations.length > 0,
      limitations: [...new Set(limitations)],
    };
    if (Buffer.byteLength(JSON.stringify(result)) > RUN_SEARCH_MAX_BYTES)
      return { status: "unavailable", reason: "budget_too_small" };
    return result;
  });
}
