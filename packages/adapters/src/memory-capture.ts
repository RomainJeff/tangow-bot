import { createHash } from "node:crypto";
import type {
  AdapterContext,
  MemoryCommitRequest,
  MemoryStore,
  SessionLog,
} from "@rakazo/adapter-kit";
import type { MemoryManifestEntry, MessageBlock, SessionEntry, SessionId } from "@rakazo/contracts";
import { EntryId } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { historyGeneration, Prisma } from "@rakazo/db";
import { getLogger, redactSensitiveText } from "@rakazo/logging";
import { messageDigest, messageText } from "@rakazo/memory";
import { z } from "zod";
import type { MemoryGrant } from "./memory-context.js";
import { memoryGrant } from "./memory-context.js";

const CAPTURE_EXTRACTOR_VERSION = "memory-capture-v1";
const MAX_CAPTURE_ATTEMPTS = 5;

/** The entries whose words a capture can quote: the person's messages and the bot's own text. */
export type CaptureSource = Extract<SessionEntry, { type: "user.message" | "assistant.text" }>;
function isCaptureSource(entry: SessionEntry): entry is CaptureSource {
  return entry.type === "user.message" || entry.type === "assistant.text";
}
const sourceVersionOf = (entry: CaptureSource) => messageDigest(entry.payload.blocks);

/** The model call: facts in `sources` with exact quotes. Adds memory it shows to `grant`; throws to retry. */
export type CaptureExtractor = (input: {
  sources: CaptureSource[];
  fromSeq: number;
  grant: MemoryGrant;
}) => Promise<Array<{ fact: string; sourceMessageId: string; quote: string }>>;

type CaptureThread = {
  id: string;
  botId: string;
  spaceId: string;
  userId: string;
  sessionId: string;
};

const persistedCandidatesSchema = z.array(
  z.object({
    fact: z.string(),
    idempotencyKey: z.string(),
    evidence: z.object({
      sourceKind: z.literal("message"),
      sourceReferenceId: z.string(),
      sourceVersion: z.string(),
      startOffset: z.number(),
      endOffset: z.number(),
      excerpt: z.string(),
    }),
  }),
) satisfies z.ZodType<Array<{ evidence: NonNullable<MemoryCommitRequest["evidence"]>[number] }>>;
type PersistedCaptureCandidate = z.infer<typeof persistedCandidatesSchema>[number];
/** The session entries a capture request reads, by id and a digest of their blocks. */
const captureSourceMessagesSchema = z
  .array(z.object({ messageId: z.string(), sourceVersion: z.string() }))
  .min(1);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Durable capture of a thread's compacted turns into memory proposals. A request is written with
 * the compaction that covered its turns, so a failed extraction is retried with bounded backoff
 * instead of losing the facts. A rewind or clear that starts a new history generation, a withdrawn
 * memory dependency, a changed source or lost membership marks it stale before any further write.
 */
