import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import { withTransactionRetry } from "@rakazo/db";
import type { StoredMemoryRow } from "./access.js";
import {
  checkDocumentProof,
  isMemoryRecallEligible,
  MemoryAccessError,
  MemoryConflictError,
} from "./access.js";
import type { MemoryDocuments, MemoryRow } from "./documents.js";
import { serializable } from "./documents.js";
import { fingerprint, titleFor, withMemoryCommand } from "./shared.js";

type Evidence = Prisma.MemoryEvidenceGetPayload<Record<string, never>>;
const commandRetry = { retryUniqueViolation: true };

/** A proposal that merges 2 to 8 current memories of one collection, citing each source revision. */
export async function proposeConsolidation(
  docs: MemoryDocuments,
  actor: Actor,
  input: {
    sources: Array<{ documentId: string; revision: number }>;
    content: string;
    title?: string;
    idempotencyKey?: string;
  },
) {
  const uniqueIds = new Set(input.sources.map((source) => source.documentId));
  if (
    input.sources.length < 2 ||
    input.sources.length > 8 ||
    uniqueIds.size !== input.sources.length
  )
    throw new MemoryConflictError("Consolidation requires 2 to 8 distinct sources");
  if (!input.content.trim()) throw new MemoryConflictError("Consolidated content is required");
  return withTransactionRetry(
    () =>
      docs.prisma.$transaction(async (tx) => {
        const commandFingerprint = fingerprint({
          command: "consolidate",
          sources: input.sources,
          title: titleFor(input.content, input.title),
          content: input.content,
        });
        return withMemoryCommand(
          tx,
          actor,
          { key: input.idempotencyKey, fingerprint: commandFingerprint },
          docs.replay(actor, tx),
          async () => {
            const sources = [];
            for (const reference of input.sources) {
              const source = await docs.find(actor, reference.documentId, tx);
              if (source.revision !== reference.revision || source.status !== "active")
                throw new MemoryConflictError();
              sources.push(source);
            }
            const first = sources[0]!;
            if (sources.some((source) => source.collectionId !== first.collectionId))
              throw new MemoryAccessError();
            for (const source of sources) {
              if (!(await isMemoryRecallEligible(tx, actor, source)))
                throw new MemoryConflictError(
                  "A consolidation source depends on stale or inaccessible evidence",
                );
            }
            const row = await tx.memoryDocument.create({
              data: {
                spaceId: actor.spaceId,
                userId: actor.userId,
                collectionId: first.collectionId,
                botId: first.botId,
                scope: first.scope,
                path: `memory/${randomUUID()}.md`,
                title: titleFor(input.content, input.title),
                content: input.content,
                status: "proposed",
                qualification: { subjects: [] },
              },
            });
            await docs.revise(tx, row, actor.userId, input.idempotencyKey, commandFingerprint);
            await tx.memoryEvidence.createMany({
              data: sources.map((source) => ({
                documentId: row.id,
                revision: row.revision,
                sourceKind: "document",
                sourceRole: null,
                sourceReferenceId: source.id,
                sourceVersion: String(source.revision),
                sourceDigest: fingerprint({
                  id: source.id,
                  revision: source.revision,
                  content: source.content,
                }),
                startOffset: null,
                endOffset: null,
                excerpt: null,
              })),
            });
            return docs.document(actor, await docs.find(actor, row.id, tx));
          },
        );
      }, serializable),
    commandRetry,
  );
}

