import { randomUUID } from "node:crypto";
import type { EntryId, MessageBlock, SessionRunTrigger } from "@rakazo/contracts";
import {
  BotMessageIntent,
  isLinkPreviewCard,
  isRunTrace,
  parseKnownMessageBlocks,
} from "@rakazo/contracts";
import * as z from "zod";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import type { SessionEntryRow } from "./sessions.js";
import { runBlockBodies, sessionEntryFromRow } from "./sessions.js";

type LegacyMessage = {
  id: string;
  seq: number;
  role: string;
  blocks: unknown;
  botId: string | null;
  runId: string | null;
  replyToMessageId: string | null;
  replyQuote: string | null;
  clientNonce: string | null;
  createdAt: Date;
};

type LegacyRun = {
  id: string;
  botId: string;
  status: string;
  trigger: string;
  routineId: string | null;
  sourceMessageId: string | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  model: Model;
  inputTokens: number;
  outputTokens: number;
};

/** Blocks the log replaced with entries of their own, kept here only to read what they held. */
const LegacySubagent = z.object({
  kind: z.literal("subagent"),
  agentId: z.string(),
  name: z.string(),
  task: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  progress: z.string().optional(),
  result: z.string().optional(),
});
const LegacyBotMessageSent = z.object({
  kind: z.literal("bot_message_sent"),
  toBotId: z.string().min(1),
  toBotName: z.string(),
  text: z.string(),
  intent: BotMessageIntent.optional(),
});
const LegacyBotMessageReceived = z.object({
  kind: z.literal("bot_message_received"),
  fromBotId: z.string().min(1),
  fromBotName: z.string(),
  text: z.string(),
  intent: BotMessageIntent.optional(),
  returnToMessageId: z.string().min(1).optional(),
  hop: z.number().int().nonnegative().optional(),
});
const LegacyBlock = z.discriminatedUnion("kind", [
  LegacySubagent,
  LegacyBotMessageSent,
  LegacyBotMessageReceived,
]);
type LegacyBlock = z.infer<typeof LegacyBlock>;
type Block = MessageBlock | LegacyBlock;
type Model = { provider: string; id: string };
type RoutineTrigger = Extract<SessionRunTrigger, { kind: "routine" | "webhook" }>;

const UNKNOWN_MODEL: Model = { provider: "unknown", id: "unknown" };
const NO_USAGE = { inputTokens: 0, outputTokens: 0 };
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
/** Nonces the executor gave the words a run sent before its final reply. */
const MID_TURN_NONCE = "user-progress:";
const TO_PERSON_NONCE = "user-message:";
const INSERT_CHUNK = 1000;
/** Messages a thread's backfill reads at a time, so a long thread never sits in memory whole. */
const PAGE = 500;
const TRANSACTION_TIMEOUT_MS = 120_000;
/** A round runs as long as the upgrade needs; whatever runs it decides when to give up. */
const ROUND_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** SQL: the message `m` is held by an entry of its own id. */
const COVERED = Prisma.sql`EXISTS (SELECT 1 FROM session_entries e WHERE e.id = m.id)`;

function isoOr(value: string | undefined, fallback: Date): string {
  const time = value === undefined ? Number.NaN : Date.parse(value);
  return new Date(Number.isNaN(time) ? fallback.getTime() : time).toISOString();
}

function blocksOf(raw: unknown): Block[] {
  if (!Array.isArray(raw)) return [];
  const known = new Map(parseKnownMessageBlocks(raw).map(({ index, block }) => [index, block]));
  return raw.flatMap((value, index): Block[] => {
    const block = known.get(index);
    if (block) return [block];
    const legacy = LegacyBlock.safeParse(value);
    return legacy.success ? [legacy.data] : [];
  });
}

/** A tool name whose label is the step's, for a step stored without its calls. */
function legacyToolName(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "tool"
  );
}

type Draft = {
  id?: string;
  type: string;
  payload: Record<string, unknown>;
  botId?: string | null;
  runId?: string | null;
  createdAt: Date;
};

/**
 * The entries a backfill appends to one session after the `head` it already holds, written a page
 * at a time. A routine's chain keeps its run's trace and hands everything else to `main`, as the
 * live writer does.
 */
class Chain {
  private pending: SessionEntryRow[] = [];
  private count = 0;

  constructor(
    readonly sessionId: string,
    private head: string | null = null,
    private readonly firstSeq = 0,
    private readonly main?: Chain,
  ) {}

