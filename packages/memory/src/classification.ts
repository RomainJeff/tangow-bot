import type { Actor, MemoryMethodSnapshot } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { withTransactionRetry } from "@rakazo/db";
import {
  contentFingerprint,
  isCurrentRow,
  MemoryAccessError,
  MemoryConflictError,
} from "./access.js";
import type { MemoryBotClassificationExample, MemoryBotClassifier } from "./bot-classification.js";
import {
  classifyMemoryWithBot,
  isAllowedAnswer,
  lexicalSimilarity,
  lexicalTokens,
  prepareMemoryBotClassificationExamples,
  shortlistBotMemoryNeighbors,
} from "./bot-classification.js";
import { currentBotMethod, loadCurrentBotMethod } from "./bot-method.js";
import type { MemoryDocuments, MemoryRow } from "./documents.js";
import { serializable } from "./documents.js";
import { fingerprint } from "./shared.js";

type Db = Prisma.TransactionClient | PrismaClient;
type NeighborRef = { id: string; revision: number; content: string };
export type StoredBotClassificationExample = MemoryBotClassificationExample & {
  feedbackId: string;
  documentId: string;
  reviewerId: string;
  sourceRevision: number;
  neighborRefs: NeighborRef[];
};

/** Chooses the classifier for a method: the model it was prepared with, or a local fallback. */
export type MemoryClassifierFor = (method: MemoryMethodSnapshot) => Promise<MemoryBotClassifier>;

/** Suggest a classification with the bot's current method; all the classifier saw is re-verified. */
export async function classify(
  docs: MemoryDocuments,
  actor: Actor,
  botId: string,
  input: { documentId: string; expectedRevision?: number },
  classifierFor: MemoryClassifierFor,
) {
  const candidateRow = await docs.find(actor, input.documentId);
  const current = await loadCurrentBotMethod(docs.prisma, actor, botId);
  if (!current) throw new MemoryAccessError();
  const { method: snapshot, bot } = current;
  if (!snapshot)
    throw new MemoryConflictError("Prepare the method from your bot Instructions first");
  if (snapshot.instructions !== bot.instructions)
    throw new MemoryConflictError("Bot instructions changed. Prepare the method again.");
  if (input.expectedRevision !== undefined && candidateRow.revision !== input.expectedRevision)
    throw new MemoryConflictError("This memory changed; open it again before classifying");
  const classifier = await classifierFor(snapshot);
  if (!(await isCurrentRow(docs.prisma, actor, candidateRow, { allowProposed: true })))
    throw new MemoryConflictError("Only current memories can be classified");

  const candidate = {
    id: candidateRow.id,
    revision: candidateRow.revision,
    content: candidateRow.content,
    qualification: await docs.qualification(actor, candidateRow),
  };
  const rows = await docs.prisma.memoryDocument.findMany({
    where: { collectionId: candidateRow.collectionId, status: "active", ...docs.where(actor) },
    include: docs.include(actor),
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: 200,
  });
  const authorized = await Promise.all(
    rows.map(async (row) => {
      if (!(await isCurrentRow(docs.prisma, actor, row))) return null;
      return {
        id: row.id,
        revision: row.revision,
        content: row.content,
        qualification: await docs.qualification(actor, row),
      };
    }),
  );
  const neighbors = shortlistBotMemoryNeighbors(
    candidate,
    authorized.filter((row): row is NonNullable<typeof row> => row !== null),
  );
  const examplePool = await botClassificationExamples(docs, actor, candidateRow, botId, snapshot);
  const examples: MemoryBotClassificationExample[] = examplePool.map((example) => ({
    content: example.content,
    reviewedQuestionKeys: example.reviewedQuestionKeys,
    answers: example.answers,
    neighbors: example.neighbors,
  }));
  const selected = prepareMemoryBotClassificationExamples(examples, snapshot.prepared.questions);
  const unused = [...examplePool];
  const storedExamples: StoredBotClassificationExample[] = [];
  for (const chosen of selected) {
    const index = unused.findIndex((item) => {
      const selectedKeys = chosen.reviewedQuestionKeys;
      const normalizedNeighbors = item.neighbors
        .slice(0, 8)
        .map(({ content }) => ({ content: content.slice(0, 600) }));
      return (
        item.content === chosen.content &&
        selectedKeys.every((key) => item.reviewedQuestionKeys.includes(key)) &&
        fingerprint(Object.fromEntries(selectedKeys.map((key) => [key, item.answers[key]]))) ===
          fingerprint(chosen.answers) &&
        fingerprint(normalizedNeighbors) === fingerprint(chosen.neighbors)
      );
    });
    if (index < 0) continue;
    const [source] = unused.splice(index, 1);
    if (!source) continue;
    // Keep provenance from the full, authorized source while storing exactly
    // the normalized answers and neighbor text that the classifier received.
    storedExamples.push({
      ...source,
      reviewedQuestionKeys: chosen.reviewedQuestionKeys,
      answers: chosen.answers,
      neighbors: chosen.neighbors,
    });
  }
  const suggestion = await classifyMemoryWithBot(
    {
      method: {
        id: snapshot.id,
        version: snapshot.version,
        instructions: snapshot.instructions,
        prepared: snapshot.prepared,
      },
      candidate,
      neighbors,
      examples,
    },
    classifier,
  );
  const classificationId = await withTransactionRetry(() =>
    docs.prisma.$transaction(async (tx) => {
      const fresh = await docs.find(actor, input.documentId, tx);
      if (
        !(await isCurrentRow(tx, actor, fresh, {
          revision: candidateRow.revision,
          accessVersion: candidateRow.accessVersion,
          collectionId: candidateRow.collectionId,
          contentDigest: contentFingerprint(candidate.content),
          allowProposed: true,
        }))
      )
        throw new MemoryConflictError();
      const currentMethod = await currentBotMethod(tx, actor, fresh, botId, snapshot);
      if (!currentMethod)
        throw new MemoryConflictError("This bot method changed; classify the memory again");
      await validateBotClassificationExamples(
        docs,
        tx,
        actor,
        candidateRow,
        botId,
        snapshot,
        storedExamples,
      );
      if (!(await neighborsCurrent(docs, tx, actor, neighbors, candidateRow.collectionId)))
        throw new MemoryConflictError();
      const run = await tx.memoryClassificationRun.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId,
          methodId: snapshot.id,
          methodVersion: snapshot.version,
          methodSnapshot: {
            bot: { id: botId, name: currentMethod.bot.name },
            method: currentMethod.method,
          } as unknown as Prisma.InputJsonValue,
          documentId: input.documentId,
          collectionId: candidateRow.collectionId,
          revision: candidateRow.revision,
          accessVersion: candidateRow.accessVersion,
          sourceDigest: contentFingerprint(candidate.content),
          candidate: candidate as unknown as Prisma.InputJsonValue,
          neighbors: neighbors as unknown as Prisma.InputJsonValue,
          prediction: suggestion as unknown as Prisma.InputJsonValue,
          examples: storedExamples as unknown as Prisma.InputJsonValue,
          abstained: suggestion.abstained,
          invalidResponse: suggestion.invalidResponse ?? false,
        },
        select: { id: true },
      });
      return run.id;
    }, serializable),
  );
  return {
    candidate,
    neighbors,
    bot: { id: botId, name: bot.name },
    method: snapshot,
    suggestion,
    classificationId,
  };
}

