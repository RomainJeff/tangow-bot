import type { Actor, MemoryMethodAnnotation, MemoryMethodSnapshot } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import { withTransactionRetry } from "@rakazo/db";
import { isCurrentRow, MemoryAccessError, MemoryConflictError } from "./access.js";
import { isAllowedAnswer } from "./bot-classification.js";
import { currentBotMethod } from "./bot-method.js";
import type { StoredBotClassificationExample } from "./classification.js";
import { neighborsCurrent, validateBotClassificationExamples } from "./classification.js";
import type { MemoryDocuments } from "./documents.js";
import { serializable } from "./documents.js";
import { fingerprint } from "./shared.js";

type MethodEnvelope = { bot: { id: string; name: string }; method: MemoryMethodSnapshot };

/** Save a human judgment as an immutable annotation, independent of document qualification. */
export async function reviewBotClassification(
  docs: MemoryDocuments,
  actor: Actor,
  input: {
    classificationId: string;
    /** The classified memory, when the caller names it. */
    documentId?: string;
    expectedRevision: number;
    reviewedQuestionKeys: string[];
    answers: Record<string, string | null>;
  },
) {
  if (
    new Set(input.reviewedQuestionKeys).size !== input.reviewedQuestionKeys.length ||
    input.reviewedQuestionKeys.length < 1 ||
    input.reviewedQuestionKeys.length > 8 ||
    Object.keys(input.answers).some((key) => !input.reviewedQuestionKeys.includes(key)) ||
    input.reviewedQuestionKeys.some((key) => !(key in input.answers))
  )
    throw new MemoryConflictError("Review answers must match the reviewed questions");
  const payloadFingerprint = fingerprint({
    expectedRevision: input.expectedRevision,
    reviewedQuestionKeys: [...input.reviewedQuestionKeys].sort(),
    answers: input.answers,
  });
  return withTransactionRetry(() =>
    docs.prisma.$transaction(async (tx) => {
      const run = await tx.memoryClassificationRun.findFirst({
        where: {
          id: input.classificationId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          methodId: { not: null },
          ...(input.documentId ? { documentId: input.documentId } : {}),
          ...(docs.botId ? { botId: docs.botId } : {}),
        },
      });
      if (!run?.methodSnapshot || !run.methodId || !run.botId || !run.methodVersion)
        throw new MemoryAccessError();
      const prior = await tx.memoryClassificationFeedback.findUnique({ where: { runId: run.id } });
      const row = await docs.find(actor, run.documentId, tx);
      if (prior) {
        if (prior.payloadFingerprint !== payloadFingerprint) throw new MemoryConflictError();
        return { feedbackId: prior.id };
      }
      if (
        run.revision !== input.expectedRevision ||
        !(await isCurrentRow(tx, actor, row, {
          revision: input.expectedRevision,
          accessVersion: run.accessVersion,
          collectionId: run.collectionId,
          contentDigest: run.sourceDigest,
          allowProposed: true,
        }))
      )
        throw new MemoryConflictError("The classified memory changed; classify it again");
      const { method } = run.methodSnapshot as MethodEnvelope;
      if (!(await currentBotMethod(tx, actor, row, run.botId, method)))
        throw new MemoryAccessError();
      const questions = new Map(
        method.prepared.questions.map((question) => [question.key, question]),
      );
      if (
        input.reviewedQuestionKeys.some(
          (key) => !questions.has(key) || !isAllowedAnswer(questions.get(key), input.answers[key]),
        )
      )
        throw new MemoryAccessError();
      if (!Array.isArray(run.neighbors) || run.neighbors.length > 8)
        throw new MemoryConflictError();
      const neighbors = run.neighbors as Array<{ id: string; revision: number; content: string }>;
      if (!(await neighborsCurrent(docs, tx, actor, neighbors, row.collectionId)))
        throw new MemoryConflictError("A classified neighbor changed; classify again");
      await validateBotClassificationExamples(
        docs,
        tx,
        actor,
        row,
        run.botId,
        { id: run.methodId, version: run.methodVersion },
        Array.isArray(run.examples) ? (run.examples as StoredBotClassificationExample[]) : [],
      );
      const feedback = await tx.memoryClassificationFeedback.create({
        data: {
          runId: run.id,
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: run.botId,
          methodId: run.methodId,
          methodVersion: run.methodVersion,
          reviewedQuestionKeys: input.reviewedQuestionKeys as unknown as Prisma.InputJsonValue,
          documentId: row.id,
          collectionId: row.collectionId,
          sourceDigest: run.sourceDigest,
          reviewed: input.answers as unknown as Prisma.InputJsonValue,
          prediction: run.prediction as Prisma.InputJsonValue,
          payloadFingerprint,
          qualificationAfter: row.qualification as Prisma.InputJsonValue,
          resultRevision: row.revision,
        },
        select: { id: true },
      });
      return { feedbackId: feedback.id };
    }, serializable),
  );
}

/** The actor's reviews of one memory, each with the bot and method version that suggested it. */
export async function memoryAnnotations(
  docs: MemoryDocuments,
  actor: Actor,
  documentId: string,
): Promise<MemoryMethodAnnotation[]> {
  await docs.find(actor, documentId);
  const feedback = await docs.prisma.memoryClassificationFeedback.findMany({
    where: { spaceId: actor.spaceId, documentId, userId: actor.userId },
    include: {
      method: { include: { bot: { select: { id: true, name: true } } } },
      run: { select: { methodSnapshot: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  return feedback.flatMap((item) => {
    if (!item.methodVersion) return [];
    const snapshot = item.run.methodSnapshot as Partial<MethodEnvelope> | null;
    const method = snapshot?.method;
    const bot =
      item.method?.bot ??
      (snapshot?.bot?.id && snapshot.bot.name
        ? { id: snapshot.bot.id, name: snapshot.bot.name }
        : null);
    const methodId = item.method?.id ?? method?.id;
    if (!method || !bot || !methodId || !method.prepared?.questions) return [];
    return [
      {
        id: item.id,
        bot,
        method: { id: methodId, version: item.methodVersion, questions: method.prepared.questions },
        answers: item.reviewed as Record<string, string | null>,
        createdAt: item.createdAt.toISOString(),
        revokedAt: item.revokedAt?.toISOString() ?? null,
      },
    ];
  });
}

/** Stop reusing a review as an example; the annotation and its audit stay. */
export async function revokeClassificationFeedback(
  docs: MemoryDocuments,
  actor: Actor,
  feedbackId: string,
  documentId?: string,
) {
  await withTransactionRetry(() =>
    docs.prisma.$transaction(async (tx) => {
      const feedback = await tx.memoryClassificationFeedback.findFirst({
        where: {
          id: feedbackId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          ...(documentId ? { documentId } : {}),
          ...(docs.botId ? { botId: docs.botId } : {}),
        },
      });
      if (!feedback) throw new MemoryAccessError();
      if (docs.botId) await docs.find(actor, feedback.documentId, tx);
      if (feedback.revokedAt) return;
      await tx.memoryClassificationFeedback.update({
        where: { id: feedback.id },
        data: { revokedAt: new Date(), revokedByUserId: actor.userId },
      });
    }, serializable),
  );
  return { ok: true as const };
}