  append(draft: Draft): string {
    if (this.main && !isRunTrace(draft as unknown as Parameters<typeof isRunTrace>[0])) {
      return this.main.append({
        ...draft,
        payload: { ...draft.payload, originSessionId: this.sessionId },
      });
    }
    const id = draft.id ?? randomUUID();
    const row: SessionEntryRow = {
      id,
      sessionId: this.sessionId,
      seq: this.nextSeq,
      parentId: this.head,
      type: draft.type,
      payload: draft.payload,
      botId: draft.botId ?? null,
      runId: draft.runId ?? null,
      createdAt: draft.createdAt,
    };
    row.payload = sessionEntryFromRow(row).payload;
    this.pending.push(row);
    this.count += 1;
    this.head = id;
    return id;
  }

  get nextSeq(): number {
    return this.firstSeq + this.count;
  }

  get written(): number {
    return this.count;
  }

  async flush(tx: Prisma.TransactionClient): Promise<void> {
    for (let start = 0; start < this.pending.length; start += INSERT_CHUNK) {
      await tx.sessionEntry.createMany({
        data: this.pending.slice(start, start + INSERT_CHUNK).map((row) => ({
          ...row,
          payload: row.payload as Prisma.InputJsonValue,
        })),
      });
    }
    this.pending = [];
  }

  async close(tx: Prisma.TransactionClient): Promise<void> {
    await this.flush(tx);
    if (this.count === 0) return;
    await tx.conversationSession.update({
      where: { id: this.sessionId },
      data: { nextEntrySeq: this.nextSeq, headEntryId: this.head },
    });
  }
}

export type BackfillThreadResult =
  | {
      threadId: string;
      outcome: "backfilled" | "appended" | "rebuilt";
      messages: number;
      entries: number;
    }
  | { threadId: string; outcome: "skipped" };

/** Messages older than the log a thread already holds: only a rebuild from them can place them. */
export class BackfillRefused extends Error {
  constructor(readonly threadId: string) {
    super(
      `Thread ${threadId} holds messages older than its session log's entries, which a backfill cannot place among them. Rebuild it from its messages with --rebuild-from-messages ${threadId}: that keeps the whole conversation and drops the run traces written since the log began.`,
    );
  }
}

/**
 * Writes the thread's messages that no entry holds yet, in seq order, as a linear chain of its main
 * session after the entries it already has, each message's id on one of its entries. Messages
 * older than those entries refuse, unless `rebuild` first replaces the thread's sessions with an
 * empty one. A thread whose messages are all held is left as it is, so a second run inserts nothing.
 */
export async function backfillThread(
  prisma: PrismaClient,
  threadId: string,
  { rebuild = false }: { rebuild?: boolean } = {},
): Promise<BackfillThreadResult> {
  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => backfillThreadInTransaction(tx, threadId, rebuild),
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_TIMEOUT_MS },
  );
}

