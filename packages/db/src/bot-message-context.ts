import type { BotMessageIntent, EntryId, Peer } from "@tangow/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import type { SessionEntryRow } from "./sessions.js";
import { sessionEntryFromRow } from "./sessions.js";

/** What a run woken by another bot or agent knows of the delivery that woke it. */
export type BotMessageContext = {
  entryId: EntryId;
  from: Peer;
  /** The sending bot, absent for a connected agent from another owner. */
  fromBotId?: string;
  fromBotName: string;
  text: string;
  intent: BotMessageIntent;
  hop: number;
  exchangeId: EntryId;
  /** It answers a request or a question this bot sent that peer earlier in the exchange. */
  repliesToRequest: boolean;
  /** The run of this bot that sent the request it answers. */
  requestRunId?: string;
};

/** The `bot.message.received` entries among `entryIds`, each as the context of the run it woke. */
export async function loadBotMessageContexts(
  prisma: PrismaClient | Prisma.TransactionClient,
  entryIds: readonly string[],
): Promise<Map<string, BotMessageContext>> {
  if (entryIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<
    Array<SessionEntryRow & { requestId: string | null; requestRunId: string | null }>
  >`
    SELECT r.*, request.id AS "requestId", request."runId" AS "requestRunId"
    FROM session_entries r
    LEFT JOIN LATERAL (
      SELECT s.id, s."runId" FROM session_entries s
      WHERE s."sessionId" = r."sessionId" AND s.type = 'bot.message.sent' AND s.seq < r.seq
        AND s.payload ->> 'exchangeId' = r.payload ->> 'exchangeId'
        AND COALESCE(s.payload -> 'to' ->> 'botId', s.payload -> 'to' ->> 'address')
          = COALESCE(r.payload -> 'from' ->> 'botId', r.payload -> 'from' ->> 'address')
        AND s.payload ->> 'intent' IN ('request', 'question')
      ORDER BY s.seq DESC LIMIT 1) request ON r.payload ->> 'intent' <> 'fyi'
    WHERE r.id = ANY(${[...entryIds]}::text[]) AND r.type = 'bot.message.received'`;
  const contexts = new Map<string, BotMessageContext>();
  for (const { requestId, requestRunId, ...row } of rows) {
    const entry = sessionEntryFromRow(row);
    if (entry.type !== "bot.message.received") continue;
    const { from, text, intent, hop, exchangeId } = entry.payload;
    contexts.set(entry.id, {
      entryId: entry.id,
      from,
      ...(from.kind === "bot" ? { fromBotId: from.botId } : {}),
      fromBotName: from.name,
      text,
      intent,
      hop,
      exchangeId,
      repliesToRequest: requestId !== null,
      ...(requestRunId ? { requestRunId } : {}),
    });
  }
  return contexts;
}

export async function loadBotMessageContext(
  prisma: PrismaClient | Prisma.TransactionClient,
  entryId: string | null | undefined,
): Promise<BotMessageContext | undefined> {
  if (!entryId) return undefined;
  return (await loadBotMessageContexts(prisma, [entryId])).get(entryId);
}
