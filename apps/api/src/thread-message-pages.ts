import type { SessionLog } from "@rakazo/adapter-kit";
import type {
  EntryId,
  ProductEvent,
  SessionEntry,
  ThreadEntry,
  ThreadMessagePage,
} from "@rakazo/contracts";
import { SessionId, toThreadEntry } from "@rakazo/contracts";
import { appendedEntries, visibleEntries } from "@rakazo/core";
import { hiddenPeerRunIds, type Prisma, type PrismaClient, sessionEntryFromRow } from "@rakazo/db";

type ThreadDb = PrismaClient | Prisma.TransactionClient;
type PageLog = Pick<SessionLog<Prisma.TransactionClient>, "readPage" | "readAround">;

const THREAD_PAGE_SIZE = 200;

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

export async function withoutHiddenPeerRuns(
  prisma: ThreadDb,
  entries: readonly ThreadEntry[],
): Promise<ThreadEntry[]> {
  const runIds = [...new Set(entries.flatMap((entry) => (entry.runId ? [entry.runId] : [])))];
  return visibleEntries(entries, { hiddenPeerRunIds: await hiddenPeerRunIds(prisma, runIds) });
}

export async function loadEntryPage(
  deps: { prisma: ThreadDb; sessionLog: PageLog },
  { threadId, sessionId }: { threadId: string; sessionId: SessionId },
  query: { before?: EntryId; around?: { entryId: EntryId }; includePeerRuns?: boolean },
): Promise<ThreadMessagePage> {
  const around = query.around
    ? await deps.sessionLog.readAround(
        sessionId,
        query.around.entryId,
        THREAD_PAGE_SIZE,
        deps.prisma,
      )
    : [];
  const page =
    around.length > 0
      ? around
      : await deps.sessionLog.readPage(
          sessionId,
          { before: query.around ? undefined : query.before, limit: THREAD_PAGE_SIZE },
          deps.prisma,
        );
  const entries = page.map(toThreadEntry);
  return {
    threadId,
    entries: query.includePeerRuns ? entries : await withoutHiddenPeerRuns(deps.prisma, entries),
    olderCursor: olderCursor(page),
  };
}

/** Every entry of a session in seq order, the chain and what a rewind or clear cut alike. */
export async function loadAllEntries(
  prisma: PrismaClient,
  sessionId: string,
  pageSize: number,
): Promise<ThreadEntry[]> {
  const entries: ThreadEntry[] = [];
  let after = -1;
  while (true) {
    const rows = await prisma.sessionEntry.findMany({
      where: { sessionId, seq: { gt: after } },
      orderBy: { seq: "asc" },
      take: pageSize,
    });
    entries.push(...rows.map((row) => toThreadEntry(sessionEntryFromRow(row))));
    const last = rows.at(-1);
    if (!last || rows.length < pageSize) return entries;
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
  "computer.takeover.requested",
]);

export function shouldForwardPeerThreadEvent(event: { type: string }): boolean {
  return FORWARDED_PEER_RUN_EVENTS.has(event.type);
}
