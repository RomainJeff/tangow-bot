import { randomUUID } from "node:crypto";
import { decodeEntries, encodeEntries } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { sessionEntryFromRow } from "./sessions.js";

/** Entries per read and per insert. */
const PAGE = 1000;

/**
 * Streams a thread's main session and every session under it, one session at a time and a page of
 * entries at a time, each page encoded as the JSONL lines `write` appends to that session's file.
 * Returns the sessions written, the main one first.
 */
export async function exportThreadSessions(
  prisma: PrismaClient,
  threadId: string,
  write: (sessionId: string, lines: string) => Promise<void>,
): Promise<string[]> {
  const { sessionId } = await prisma.thread.findUniqueOrThrow({
    where: { id: threadId },
    select: { sessionId: true },
  });
  const sessions = [sessionId];
  for (let index = 0; index < sessions.length; index += 1) {
    const current = sessions[index]!;
    let after = -1;
    for (;;) {
      const rows = await prisma.sessionEntry.findMany({
        where: { sessionId: current, seq: { gt: after } },
        orderBy: { seq: "asc" },
        take: PAGE,
      });
      if (rows.length === 0) break;
      await write(current, encodeEntries(rows.map(sessionEntryFromRow)));
      after = rows.at(-1)!.seq;
    }
    const children = await prisma.conversationSession.findMany({
      where: { parentSessionId: current },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    sessions.push(...children.map((child) => child.id));
  }
  return sessions;
}

/** One exported session's file: the session's id and its JSONL lines. */
export type SessionFile = { sessionId: string; jsonl: string };

/**
 * Appends exported sessions to a thread whose main session is empty: the session no entry names
 * as its child becomes the thread's main session, and each child a new session under the one that
 * named it. Every entry, session and run gets a new id, and every reference to one follows it, so
 * the import stands apart from the sessions it was exported from.
 */
export async function importThreadSessions(
  prisma: PrismaClient,
  threadId: string,
  files: readonly SessionFile[],
): Promise<{ sessions: number; entries: number }> {
  const sessions = files.map(({ sessionId, jsonl }) => ({
    sessionId,
    entries: decodeEntries(jsonl),
  }));
  const children = new Map<string, { parent: string; kind: "routine" | "subagent"; by: string }>();
  for (const { sessionId, entries } of sessions) {
    for (const entry of entries) {
      if (entry.type === "routine.started") {
        children.set(entry.payload.sessionId, { parent: sessionId, kind: "routine", by: entry.id });
      } else if (entry.type === "subagent" && entry.payload.sessionId) {
        const call = entries.find(
          (candidate) =>
            candidate.type === "tool.call" && candidate.payload.callId === entry.payload.callId,
        );
        children.set(entry.payload.sessionId, {
          parent: sessionId,
          kind: "subagent",
          by: call?.id ?? entry.id,
        });
      }
    }
  }
  const mains = sessions.filter(({ sessionId }) => !children.has(sessionId));
  if (mains.length !== 1) {
    throw new Error(`Expected one main session among the files, found ${mains.length}`);
  }
  const ordered = [mains[0]!];
  for (let index = 0; index < ordered.length; index += 1) {
    const parent = ordered[index]!.sessionId;
    ordered.push(...sessions.filter(({ sessionId }) => children.get(sessionId)?.parent === parent));
  }

  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const [thread] = await tx.$queryRaw<
        Array<{ sessionId: string; spaceId: string; logged: boolean }>
      >`
        SELECT t."sessionId", t."spaceId",
          EXISTS (SELECT 1 FROM session_entries e WHERE e."sessionId" = t."sessionId") AS logged
        FROM threads t WHERE t.id = ${threadId} FOR UPDATE`;
      if (!thread) throw new Error(`Thread ${threadId} does not exist`);
      if (thread.logged) throw new Error(`Thread ${threadId} already holds entries`);

      const renamed = new Map<string, string>([[mains[0]!.sessionId, thread.sessionId]]);
      for (const { sessionId, entries } of ordered) {
        if (sessionId !== mains[0]!.sessionId) renamed.set(sessionId, randomUUID());
        for (const entry of entries) {
          renamed.set(entry.id, randomUUID());
          if (entry.runId && !renamed.has(entry.runId)) renamed.set(entry.runId, randomUUID());
        }
      }
      const rename = <T>(value: T): T => {
        if (typeof value === "string") return (renamed.get(value) ?? value) as T;
        if (Array.isArray(value)) return value.map(rename) as T;
        if (value && typeof value === "object") {
          return Object.fromEntries(
            Object.entries(value).map(([key, nested]) => [key, rename(nested)]),
          ) as T;
        }
        return value;
      };

      let total = 0;
      for (const { sessionId, entries } of ordered) {
        const id = renamed.get(sessionId)!;
        const child = children.get(sessionId);
        if (child) {
          await tx.conversationSession.create({
            data: {
              id,
              spaceId: thread.spaceId,
              kind: child.kind,
              parentSessionId: renamed.get(child.parent)!,
              ...(child.kind === "subagent" ? { parentEntryId: renamed.get(child.by)! } : {}),
            },
          });
        }
        const rows = entries.map((entry) => ({
          id: renamed.get(entry.id)!,
          sessionId: id,
          seq: entry.seq,
          parentId: entry.parentId && rename(entry.parentId),
          type: entry.type,
          payload: rename(entry.payload) as Prisma.InputJsonValue,
          botId: entry.botId ?? null,
          runId: entry.runId ? rename(entry.runId) : null,
          createdAt: new Date(entry.ts),
        }));
        for (let start = 0; start < rows.length; start += PAGE) {
          await tx.sessionEntry.createMany({ data: rows.slice(start, start + PAGE) });
        }
        const head = rows.reduce<(typeof rows)[number] | undefined>(
          (newest, row) => (!newest || row.seq > newest.seq ? row : newest),
          undefined,
        );
        await tx.conversationSession.update({
          where: { id },
          data: { nextEntrySeq: head ? head.seq + 1 : 0, headEntryId: head?.id ?? null },
        });
        total += rows.length;
      }
      return { sessions: ordered.length, entries: total };
    },
    { timeout: 120_000, maxWait: 120_000 },
  );
}