/** Activate a proposal; a consolidation only while its sources are unchanged, superseding them if asked. */
export async function acceptConsolidation(
  docs: MemoryDocuments,
  actor: Actor,
  id: string,
  expected: number,
  replaceSources = false,
) {
  let evidenceToCopy: Evidence[] = [];
  return docs.mutate(
    actor,
    id,
    expected,
    async (tx, row) => {
      if (!docs.canEdit(actor, row) || row.status !== "proposed") throw new MemoryAccessError();
      const evidence = await tx.memoryEvidence.findMany({
        where: { documentId: row.id, revision: row.revision, sourceKind: "document" },
        orderBy: { createdAt: "asc" },
      });
      const hasOlderConsolidationEvidence =
        evidence.length === 0 &&
        (await tx.memoryEvidence.count({
          where: { documentId: row.id, sourceKind: "document" },
        })) > 0;
      if (hasOlderConsolidationEvidence)
        throw new MemoryConflictError("A changed consolidation must be proposed again");
      if (evidence.length) {
        evidenceToCopy = evidence;
        if (evidence.length < 2 || evidence.length > 8) throw new MemoryConflictError();
        const sourceRows: MemoryRow[] = [];
        for (const proof of evidence) {
          const source = await docs.find(actor, proof.sourceReferenceId, tx);
          if (
            source.collectionId !== row.collectionId ||
            (await checkDocumentProof(tx, proof, source, false)) === null
          )
            throw new MemoryConflictError(
              "A consolidation source changed or is no longer available",
            );
          if (!(await isMemoryRecallEligible(tx, actor, source)))
            throw new MemoryConflictError(
              "A consolidation source depends on stale or inaccessible evidence",
            );
          sourceRows.push(source);
        }
        if (replaceSources) {
          evidenceToCopy = evidence.map((proof) => ({ ...proof, sourceRole: "replacement" }));
          await tx.memoryEvidence.updateMany({
            where: { documentId: row.id, revision: row.revision, sourceKind: "document" },
            data: { sourceRole: "replacement" },
          });
          for (const source of sourceRows) {
            if (!docs.canEdit(actor, source)) throw new MemoryAccessError();
            await supersede(docs, tx, source.id, actor.userId);
          }
        }
      }
      return tx.memoryDocument.update({
        where: { id: row.id },
        data: { status: "active", revision: { increment: 1 }, accessVersion: { increment: 1 } },
      });
    },
    async (tx, activated) => {
      if (evidenceToCopy.length) await copyEvidence(tx, evidenceToCopy, activated);
    },
  );
}

export async function supersede(
  docs: MemoryDocuments,
  tx: Prisma.TransactionClient,
  id: string,
  actorUserId: string,
) {
  const superseded = await tx.memoryDocument.update({
    where: { id },
    data: { status: "superseded", revision: { increment: 1 }, accessVersion: { increment: 1 } },
  });
  await docs.revise(tx, superseded, actorUserId);
}

/** Carry a consolidation's sources onto an edited revision while every source still vouches. */
export async function carryConsolidationEvidence(
  docs: MemoryDocuments,
  tx: Prisma.TransactionClient,
  actor: Actor,
  previousRevision: number,
  changed: StoredMemoryRow,
) {
  const evidence = await tx.memoryEvidence.findMany({
    where: { documentId: changed.id, revision: previousRevision, sourceKind: "document" },
    orderBy: { createdAt: "asc" },
  });
  if (evidence.length < 2 || evidence.length > 8) return;
  for (const proof of evidence) {
    const source = await docs.findOrNull(actor, proof.sourceReferenceId, tx);
    if (source?.collectionId !== changed.collectionId) return;
    const revision = await checkDocumentProof(tx, proof, source);
    if (revision === null || !(await isMemoryRecallEligible(tx, actor, { ...source, revision })))
      return;
  }
  await copyEvidence(tx, evidence, changed);
}

function copyEvidence(
  tx: Prisma.TransactionClient,
  evidence: Evidence[],
  target: { id: string; revision: number },
) {
  return tx.memoryEvidence.createMany({
    data: evidence.map((proof) => ({
      documentId: target.id,
      revision: target.revision,
      sourceKind: proof.sourceKind,
      sourceRole: proof.sourceRole,
      sourceReferenceId: proof.sourceReferenceId,
      sourceVersion: proof.sourceVersion,
      sourceDigest: proof.sourceDigest,
      startOffset: proof.startOffset,
      endOffset: proof.endOffset,
      excerpt: proof.excerpt,
    })),
  });
}
