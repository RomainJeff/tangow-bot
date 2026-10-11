import type { SessionLog } from "@rakazo/adapter-kit";
import type {
  EntryId,
  ProductEvent,
  SessionEntry,
  ThreadMessage,
  ThreadMessagePage,
} from "@rakazo/contracts";
import { SessionId } from "@rakazo/contracts";
import { appendedEntries, visibleEntries } from "@rakazo/core";
import { hiddenPeerRunIds, type Prisma, type PrismaClient } from "@rakazo/db";

type ThreadDb = PrismaClient | Prisma.TransactionClient;
type PageLog = Pick<SessionLog<unknown>, "readPage" | "readAround">;

const THREAD_PAGE_SIZE = 100;

export async function threadSessionId(prisma: ThreadDb, threadId: string): Promise<SessionId> {
  const { sessionId } = await prisma.thread.findUniqueOrThrow({
    where: { id: threadId },
    select: { sessionId: true },
  });
  return SessionId.parse(sessionId);
}

function olderCursor(page: readonly SessionEntry[]): EntryId | null {
  const oldest = page[0];
  return oldest?.parentId ? oldest.id : null;
}

async function withoutHiddenPeerRuns(
  prisma: ThreadDb,
  entries: readonly SessionEntry[],
): Promise<SessionEntry[]> {
  const runIds = [...new Set(entries.flatMap((entry) => (entry.runId ? [entry.runId] : [])))];
  return visibleEntries(entries, { hiddenPeerRunIds: await hiddenPeerRunIds(prisma, runIds) });
}

export async function loadEntryPage(
  deps: { prisma: ThreadDb; sessionLog: PageLog },
  { threadId, sessionId }: { threadId: string; sessionId: SessionId },
  query: { before?: EntryId; around?: { entryId: EntryId }; includePeerRuns?: boolean },
): Promise<ThreadMessagePage> {
  const around = query.around
    ? await deps.sessionLog.readAround(sessionId, query.around.entryId, THREAD_PAGE_SIZE)
    : [];
  const page =
    around.length > 0
      ? around
      : await deps.sessionLog.readPage(sessionId, {
          before: query.around ? undefined : query.before,
          limit: THREAD_PAGE_SIZE,
        });
  return {
    threadId,
    entries: query.includePeerRuns ? page : await withoutHiddenPeerRuns(deps.prisma, page),
    olderCursor: olderCursor(page),
  };
}

export async function loadAllMessages(
  prisma: PrismaClient,
  threadId: string,
  pageSize: number,
): Promise<ThreadMessage[]> {
  const messages: ThreadMessage[] = [];
  let after = -1;
  while (true) {
    const rows = await prisma.message.findMany({
      where: { threadId, seq: { gt: after } },
      orderBy: { seq: "asc" },
      take: pageSize,
    });
    messages.push(...rows.map(toThreadMessage));
    const last = rows.at(-1);
    if (!last || rows.length < pageSize) return messages;
    after = last.seq;
  }
}

export async function isPeerRun(
  prisma: ThreadDb,
  runId: string | undefined,
  cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (!runId) return false;
  let peerRun = cache.get(runId);
  if (!peerRun) {
    peerRun = hiddenPeerRunIds(prisma, [runId]).then((ids) => ids.has(runId));
    cache.set(runId, peerRun);
  }
  return peerRun;
}

export async function forwardedThreadEvent(
  prisma: ThreadDb,
  event: ProductEvent,
  peerRuns: Map<string, Promise<boolean>>,
): Promise<ProductEvent | null> {
  if (event.type !== "session.entry.appended") {
    const hidden = await isPeerRun(prisma, event.runId, peerRuns);
    return hidden && !shouldForwardPeerThreadEvent(event) ? null : event;
  }
  const entries = appendedEntries(event);
  const hiddenPeerRunIds = new Set<string>();
  for (const runId of new Set(entries.flatMap((entry) => (entry.runId ? [entry.runId] : [])))) {
    if (await isPeerRun(prisma, runId, peerRuns)) hiddenPeerRunIds.add(runId);
  }
  if (hiddenPeerRunIds.size === 0) return event;
  const visible = visibleEntries(entries, { hiddenPeerRunIds });
  return visible.length > 0 ? { ...event, payload: { ...event.payload, entries: visible } } : null;
}

const FORWARDED_PEER_RUN_EVENTS: ReadonlySet<string> = new Set([
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.waiting_input",
  "computer.takeover.requested",
]);

export function shouldForwardPeerThreadEvent(event: { type: string }): boolean {
  return FORWARDED_PEER_RUN_EVENTS.has(event.type);
}

function toThreadMessage(row: {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: Prisma.JsonValue;
  botId: string | null;
  replyToMessageId: string | null;
  replyQuote: string | null;
  runId: string | null;
  clientNonce: string | null;
  createdAt: Date;
}): ThreadMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    seq: row.seq,
    role: row.role as ThreadMessage["role"],
    blocks: row.blocks as ThreadMessage["blocks"],
    botId: row.botId ?? undefined,
    replyToMessageId: row.replyToMessageId ?? undefined,
    replyQuote: row.replyQuote ?? undefined,
    runId: row.runId ?? undefined,
    clientNonce: row.clientNonce ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}
