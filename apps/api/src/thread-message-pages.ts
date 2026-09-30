import type { MessageBlock, ThreadMessage, ThreadMessagePage } from "@rakazo/contracts";
import { isPeerReceiptBlocks, isUserDirectedMessage, userVisibleMessages } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { hiddenPeerRunIds } from "@rakazo/db";

type MessageDb = PrismaClient | Prisma.TransactionClient;

export async function loadMessagePage(
  prisma: MessageDb,
  threadId: string,
  before: number | undefined,
  pageSize: number,
  around?: { messageId?: string; seq?: number },
  includePeerRuns = false,
  includePeerReceipts = false,
): Promise<ThreadMessagePage> {
  if (around) {
    let targetSeq = around.seq;
    if (targetSeq === undefined && around.messageId) {
      const row = await prisma.message.findFirst({
        where: { id: around.messageId, threadId },
        select: { seq: true },
      });
      targetSeq = row?.seq;
    }
    if (targetSeq !== undefined) {
      const half = Math.floor(pageSize / 2);
      const minSeq = Math.max(0, targetSeq - half);
      const maxSeq = targetSeq + half;
      const rows = await prisma.message.findMany({
        where: { threadId, seq: { gte: minSeq, lte: maxSeq } },
        orderBy: { seq: "asc" },
        take: pageSize,
      });
      const first = rows[0];
      const hasOlder = first
        ? (await prisma.message.count({ where: { threadId, seq: { lt: first.seq } } })) > 0
        : false;
      // Peer text/activity stays out of the normal transcript (including the
      // around target). Receipts remain via withoutPeerRunMessages; full peer
      // history belongs in the bot-messages overlay (includePeerRuns).
      const messages = includePeerRuns ? rows : await withoutPeerRunMessages(prisma, rows);
      return {
        threadId,
        messages: messages.map(toThreadMessage),
        olderCursor: hasOlder ? (first?.seq ?? null) : null,
      };
    }
  }

  let cursor = before;
  while (true) {
    const rows = await prisma.message.findMany({
      where: {
        threadId,
        ...(cursor === undefined ? {} : { seq: { lt: cursor } }),
      },
      orderBy: { seq: "desc" },
      take: pageSize + 1,
    });
    const hasOlder = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize).reverse();
    const visibleRows = includePeerRuns ? pageRows : await withoutPeerRunMessages(prisma, pageRows);
    // Web hides receipts client-side, so its receipt-only pages keep scanning.
    // Mobile explicitly retains them and must receive each page for pagination.
    const hasSubstantive = visibleRows.some(
      (row) => !isPeerReceiptBlocks(row.blocks as MessageBlock[]),
    );
    if (hasSubstantive || includePeerReceipts || !hasOlder || includePeerRuns) {
      return {
        threadId,
        messages: visibleRows.map(toThreadMessage),
        olderCursor: hasOlder ? (pageRows[0]?.seq ?? null) : null,
      };
    }
    // TODO: only rescan when a raw page is entirely peer output. Consider a run relation if
    // long peer-only histories make this path hot.
    cursor = pageRows[0]?.seq;
  }
}

export async function loadAllMessages(
  prisma: PrismaClient,
  threadId: string,
  pageSize: number,
): Promise<ThreadMessage[]> {
  const pages: ThreadMessage[][] = [];
  let before: number | undefined;
  do {
    const page = await loadMessagePage(prisma, threadId, before, pageSize, undefined, true);
    pages.push(page.messages);
    before = page.olderCursor ?? undefined;
  } while (before !== undefined);
  return pages.reverse().flat();
}

async function withoutPeerRunMessages<
  T extends { runId: string | null; clientNonce: string | null; blocks: Prisma.JsonValue },
>(prisma: MessageDb, rows: T[]): Promise<T[]> {
  const runIds = [...new Set(rows.flatMap((row) => (row.runId ? [row.runId] : [])))];
  if (runIds.length === 0) return rows;
  const peerRunIds = await hiddenPeerRunIds(prisma, runIds);
  const visibleRows = new Set(
    userVisibleMessages(
      rows.map((row) => ({
        row,
        runId: row.runId ?? undefined,
        clientNonce: row.clientNonce ?? undefined,
        blocks: row.blocks as MessageBlock[],
      })),
      { knownPeerRunIds: peerRunIds, includePeerReceipts: true },
    ).map((item) => item.row),
  );
  return rows.filter((row) => visibleRows.has(row));
}

export async function isPeerRun(
  prisma: MessageDb,
  runId: string | undefined,
  cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (!runId) return false;
  let peerRun = cache.get(runId);
  if (!peerRun) {
    // Same rule as withoutPeerRunMessages: a top-level bot relaying delegated work is not a
    // hidden peer run (CA5/CA6), so its live thread events forward too.
    peerRun = hiddenPeerRunIds(prisma, [runId]).then((ids) => ids.has(runId));
    cache.set(runId, peerRun);
  }
  return peerRun;
}

/** Peer-run SSE events that must still reach an open thread (terminals, waits, receipts, selected output). */
export async function shouldForwardPeerThreadEvent(
  prisma: MessageDb,
  event: {
    type: string;
    payload: { messageId?: unknown; blocks?: unknown };
  },
): Promise<boolean> {
  if (
    // The start drives the working indicator, and the terminals below clear it again. Without
    // the pair an open chat sits inert for the whole run and only catches up on reload.
    event.type === "run.started" ||
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled" ||
    event.type === "run.waiting_input" ||
    event.type === "computer.takeover.requested"
  ) {
    return true;
  }
  if (event.type !== "thread.message.created" && event.type !== "thread.message.updated") {
    return false;
  }
  if (!Array.isArray(event.payload.blocks)) return false;
  const blocks = event.payload.blocks as MessageBlock[];
  // Artifact rows may precede the selected result. Do not stream them alone; the terminal
  // event refreshes the page through the same C13 filter after the result is durable.
  if (blocks.some((block) => block.kind === "file" || block.kind === "image")) return false;
  if (isPeerReceiptBlocks(blocks) || blocks.some((block) => block.kind === "ask")) return true;
  const messageId = event.payload.messageId;
  if (typeof messageId !== "string") return false;
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { clientNonce: true },
  });
  return isUserDirectedMessage({ clientNonce: message?.clientNonce, blocks });
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