async function backfillThreadInTransaction(
  tx: Prisma.TransactionClient,
  threadId: string,
  rebuild: boolean,
): Promise<BackfillThreadResult> {
  const [locked] = await tx.$queryRaw<
    Array<{
      sessionId: string;
      spaceId: string;
      botId: string | null;
      summary: string | null;
      summarizedSeq: number | null;
    }>
  >`
    SELECT t."sessionId", t."spaceId", t."botId",
      t."historyCompactionSummary" AS summary, t."historyCompactedUpToSeq" AS "summarizedSeq"
    FROM threads t WHERE t.id = ${threadId} FOR UPDATE`;
  if (!locked) return { threadId, outcome: "skipped" };
  const [held] = await tx.$queryRaw<
    Array<{ messages: number; uncovered: number; oldest: Date | null }>
  >`
    SELECT count(*)::int AS messages,
      count(*) FILTER (WHERE NOT ${COVERED})::int AS uncovered,
      min(m."createdAt") FILTER (WHERE NOT ${COVERED}) AS oldest
    FROM messages m WHERE m."threadId" = ${threadId}`;
  if (!held || (rebuild ? held.messages : held.uncovered) === 0) {
    return { threadId, outcome: "skipped" };
  }
  const thread = rebuild
    ? { ...locked, sessionId: await replaceSessions(tx, threadId, locked.sessionId) }
    : locked;
  const [head] = await tx.$queryRaw<
    Array<{ nextEntrySeq: number; id: string | null; createdAt: Date | null }>
  >`
    SELECT s."nextEntrySeq", h.id, h."createdAt" FROM sessions s
    LEFT JOIN LATERAL (
      SELECT e.id, e."createdAt" FROM session_entries e WHERE e."sessionId" = s.id
      ORDER BY e.seq DESC LIMIT 1) h ON true
    WHERE s.id = ${thread.sessionId}`;
  if (head?.createdAt && held.oldest && held.oldest < head.createdAt) {
    throw new BackfillRefused(threadId);
  }

  const main = new Chain(thread.sessionId, head?.id ?? null, head?.nextEntrySeq ?? 0);
  const runs = new Map<string, LegacyRun>();
  const runsOf = async (ids: string[]) => {
    const missing = ids.filter((id) => !runs.has(id));
    for (const [id, run] of await legacyRuns(tx, missing)) runs.set(id, run);
  };
  const routineOf = await routineChains(tx, threadId, thread, main, runsOf, runs);
  const lastSeqOfRun = new Map(
    (
      await tx.$queryRaw<Array<{ runId: string; seq: number }>>`
        SELECT m."runId", max(m.seq) AS seq FROM messages m
        WHERE m."threadId" = ${threadId} AND m."runId" IS NOT NULL AND NOT ${COVERED}
        GROUP BY m."runId"`
    ).map((row) => [row.runId, row.seq]),
  );
  const repliedTo = new Set(
    (
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT DISTINCT m."replyToMessageId" AS id FROM messages m
        WHERE m."threadId" = ${threadId} AND m."replyToMessageId" IS NOT NULL`
    ).map((row) => row.id),
  );
  const prior = head?.id ? await priorState(tx, thread.sessionId) : undefined;
  const startedRuns = new Set<string>();
  const exchangeOf = new Map<string, string>();
  let lastPersonEntry = prior?.lastPersonEntry;
  let summarizedUpTo: number | undefined;
  let converted = 0;
  let last: Date | undefined;

  for (let after = -1; ; ) {
    const page = await tx.$queryRaw<LegacyMessage[]>`
      SELECT m.id, m.seq, m.role, m.blocks, m."botId", m."runId", m."replyToMessageId",
        m."replyQuote", m."clientNonce", m."createdAt"
      FROM messages m
      WHERE m."threadId" = ${threadId} AND m.seq > ${after} AND NOT ${COVERED}
      ORDER BY m.seq LIMIT ${PAGE}`;
    if (page.length === 0) break;
    after = page.at(-1)!.seq;
    const parsed = page.map((message) => ({ message, blocks: blocksOf(message.blocks) }));
    const pageRunIds = [...new Set(page.flatMap((message) => message.runId ?? []))];
    await runsOf(pageRunIds);
    for (const runId of await startedAlready(tx, pageRunIds, startedRuns, prior !== undefined)) {
      startedRuns.add(runId);
    }
    const sentEntries = await sentEntriesOf(
      tx,
      parsed.flatMap(({ blocks }) =>
        blocks.flatMap((block) => (block.kind === "bot_message_received" ? [block] : [])),
      ),
    );

    for (const { message, blocks } of parsed) {
      let unclaimedId: string | undefined = message.id;
      const id = () => {
        const next = unclaimedId ?? randomUUID();
        unclaimedId = undefined;
        return next;
      };
      const run = message.runId ? runs.get(message.runId) : undefined;
      const routine = run && routineOf.get(run.id);
      const chain = routine?.chain ?? main;
      const botId = message.botId ?? run?.botId ?? thread.botId;
      const createdAt = message.createdAt;
      const later: Draft[] = [];

      if (run && botId && !startedRuns.has(run.id) && opensRun(blocks)) {
        startedRuns.add(run.id);
        chain.append({
          type: "run.started",
          botId,
          runId: run.id,
          createdAt: run.startedAt ?? run.createdAt,
          payload: {
            trigger: routine?.trigger ?? triggerOf(run, lastPersonEntry),
            model: run.model,
            effort: null,
          },
        });
      }

      if (message.role === "system") {
        chain.append({
          id: id(),
          type: "system.note",
          createdAt,
          payload: { text: textOf(blocks) },
        });
      } else if (message.role === "user") {
        const delivery = blocks.find(
          (block): block is z.infer<typeof LegacyBotMessageReceived> =>
            block.kind === "bot_message_received",
        );
        if (delivery) {
          const entryId = id();
          const sent = delivery.returnToMessageId
            ? sentEntries.get(delivery.returnToMessageId)
            : undefined;
          const exchangeId =
            sent?.exchangeId ??
            ((message.replyToMessageId && exchangeOf.get(message.replyToMessageId)) || entryId);
          exchangeOf.set(message.id, exchangeId);
          chain.append({
            id: entryId,
            type: "bot.message.received",
            createdAt,
            payload: {
              from: { kind: "bot", botId: delivery.fromBotId, name: delivery.fromBotName },
              ...(sent ? { fromSessionId: sent.sessionId, fromEntryId: sent.id } : {}),
              text: delivery.text,
              intent: delivery.intent ?? "request",
              hop: Math.max(1, delivery.hop ?? 1),
              exchangeId,
              ...(message.clientNonce ? { clientNonce: message.clientNonce } : {}),
            },
          });
        } else {
          const shown = blocks.filter(isMessageBlock).filter((block) => !isPreviewCard(block));
          const entryId = chain.append({
            id: id(),
            type: "user.message",
            createdAt,
            payload: {
              blocks: shown,
              ...(message.replyToMessageId
                ? {
                    replyTo: {
                      entryId: message.replyToMessageId,
                      ...(message.replyQuote ? { quote: message.replyQuote } : {}),
                    },
                  }
                : {}),
              ...(message.clientNonce ? { clientNonce: message.clientNonce } : {}),
              source: shown.some((block) => block.kind === "channel_message") ? "channel" : "app",
            },
          });
          lastPersonEntry = entryId;
        }
        later.push(...previewsOf(blocks, message.id, createdAt));
      } else if (run && botId) {
        const flags = {
          ...(message.clientNonce?.startsWith(MID_TURN_NONCE) ? { midTurn: true as const } : {}),
          ...(message.clientNonce?.startsWith(TO_PERSON_NONCE)
            ? { midTurn: true as const, toPerson: true as const }
            : {}),
        };
        let pending: MessageBlock[] = [];
        let toolCall = 0;
        const flush = () => {
          for (const body of runBlockBodies(flags, pending)) {
            const entryId = chain.append({
              id: id(),
              ...body,
              botId,
              runId: run.id,
              createdAt,
            } as Draft);
            const card = answeredCard(body, entryId, repliedTo.has(message.id));
            if (card) later.push({ ...card, createdAt });
          }
          pending = [];
        };
        for (const block of blocks) {
          switch (block.kind) {
            case "steps":
              flush();
              for (const step of block.steps) {
                for (let count = 0; count < step.count; count += 1) {
                  const call = step.calls?.[count];
                  const callId = call?.id ?? `legacy_${message.id}_${toolCall}`;
                  toolCall += 1;
                  chain.append({
                    id: id(),
                    type: "tool.call",
                    botId,
                    runId: run.id,
                    createdAt,
                    payload: {
                      callId,
                      name: call?.name ?? legacyToolName(step.label),
                      input: call?.input ?? "{}",
                    },
                  });
                  chain.append({
                    type: "tool.result",
                    botId,
                    runId: run.id,
                    createdAt,
                    payload: {
                      callId,
                      output: call?.output ?? "",
                      isError: false,
                      artifactIds: [],
                    },
                  });
                }
              }
              break;
            case "subagent":
              flush();
              chain.append({
                id: id(),
                type: "subagent",
                botId,
                runId: run.id,
                createdAt,
                payload: {
                  callId: block.agentId || `legacy_${message.id}_${toolCall}`,
                  name: block.name,
                  model: run.model,
                  task: block.task,
                  status: block.status === "completed" ? "completed" : "failed",
                  result: block.result ?? block.progress ?? "",
                  usage: NO_USAGE,
                },
              });
              break;
            case "bot_message_sent": {
              flush();
              const entryId = id();
              const woke = run.sourceMessageId ? exchangeOf.get(run.sourceMessageId) : undefined;
              const exchangeId = woke ?? entryId;
              exchangeOf.set(message.id, exchangeId);
              chain.append({
                id: entryId,
                type: "bot.message.sent",
                botId,
                runId: run.id,
                createdAt,
                payload: {
                  to: { kind: "bot", botId: block.toBotId, name: block.toBotName },
                  text: block.text,
                  intent: block.intent ?? "request",
                  hop: 1,
                  exchangeId,
                },
              });
              break;
            }
            case "handoff":
              flush();
              chain.append({
                id: id(),
                type: "handoff",
                botId,
                runId: run.id,
                createdAt,
                payload: {
                  fromBotId: block.fromBotId,
                  toBotId: block.toBotId,
                  text: block.text,
                  hop: Math.max(1, block.hop ?? 1),
                },
              });
              break;
            case "routine_run": {
              flush();
              if (!routine) break;
              const { trigger } = routine;
              main.append({
                id: id(),
                type: "routine.started",
                botId,
                runId: run.id,
                createdAt,
                payload: {
                  sessionId: routine.chain.sessionId,
                  routineId: trigger.routineId,
                  name: block.routineName,
                  trigger: trigger.kind,
                  scheduledAt: isoOr(block.startedAt, run.createdAt),
                  model: run.model,
                  ...(block.notify ? { notify: true } : {}),
                },
              });
              const outcome = routineOutcome(block, run);
              if (outcome) {
                main.append({
                  type: "routine.finished",
                  botId,
                  runId: run.id,
                  createdAt: new Date(isoOr(block.endedAt, createdAt)),
                  payload: outcome,
                });
              }
              break;
            }
            case "bot_message_received":
            case "progress":
            case "skill_source":
              break;
            case "link_preview":
              if (!isLinkPreviewCard(block)) pending.push(block);
              break;
            default:
              pending.push(block);
          }
        }
        flush();
        later.push(...previewsOf(blocks, message.id, createdAt));
      }
      if (message.role === "bot" && botId) {
        for (const block of blocks) {
          if (block.kind === "skill_source") later.push(learnt(block, botId, run?.id, createdAt));
        }
      }

      const outcome =
        run && botId && lastSeqOfRun.get(run.id) === message.seq && startedRuns.has(run.id)
          ? runOutcome(run)
          : undefined;
      if (unclaimedId !== undefined) {
        const shown = blocks
          .filter(isMessageBlock)
          .filter((block) => !NOT_SHOWN_ALONE.has(block.kind) && !isPreviewCard(block));
        const standalone = outcome || later.some((draft) => draft.type === "skill.learnt");
        if (!botId) {
          chain.append({
            id: id(),
            type: "system.note",
            createdAt,
            payload: { text: textOf(blocks) },
          });
        } else if (shown.length > 0 || blocks.some(isPreviewCard) || !standalone) {
          const entryId = chain.append({
            id: id(),
            type: "bot.text",
            botId,
            createdAt,
            payload: { blocks: shown },
          });
          for (const block of shown) {
            if (block.kind !== "skill_draft") continue;
            const { kind: _kind, ...draft } = block;
            later.push({ type: "skill.draft", createdAt, payload: { target: entryId, ...draft } });
          }
          if (!run) later.push(...previewsOf(blocks, entryId, createdAt));
        }
      }

      for (const draft of later) {
        const claims = draft.type === "skill.learnt" && unclaimedId !== undefined;
        chain.append(claims ? { ...draft, id: id() } : draft);
      }
      if (run && botId && outcome) {
        chain.append({
          ...(unclaimedId !== undefined ? { id: id() } : {}),
          type: "run.finished",
          botId,
          runId: run.id,
          createdAt: run.completedAt ?? createdAt,
          payload: outcome,
        });
      }
      if (
        thread.summarizedSeq !== null &&
        message.seq <= thread.summarizedSeq &&
        main.nextSeq > 0
      ) {
        summarizedUpTo = main.nextSeq - 1;
      }
      converted += 1;
      last = createdAt;
    }
    await main.flush(tx);
    for (const { chain } of routineOf.values()) await chain.flush(tx);
  }

  if (thread.summary && summarizedUpTo !== undefined && last) {
    main.append({
      type: "compaction",
      createdAt: last,
      payload: { summary: thread.summary, coveredUpToSeq: summarizedUpTo },
    });
  }
  const chains = [main, ...[...routineOf.values()].map(({ chain }) => chain)];
  for (const chain of chains) await chain.close(tx);
  return {
    threadId,
    outcome: rebuild ? "rebuilt" : head?.id ? "appended" : "backfilled",
    messages: converted,
    entries: chains.reduce((sum, chain) => sum + chain.written, 0),
  };
}

/**
 * The routine sessions the thread's routine cards open, each created now, under the thread's
 * main session, with its run moved to it.
 */
async function routineChains(
  tx: Prisma.TransactionClient,
  threadId: string,
  thread: { sessionId: string; spaceId: string },
  main: Chain,
  runsOf: (ids: string[]) => Promise<void>,
  runs: ReadonlyMap<string, LegacyRun>,
): Promise<Map<string, { chain: Chain; trigger: RoutineTrigger }>> {
  const cards = await tx.$queryRaw<Array<{ runId: string; card: unknown }>>`
    SELECT DISTINCT ON (m."runId") m."runId", card
    FROM messages m, jsonb_array_elements(m.blocks) AS card
    WHERE m."threadId" = ${threadId} AND m."runId" IS NOT NULL AND NOT ${COVERED}
      AND card ->> 'kind' = 'routine_run'
    ORDER BY m."runId", m.seq`;
  await runsOf(cards.map(({ runId }) => runId));
  const routineOf = new Map<string, { chain: Chain; trigger: RoutineTrigger }>();
  for (const { runId, card: raw } of cards) {
    const run = runs.get(runId);
    const card = blocksOf([raw])[0];
    if (!run || card?.kind !== "routine_run") continue;
    const routineId = card.routineId ?? run.routineId;
    if (!routineId) continue;
    const chain = new Chain(randomUUID(), null, 0, main);
    await tx.conversationSession.create({
      data: {
        id: chain.sessionId,
        spaceId: thread.spaceId,
        kind: "routine",
        parentSessionId: thread.sessionId,
      },
    });
    await tx.run.update({ where: { id: runId }, data: { sessionId: chain.sessionId } });
    routineOf.set(runId, {
      chain,
      trigger:
        run.trigger === "webhook"
          ? { kind: "webhook", routineId }
          : {
              kind: "routine",
              routineId,
              name: card.routineName,
              scheduledAt: isoOr(card.startedAt, run.createdAt),
            },
    });
  }
  return routineOf;
}

/**
 * Empties the thread's main session and renames it, so the thread starts a new log: every session
 * under it goes, entries and all, and the runs that wrote to any of them move to it.
 */
async function replaceSessions(
  tx: Prisma.TransactionClient,
  threadId: string,
  mainSessionId: string,
): Promise<string> {
  const tree = await tx.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE tree AS (
      SELECT id FROM sessions WHERE id = ${mainSessionId}
      UNION ALL
      SELECT s.id FROM sessions s JOIN tree ON s."parentSessionId" = tree.id)
    SELECT id FROM tree`;
  const ids = tree.map((row) => row.id);
  await tx.$executeRaw`UPDATE runs SET "sessionId" = ${mainSessionId} WHERE "sessionId" = ANY(${ids}::text[])`;
  await tx.$executeRaw`DELETE FROM session_entries WHERE "sessionId" = ANY(${ids}::text[])`;
  await tx.$executeRaw`DELETE FROM sessions WHERE "parentSessionId" = ${mainSessionId}`;
  const sessionId = randomUUID();
  await tx.$executeRaw`
    UPDATE sessions SET id = ${sessionId}, "nextEntrySeq" = 0, "headEntryId" = NULL
    WHERE id = ${mainSessionId}`;
  await tx.thread.update({ where: { id: threadId }, data: { sessionId } });
  return sessionId;
}

/** The person's last word on a session the backfill appends to. */
async function priorState(tx: Prisma.TransactionClient, sessionId: string) {
  const [person] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM session_entries WHERE "sessionId" = ${sessionId} AND type = 'user.message'
    ORDER BY seq DESC LIMIT 1`;
  return { lastPersonEntry: person?.id };
}

/** Of `runIds`, the runs whose start an earlier backfill or the live writer already logged. */
async function startedAlready(
  tx: Prisma.TransactionClient,
  runIds: string[],
  known: ReadonlySet<string>,
  logged: boolean,
): Promise<string[]> {
  const unknown = runIds.filter((id) => !known.has(id));
  if (!logged || unknown.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ runId: string }>>`
    SELECT DISTINCT "runId" FROM session_entries
    WHERE type = 'run.started' AND "runId" = ANY(${unknown}::text[])`;
  return rows.map((row) => row.runId);
}

/**
 * Moves every message the log does not hold into it and drops the messages table, in one
 * transaction that holds every writer off `messages` until it ends. A thread refused or failed
 * rolls the whole round back, so nothing it wrote survives to go stale while the previous release
 * runs again. Each thread runs under a savepoint, so the round reports every such thread at once.
 */
export async function moveMessagesToLog(
  prisma: PrismaClient,
  {
    rebuild = new Set<string>(),
    log = () => {},
  }: {
    rebuild?: "all" | ReadonlySet<string>;
    log?: (result: Exclude<BackfillThreadResult, { outcome: "skipped" }>) => void;
  } = {},
): Promise<{ threads: number; messages: number; entries: number }> {
  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`LOCK TABLE messages IN EXCLUSIVE MODE`;
      const named = rebuild === "all" ? [] : [...rebuild];
      const threads = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT t.id FROM threads t
        WHERE EXISTS (
          SELECT 1 FROM messages m
          WHERE m."threadId" = t.id AND (NOT ${COVERED} OR t.id = ANY(${named}::text[])))
        ORDER BY t.id`;
      const refused: string[] = [];
      const failed: Array<{ threadId: string; error: unknown }> = [];
      const moved = { threads: 0, messages: 0, entries: 0 };
      for (const { id } of threads) {
        await tx.$executeRaw`SAVEPOINT backfill_thread`;
        try {
          const result = await backfillThreadInTransaction(
            tx,
            id,
            rebuild === "all" || rebuild.has(id),
          );
          await tx.$executeRaw`RELEASE SAVEPOINT backfill_thread`;
          if (result.outcome === "skipped") continue;
          moved.threads += 1;
          moved.messages += result.messages;
          moved.entries += result.entries;
          log(result);
        } catch (error) {
          await tx.$executeRaw`ROLLBACK TO SAVEPOINT backfill_thread`;
          if (error instanceof BackfillRefused) refused.push(id);
          else failed.push({ threadId: id, error });
        }
      }
      if (refused.length > 0 || failed.length > 0) throw new RoundRefused(refused, failed);
      const [dropped] = await tx.$queryRaw<Array<{ dropped: boolean }>>`
        SELECT drop_messages_when_logged() AS dropped`;
      if (!dropped?.dropped) throw new Error("Messages are still missing from the session log");
      return moved;
    },
    { timeout: ROUND_TIMEOUT_MS, maxWait: TRANSACTION_TIMEOUT_MS },
  );
}

