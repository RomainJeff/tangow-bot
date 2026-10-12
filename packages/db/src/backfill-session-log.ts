import { randomUUID } from "node:crypto";
import type { EntryId, MessageBlock, SessionRunTrigger } from "@rakazo/contracts";
import {
  BotMessageIntent,
  isLinkPreviewCard,
  isRunTrace,
  parseKnownMessageBlocks,
} from "@rakazo/contracts";
import * as z from "zod";
import type { Prisma, PrismaClient } from "./client.js";
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
  covered: boolean;
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
const TRANSACTION_TIMEOUT_MS = 120_000;

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
 * The entries a backfill appends to one session, after the `head` it already holds. A routine's
 * chain keeps its run's trace and hands everything else to `main`, as the live writer does.
 */
class Chain {
  readonly rows: SessionEntryRow[] = [];

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
    this.rows.push(row);
    this.head = id;
    return id;
  }

  get nextSeq(): number {
    return this.firstSeq + this.rows.length;
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
  const thread = rebuild
    ? { ...locked, sessionId: await replaceSessions(tx, threadId, locked.sessionId) }
    : locked;
  const messages = await tx.$queryRaw<LegacyMessage[]>`
    SELECT m.id, m.seq, m.role, m.blocks, m."botId", m."runId", m."replyToMessageId",
      m."replyQuote", m."clientNonce", m."createdAt",
      EXISTS (SELECT 1 FROM session_entries e WHERE e.id = m.id) AS covered
    FROM messages m WHERE m."threadId" = ${threadId} ORDER BY m.seq`;
  const uncovered = messages.filter((message) => !message.covered);
  if (uncovered.length === 0) return { threadId, outcome: "skipped" };
  const [head] = await tx.$queryRaw<
    Array<{ nextEntrySeq: number; id: string | null; createdAt: Date | null }>
  >`
    SELECT s."nextEntrySeq", h.id, h."createdAt" FROM sessions s
    LEFT JOIN LATERAL (
      SELECT e.id, e."createdAt" FROM session_entries e WHERE e."sessionId" = s.id
      ORDER BY e.seq DESC LIMIT 1) h ON true
    WHERE s.id = ${thread.sessionId}`;
  const headAt = head?.createdAt;
  if (headAt && uncovered.some((message) => message.createdAt < headAt)) {
    throw new BackfillRefused(threadId);
  }

  const parsed = uncovered.map((message) => ({ message, blocks: blocksOf(message.blocks) }));
  const runIds = [...new Set(uncovered.flatMap((message) => message.runId ?? []))];
  const runs = await legacyRuns(tx, runIds);
  const deliveries = parsed.flatMap(({ blocks }) =>
    blocks.flatMap((block) => (block.kind === "bot_message_received" ? [block] : [])),
  );
  const sentEntries = await sentEntriesOf(tx, deliveries);
  const prior = head?.id ? await priorState(tx, thread.sessionId, runIds) : undefined;

  const main = new Chain(thread.sessionId, head?.id ?? null, head?.nextEntrySeq ?? 0);
  const routineOf = new Map<string, { chain: Chain; trigger: RoutineTrigger }>();
  const startedRuns = new Set(prior?.startedRuns);
  const lastMessageOfRun = new Map<string, number>();
  parsed.forEach(({ message }, index) => {
    if (message.runId) lastMessageOfRun.set(message.runId, index);
  });
  for (const { message, blocks } of parsed) {
    const run = message.runId ? runs.get(message.runId) : undefined;
    if (!run || routineOf.has(run.id)) continue;
    const card = blocks.find(
      (block): block is Extract<MessageBlock, { kind: "routine_run" }> =>
        block.kind === "routine_run",
    );
    const routineId = card?.routineId ?? run.routineId;
    if (!card || !routineId) continue;
    routineOf.set(run.id, {
      chain: new Chain(randomUUID(), null, 0, main),
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
  const repliedTo = new Set(messages.flatMap((message) => message.replyToMessageId ?? []));
  const messageIds = new Set(messages.map((message) => message.id));
  const exchangeOf = new Map<string, string>();
  const lastMainSeqOf = new Map<number, number>();
  let lastPersonEntry = prior?.lastPersonEntry;

  for (const [index, { message, blocks }] of parsed.entries()) {
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
          trigger: routine?.trigger ?? triggerOf(run, lastPersonEntry, messageIds),
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
                  payload: { callId, output: call?.output ?? "", isError: false, artifactIds: [] },
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
      run && botId && lastMessageOfRun.get(run.id) === index && startedRuns.has(run.id)
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
    lastMainSeqOf.set(message.seq, main.nextSeq - 1);
  }

  if (thread.summary && thread.summarizedSeq !== null) {
    const covered = [...lastMainSeqOf]
      .filter(([seq, entrySeq]) => seq <= thread.summarizedSeq! && entrySeq >= 0)
      .at(-1)?.[1];
    if (covered !== undefined) {
      main.append({
        type: "compaction",
        createdAt: uncovered.at(-1)!.createdAt,
        payload: { summary: thread.summary, coveredUpToSeq: covered },
      });
    }
  }

  for (const [runId, { chain }] of routineOf) {
    await tx.conversationSession.create({
      data: {
        id: chain.sessionId,
        spaceId: thread.spaceId,
        kind: "routine",
        parentSessionId: thread.sessionId,
      },
    });
    await tx.run.update({ where: { id: runId }, data: { sessionId: chain.sessionId } });
  }
  const chains = [main, ...[...routineOf.values()].map(({ chain }) => chain)];
  for (const chain of chains) {
    for (let start = 0; start < chain.rows.length; start += INSERT_CHUNK) {
      await tx.sessionEntry.createMany({
        data: chain.rows.slice(start, start + INSERT_CHUNK).map((row) => ({
          ...row,
          payload: row.payload as Prisma.InputJsonValue,
        })),
      });
    }
    const last = chain.rows.at(-1);
    if (!last) continue;
    await tx.conversationSession.update({
      where: { id: chain.sessionId },
      data: { nextEntrySeq: chain.nextSeq, headEntryId: last.id },
    });
  }
  return {
    threadId,
    outcome: rebuild ? "rebuilt" : head?.id ? "appended" : "backfilled",
    messages: uncovered.length,
    entries: chains.reduce((sum, chain) => sum + chain.rows.length, 0),
  };
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

/** Where a session the backfill appends to stands: the runs it started, the person's last word. */
async function priorState(tx: Prisma.TransactionClient, sessionId: string, runIds: string[]) {
  const started = await tx.$queryRaw<Array<{ runId: string }>>`
    SELECT DISTINCT "runId" FROM session_entries
    WHERE type = 'run.started' AND "runId" = ANY(${runIds}::text[])`;
  const [person] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM session_entries WHERE "sessionId" = ${sessionId} AND type = 'user.message'
    ORDER BY seq DESC LIMIT 1`;
  return { startedRuns: started.map((row) => row.runId), lastPersonEntry: person?.id };
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

function triggerOf(
  run: LegacyRun,
  lastPersonEntry: string | undefined,
  messageIds: ReadonlySet<string>,
): SessionRunTrigger {
  const source =
    run.sourceMessageId && messageIds.has(run.sourceMessageId)
      ? run.sourceMessageId
      : lastPersonEntry;
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
    SELECT r.id, r."botId", r.status, r.trigger, r."routineId", r."sourceMessageId", r.error,
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

/** The threads with a message no entry holds, by id, a batch at a time after `after`. */
export async function threadsToBackfill(
  prisma: PrismaClient,
  limit: number,
  after = "",
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT t.id FROM threads t
    WHERE t.id > ${after}
      AND EXISTS (
        SELECT 1 FROM messages m
        WHERE m."threadId" = t.id
          AND NOT EXISTS (SELECT 1 FROM session_entries e WHERE e.id = m.id))
    ORDER BY t.id LIMIT ${limit}`;
  return rows.map((row) => row.id);
}

/** Whether the legacy `messages` table is still there to read. */
export async function hasLegacyMessages(prisma: PrismaClient): Promise<boolean> {
  const [row] = await prisma.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass('public.messages') IS NOT NULL AS present`;
  return row?.present === true;
}