/** Whether every neighbor is still the revision, collection and content it was. */
export async function neighborsCurrent(
  docs: MemoryDocuments,
  db: Db,
  actor: Actor,
  neighbors: NeighborRef[],
  collectionId: string,
) {
  for (const neighbor of neighbors) {
    const fresh = await docs.findOrNull(actor, neighbor.id, db);
    if (
      !(await isCurrentRow(db, actor, fresh, {
        revision: neighbor.revision,
        collectionId,
        contentDigest: contentFingerprint(neighbor.content),
      }))
    )
      return false;
  }
  return true;
}

/** The actor's latest unrevoked reviews of this bot method, closest to the candidate first. */
async function botClassificationExamples(
  docs: MemoryDocuments,
  actor: Actor,
  candidateRow: MemoryRow,
  botId: string,
  method: MemoryMethodSnapshot,
): Promise<StoredBotClassificationExample[]> {
  const candidateTokens = lexicalTokens(candidateRow.content);
  const feedback = await docs.prisma.memoryClassificationFeedback.findMany({
    where: {
      spaceId: actor.spaceId,
      collectionId: candidateRow.collectionId,
      documentId: { not: candidateRow.id },
      botId,
      methodId: method.id,
      methodVersion: method.version,
      userId: actor.userId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 100,
    select: {
      id: true,
      documentId: true,
      userId: true,
      reviewedQuestionKeys: true,
      reviewed: true,
      revokedAt: true,
    },
  });
  const latestByQuestion = new Map<string, string>();
  for (const item of [...feedback].reverse()) {
    const keys = Array.isArray(item.reviewedQuestionKeys) ? item.reviewedQuestionKeys : [];
    for (const key of keys)
      if (typeof key === "string")
        latestByQuestion.set(`${item.documentId}:${item.userId}:${key}`, item.id);
  }
  const allowedQuestions = new Map(
    method.prepared.questions.map((question) => [question.key, question]),
  );
  const candidates = await Promise.all(
    feedback.map(async (item) => {
      if (item.revokedAt) return null;
      const source = await loadExample(docs, actor, candidateRow, item.id);
      if (!source) return null;
      const rawKeys = Array.isArray(item.reviewedQuestionKeys) ? item.reviewedQuestionKeys : [];
      const reviewedQuestionKeys = rawKeys.filter(
        (key): key is string =>
          typeof key === "string" &&
          allowedQuestions.has(key) &&
          latestByQuestion.get(`${item.documentId}:${item.userId}:${key}`) === item.id,
      );
      const answers =
        item.reviewed && typeof item.reviewed === "object" && !Array.isArray(item.reviewed)
          ? (item.reviewed as Record<string, unknown>)
          : {};
      const validKeys = reviewedQuestionKeys.filter((key) =>
        isAllowedAnswer(allowedQuestions.get(key), answers[key]),
      );
      if (!validKeys.length) return null;
      return {
        feedbackId: item.id,
        documentId: item.documentId,
        reviewerId: item.userId,
        sourceRevision: source.revision,
        content: source.content,
        reviewedQuestionKeys: validKeys,
        answers: Object.fromEntries(validKeys.map((key) => [key, answers[key] as string | null])),
        neighbors: source.neighbors.map(({ content }) => ({ content })),
        neighborRefs: source.neighbors,
      } satisfies StoredBotClassificationExample;
    }),
  );
  return candidates
    .filter((item): item is StoredBotClassificationExample => item !== null)
    .map((item) => ({
      item,
      score: lexicalSimilarity(candidateTokens, lexicalTokens(item.content)),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.item.feedbackId.localeCompare(right.item.feedbackId),
    )
    .slice(0, 100)
    .map(({ item }) => item);
}

/** A reviewed example while its memory and every neighbor it was reviewed with are unchanged. */
async function loadExample(
  docs: MemoryDocuments,
  actor: Actor,
  candidateRow: MemoryRow,
  feedbackId: string,
  tx: Db = docs.prisma,
): Promise<{
  content: string;
  revision: number;
  reviewerId: string;
  neighbors: NeighborRef[];
} | null> {
  const feedback = await tx.memoryClassificationFeedback.findFirst({
    where: {
      id: feedbackId,
      spaceId: actor.spaceId,
      collectionId: candidateRow.collectionId,
      userId: actor.userId,
      revokedAt: null,
      methodId: { not: null },
    },
    include: { run: true },
  });
  if (
    !feedback ||
    feedback.documentId === candidateRow.id ||
    !feedback.methodId ||
    !feedback.botId ||
    !feedback.methodVersion
  )
    return null;
  const source = await docs.findOrNull(actor, feedback.documentId, tx);
  if (
    !source ||
    !(await isCurrentRow(tx, actor, source, {
      revision: feedback.resultRevision,
      contentDigest: feedback.sourceDigest,
    }))
  )
    return null;
  if (!Array.isArray(feedback.run.neighbors) || feedback.run.neighbors.length > 8) return null;
  const neighbors = (feedback.run.neighbors as NeighborRef[]).map(({ id, revision, content }) => ({
    id,
    revision,
    content,
  }));
  if (!(await neighborsCurrent(docs, tx, actor, neighbors, candidateRow.collectionId))) return null;
  return {
    content: source.content,
    revision: source.revision,
    reviewerId: feedback.userId,
    neighbors,
  };
}

/** Throws unless every stored example is still the latest, unrevoked review it was. */
export async function validateBotClassificationExamples(
  docs: MemoryDocuments,
  tx: Prisma.TransactionClient,
  actor: Actor,
  candidateRow: MemoryRow,
  botId: string,
  method: Pick<MemoryMethodSnapshot, "id" | "version">,
  examples: StoredBotClassificationExample[],
) {
  for (const example of examples) {
    const current = await loadExample(docs, actor, candidateRow, example.feedbackId, tx);
    if (
      !current ||
      current.reviewerId !== example.reviewerId ||
      current.revision !== example.sourceRevision ||
      current.content !== example.content ||
      fingerprint(current.neighbors) !== fingerprint(example.neighborRefs)
    )
      throw new MemoryConflictError("A reviewed example changed; classify the memory again");
    const history = await tx.memoryClassificationFeedback.findMany({
      where: {
        botId,
        methodId: method.id,
        methodVersion: method.version,
        documentId: example.documentId,
        userId: example.reviewerId,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, reviewedQuestionKeys: true, reviewed: true },
    });
    const latestByKey = new Map<string, (typeof history)[number]>();
    for (const item of history) {
      const keys = Array.isArray(item.reviewedQuestionKeys) ? item.reviewedQuestionKeys : [];
      for (const key of keys) if (typeof key === "string") latestByKey.set(key, item);
    }
    const feedback = history.find((item) => item.id === example.feedbackId);
    if (
      !feedback ||
      example.reviewedQuestionKeys.some((key) => latestByKey.get(key)?.id !== example.feedbackId) ||
      example.reviewedQuestionKeys.some(
        (key) => (feedback.reviewed as Record<string, unknown>)[key] !== example.answers[key],
      )
    )
      throw new MemoryConflictError("A reviewed example changed; classify the memory again");
  }
}