/**
 * What the migrate service and the API at start both run: while the legacy messages table is
 * there, one round moves its messages into the log and drops it, logging every thread and the
 * total time. A refused round throws `RoundRefused`, whose message names the threads and the
 * override.
 */
export async function moveLegacyMessages(
  prisma: PrismaClient,
  { rebuild, log }: { rebuild?: "all" | ReadonlySet<string>; log: (line: string) => void },
): Promise<void> {
  if (!(await hasLegacyMessages(prisma))) return;
  log("Moving the conversations into the session log.");
  const started = performance.now();
  const moved = await moveMessagesToLog(prisma, {
    ...(rebuild ? { rebuild } : {}),
    // Converted inside the round: nothing is kept until the whole round commits.
    log: (result) =>
      log(
        `thread ${result.threadId} converted (${result.outcome}): ${result.messages} messages, ${result.entries} entries`,
      ),
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  log(`moved ${moved.threads} threads, ${moved.messages} messages, in ${seconds} s`);
}

/** A round that left the log as it was: the threads it refused and those it failed to convert. */
export class RoundRefused extends Error {
  constructor(
    readonly refused: readonly string[],
    readonly failed: ReadonlyArray<{ threadId: string; error: unknown }>,
  ) {
    super(
      [
        refused.length > 0 &&
          `These threads hold messages older than their session log; rebuild them from their messages with --rebuild-from-messages <thread-id> (or --all): ${refused.join(", ")}`,
        ...failed.map(
          ({ threadId, error }) =>
            `Thread ${threadId} could not be moved to the session log: ${error instanceof Error ? error.message : String(error)}`,
        ),
        `Nothing was written and the messages table stays; see "Session log migration" in docs/self-host.md.`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function isMessageBlock(block: Block): block is MessageBlock {
  return (
    block.kind !== "subagent" &&
    block.kind !== "bot_message_sent" &&
    block.kind !== "bot_message_received"
  );
}

function isPreviewCard(block: Block): boolean {
  return block.kind === "link_preview" && isLinkPreviewCard(block);
}

/** Kinds a bot message held that show nothing in its place once the log keeps them apart. */
const NOT_SHOWN_ALONE = new Set<Block["kind"]>(["skill_source", "steps", "progress"]);

/** A message opens its run with an entry of the run, or, showing nothing, with its start alone. */
function opensRun(blocks: readonly Block[]): boolean {
  return blocks.every((block) => block.kind === "progress") || blocks.some(makesRunEntry);
}

function makesRunEntry(block: Block): boolean {
  return block.kind !== "progress" && block.kind !== "routine_run" && block.kind !== "skill_source";
}

function textOf(blocks: readonly Block[]): string {
  return blocks
    .flatMap((block) => ("text" in block && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}

function previewsOf(blocks: readonly Block[], target: string, createdAt: Date): Draft[] {
  return blocks.flatMap((block) =>
    block.kind === "link_preview" && isLinkPreviewCard(block)
      ? [
          {
            type: "link.preview",
            createdAt,
            payload: {
              target,
              block,
              ...(block.image ? { artifactId: block.image.artifactId } : {}),
            },
          },
        ]
      : [],
  );
}

function learnt(
  block: Extract<MessageBlock, { kind: "skill_source" }>,
  botId: string,
  runId: string | undefined,
  createdAt: Date,
): Draft {
  return {
    type: "skill.learnt",
    botId,
    runId,
    createdAt,
    payload: { skillId: block.skillId, name: block.name, change: block.change },
  };
}

function answeredCard(
  body: { type: string; payload: Record<string, unknown> },
  target: string,
  replied: boolean,
): Omit<Draft, "createdAt"> | undefined {
  if (replied) return undefined;
  if (body.type === "assistant.ask") {
    const block = body.payload.block as Extract<MessageBlock, { kind: "ask" }>;
    if (block.status !== "answered" || block.confirms) return undefined;
    return {
      type: "card.answered",
      payload: {
        target,
        ...(block.answer !== undefined ? { answer: block.answer } : {}),
        ...(block.answers ? { answers: block.answers } : {}),
      },
    };
  }
  if (body.type === "assistant.choice") {
    const block = body.payload.block as Extract<MessageBlock, { kind: "choice" }>;
    if (block.answerId === undefined) return undefined;
    return { type: "card.answered", payload: { target, answerId: block.answerId } };
  }
  return undefined;
}

function triggerOf(run: LegacyRun, lastPersonEntry: string | undefined): SessionRunTrigger {
  const source = run.sourceMessageId ?? lastPersonEntry;
  return source ? { kind: "message", entryId: source as EntryId } : { kind: "direct" };
}

function runOutcome(run: LegacyRun) {
  if (!TERMINAL.has(run.status)) return undefined;
  const usage = { inputTokens: run.inputTokens, outputTokens: run.outputTokens };
  if (run.status === "failed") return { status: "failed", usage, error: run.error ?? "" };
  return { status: run.status, usage };
}

function routineOutcome(block: Extract<MessageBlock, { kind: "routine_run" }>, run: LegacyRun) {
  const usage = { inputTokens: run.inputTokens, outputTokens: run.outputTokens };
  const result = block.digest ?? "";
  if (block.state === "completed") return { status: "completed", usage, result };
  if (block.state === "cancelled") return { status: "cancelled", usage, result };
  if (block.state === "failed") {
    return { status: "failed", usage, error: run.error ?? block.digest ?? "", result };
  }
  return undefined;
}

async function legacyRuns(
  tx: Prisma.TransactionClient,
  runIds: string[],
): Promise<Map<string, LegacyRun>> {
  if (runIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<
    Array<
      Omit<LegacyRun, "model"> & {
        modelProvider: string | null;
        modelId: string | null;
        usageProvider: string | null;
        usageModel: string | null;
      }
    >
  >`
    SELECT r.id, r."botId", r.status, r.trigger, r."routineId",
      CASE WHEN EXISTS (
        SELECT 1 FROM messages s WHERE s.id = r."sourceMessageId" AND s."threadId" = r."threadId"
      ) THEN r."sourceMessageId" END AS "sourceMessageId",
      r.error,
      r."createdAt", r."startedAt", r."completedAt", r."modelProvider", r."modelId",
      COALESCE(u."inputTokens", 0)::int AS "inputTokens",
      COALESCE(u."outputTokens", 0)::int AS "outputTokens",
      u.provider AS "usageProvider", u.model AS "usageModel"
    FROM runs r
    LEFT JOIN LATERAL (
      SELECT SUM("inputTokens") AS "inputTokens", SUM("outputTokens") AS "outputTokens",
        MIN(provider) AS provider, MIN(model) AS model
      FROM usage_records WHERE "runId" = r.id) u ON true
    WHERE r.id = ANY(${runIds}::text[])`;
  return new Map(
    rows.map(({ modelProvider, modelId, usageProvider, usageModel, ...run }) => [
      run.id,
      {
        ...run,
        model:
          modelProvider && modelId
            ? { provider: modelProvider, id: modelId }
            : usageProvider && usageModel
              ? { provider: usageProvider, id: usageModel }
              : UNKNOWN_MODEL,
      },
    ]),
  );
}

/**
 * The `bot.message.sent` entry each delivery came from, by the sender's message id: the first one
 * of the same run and text at or after the entry that holds that id, once the sender's thread is in
 * the log. A delivery whose sender is not there yet keeps no link rather than a wrong one.
 */
async function sentEntriesOf(
  tx: Prisma.TransactionClient,
  deliveries: ReadonlyArray<z.infer<typeof LegacyBotMessageReceived>>,
): Promise<Map<string, { id: string; sessionId: string; exchangeId: string }>> {
  const linked = deliveries.flatMap((delivery) =>
    delivery.returnToMessageId ? [{ id: delivery.returnToMessageId, text: delivery.text }] : [],
  );
  if (linked.length === 0) return new Map();
  const rows = await tx.$queryRaw<
    Array<{ messageId: string; id: string; sessionId: string; exchangeId: string }>
  >`
    SELECT d.message_id AS "messageId", sent.id, sent."sessionId", sent."exchangeId"
    FROM unnest(${linked.map((link) => link.id)}::text[], ${linked.map((link) => link.text)}::text[])
      AS d(message_id, text)
    JOIN session_entries held ON held.id = d.message_id
    JOIN LATERAL (
      SELECT e.id, e."sessionId", e.payload ->> 'exchangeId' AS "exchangeId"
      FROM session_entries e
      WHERE e."sessionId" = held."sessionId" AND e.seq >= held.seq
        AND e."runId" = held."runId" AND e.type = 'bot.message.sent'
        AND e.payload ->> 'text' = d.text
      ORDER BY e.seq LIMIT 1) sent ON true`;
  return new Map(rows.map(({ messageId, ...sent }) => [messageId, sent]));
}

/** Whether the legacy `messages` table is still there to read. */
export async function hasLegacyMessages(prisma: PrismaClient): Promise<boolean> {
  const [row] = await prisma.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass('public.messages') IS NOT NULL AS present`;
  return row?.present === true;
}