export function memoryCapture(
  deps: {
    prisma: PrismaClient;
    sessionLog: SessionLog<Prisma.TransactionClient>;
    memory: MemoryStore;
  },
  thread: CaptureThread,
  context: AdapterContext,
) {
  const sessionId = thread.sessionId as SessionId;
  return {
    /** In the compaction's transaction, one request per chunk with quotable entries; returns keys. */
    async enqueue(
      tx: Prisma.TransactionClient,
      chunks: Array<{ fromSeqExclusive: number; toSeqInclusive: number; entries: SessionEntry[] }>,
      at: { generation: number; manifest: MemoryManifestEntry[] },
    ): Promise<string[]> {
      const requests = chunks.flatMap(({ fromSeqExclusive, toSeqInclusive, entries }) => {
        const sources = entries.filter(isCaptureSource);
        if (sources.length === 0) return [];
        return [
          {
            idempotencyKey: `capture:${sha256(`${sessionId}\n${at.generation}\n${fromSeqExclusive}\n${toSeqInclusive}\n${CAPTURE_EXTRACTOR_VERSION}`)}`,
            threadId: thread.id,
            botId: thread.botId,
            spaceId: thread.spaceId,
            userId: thread.userId,
            historyGeneration: at.generation,
            fromSeqExclusive,
            toSeqInclusive,
            sourceMessages: sources.map((source) => ({
              messageId: source.id,
              sourceVersion: sourceVersionOf(source),
            })),
            memoryManifest: at.manifest,
          },
        ];
      });
      if (requests.length > 0) await tx.memoryCaptureRequest.createMany({ data: requests });
      return requests.map((request) => request.idempotencyKey);
    },

    /** Run the pending requests with `keys` in order, or without keys the oldest one now due. */
    async drain(extract: CaptureExtractor, keys?: string[]) {
      const pending = await deps.prisma.memoryCaptureRequest.findMany({
        where: keys
          ? { idempotencyKey: { in: keys }, status: "pending" }
          : { threadId: thread.id, status: "pending", availableAt: { lte: new Date() } },
        orderBy: keys ? { fromSeqExclusive: "asc" } : { createdAt: "asc" },
        take: keys ? undefined : 1,
        select: { id: true },
      });
      for (const request of pending) await run(request.id, extract);
    },
  };

  async function run(requestId: string, extract: CaptureExtractor): Promise<void> {
    const request = await deps.prisma.memoryCaptureRequest.findUnique({ where: { id: requestId } });
    if (request?.status !== "pending") return;
    const attemptsBefore = request.attempts;
    const finish = (status: "completed" | "failed" | "stale", lastError: string | null) =>
      deps.prisma.memoryCaptureRequest.updateMany({
        where: { id: request.id, status: "pending" },
        data: { status, lastError, candidates: Prisma.DbNull, completedAt: new Date() },
      });
    if (attemptsBefore >= MAX_CAPTURE_ATTEMPTS) {
      await finish("failed", "capture_attempts_exhausted");
      return;
    }
    await deps.prisma.memoryCaptureRequest.updateMany({
      where: { id: request.id, status: "pending" },
      data: { attempts: { increment: 1 }, lastError: null },
    });

    try {
      const parsedSources = captureSourceMessagesSchema.safeParse(request.sourceMessages);
      if (!parsedSources.success) {
        await finish("stale", "source message manifest is invalid");
        return;
      }
      const sourceIds = parsedSources.data.map((source) => source.messageId);
      const grant = await memoryGrant(deps.memory, thread.botId, context);
      grant.add(request.memoryManifest);
      const readSources = async () =>
        (
          await deps.prisma.sessionEntry.findMany({
            where: { id: { in: sourceIds }, sessionId },
            select: { id: true, type: true, payload: true },
          })
        ).map((row) => ({ ...row, payload: row.payload as { blocks?: MessageBlock[] } }));

      // The model call and every memory write may take long enough for the source or its
      // dependencies to change. Check all inputs at every write boundary, including after the
      // final write and before marking the request done.
      const staleReason = async () => {
        if (!(await grant.isCurrent())) return "memory dependencies are no longer authorized";
        const [membership, generation, latest] = await Promise.all([
          deps.prisma.spaceMember.findFirst({
            where: { spaceId: thread.spaceId, userId: thread.userId },
            select: { id: true },
          }),
          historyGeneration(deps.prisma, sessionId),
          readSources(),
        ]);
        if (!membership) return "source access revoked";
        if (generation !== request.historyGeneration) return "history generation changed";
        const latestById = new Map(latest.map((entry) => [entry.id, entry]));
        if (
          parsedSources.data.some((source) => {
            const entry = latestById.get(source.messageId);
            return !entry || messageDigest(entry.payload.blocks) !== source.sourceVersion;
          })
        )
          return "source message changed or was deleted";
        return null;
      };
      const staleNow = async () => {
        const reason = await staleReason();
        if (reason) await finish("stale", reason);
        return reason !== null;
      };

      if (await staleNow()) return;
      let candidates = persistedCandidatesSchema.safeParse(request.candidates).data ?? null;
      if (candidates === null) {
        const entries = await Promise.all(
          sourceIds.map((id) => deps.sessionLog.readEntry(sessionId, EntryId.parse(id))),
        );
        const sources = entries.filter(
          (entry): entry is CaptureSource => entry !== undefined && isCaptureSource(entry),
        );
        candidates = proposals(
          sources,
          await extract({ sources, fromSeq: request.fromSeqExclusive + 1, grant }),
        );
        const stored = await deps.prisma.memoryCaptureRequest.updateMany({
          where: { id: request.id, status: "pending", candidates: { equals: Prisma.DbNull } },
          data: { candidates, memoryManifest: grant.toJSON() },
        });
        if (stored.count === 0) {
          const current = await deps.prisma.memoryCaptureRequest.findUnique({
            where: { id: request.id },
          });
          const persisted = persistedCandidatesSchema.safeParse(current?.candidates);
          if (!persisted.success) throw new Error("capture candidates could not be persisted");
          candidates = persisted.data;
        }
      }

      for (const candidate of candidates) {
        if (await staleNow()) return;
        // A runtime commit is always a proposal: nothing captured is active until a person accepts it.
        await deps.memory.commit(
          {
            scope: "bot",
            botId: thread.botId,
            path: "MEMORY.md",
            content: candidate.fact,
            mode: "append",
            sourceThreadId: thread.id,
            idempotencyKey: candidate.idempotencyKey,
            evidence: [candidate.evidence],
          },
          context,
        );
      }
      if (await staleNow()) return;
      await finish("completed", null);
    } catch (error) {
      // Retry with bounded exponential delay; a permanently unavailable extractor must not turn
      // the next compactions into an unbounded model-call loop.
      const attempts = attemptsBefore + 1;
      const exhausted = attempts >= MAX_CAPTURE_ATTEMPTS;
      await deps.prisma.memoryCaptureRequest.updateMany({
        where: { id: request.id, status: "pending" },
        data: {
          status: exhausted ? "failed" : "pending",
          attempts,
          lastError: "capture_attempt_failed",
          availableAt: exhausted
            ? request.availableAt
            : new Date(Date.now() + 1_000 * 2 ** attempts),
          ...(exhausted ? { candidates: Prisma.DbNull, completedAt: new Date() } : {}),
        },
      });
      getLogger().warn("history.compact durable capture attempt failed", {
        threadId: thread.id,
        exhausted,
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  /** Each candidate whose quote is found verbatim in its source, with the quote's offsets. */
  function proposals(
    sources: CaptureSource[],
    candidates: Awaited<ReturnType<CaptureExtractor>>,
  ): PersistedCaptureCandidate[] {
    const byId = new Map(
      sources.map((source) => [
        source.id as string,
        { text: messageText(source.payload.blocks), version: sourceVersionOf(source) },
      ]),
    );
    const proposed: PersistedCaptureCandidate[] = [];
    for (const candidate of candidates) {
      const source = byId.get(candidate.sourceMessageId);
      const fact = redactSensitiveText(candidate.fact.trim());
      const quote = candidate.quote.trim();
      if (!source || !fact || !quote || quote.length > 4_000) continue;
      const startOffset = source.text.indexOf(quote);
      if (startOffset < 0) continue;
      const candidateKey = sha256(
        `${thread.id}\n${candidate.sourceMessageId}\n${source.version}\n${CAPTURE_EXTRACTOR_VERSION}\n${fact}`,
      );
      proposed.push({
        fact,
        idempotencyKey: `capture:${candidateKey}`,
        evidence: {
          sourceKind: "message",
          sourceReferenceId: candidate.sourceMessageId,
          sourceVersion: source.version,
          startOffset,
          endOffset: startOffset + quote.length,
          excerpt: quote,
        },
      });
    }
    getLogger().info("history.compact.learned", {
      threadId: thread.id,
      botId: thread.botId,
      facts: proposed.length,
    });
    return proposed;
  }
}
