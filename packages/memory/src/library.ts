import { randomUUID } from "node:crypto";
import type { Actor, MemoryCollectionKind, MemoryStatus } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, withTransactionRetry } from "@rakazo/db";
import type { LibraryInput } from "./access.js";
import { MemoryAccessError, MemoryConflictError } from "./access.js";
import {
  acceptConsolidation,
  carryConsolidationEvidence,
  proposeConsolidation,
  supersede,
} from "./consolidation.js";
import type { MemoryRow, Qualification, SourceKind } from "./documents.js";
import { MemoryDocuments, serializable, storedQualification } from "./documents.js";
import { okfMemory } from "./okf.js";
import {
  findSourceMessages,
  fingerprint,
  messageDigest,
  messageText,
  titleFor,
  withMemoryCommand,
} from "./shared.js";

export type { LibraryInput } from "./access.js";
export { MemoryAccessError, MemoryConflictError } from "./access.js";
export type { SourceKind } from "./documents.js";

type CreateInput = {
  collection: MemoryCollectionKind;
  botId?: string;
  title?: string;
  content: string;
  qualification?: Qualification;
  validFrom?: string;
  validUntil?: string;
  idempotencyKey?: string;
  active?: boolean;
  source?: { kind: SourceKind; referenceId?: string; excerpt?: string };
  evidence?: Array<{
    sourceKind: string;
    sourceRole?: "user" | "assistant" | null;
    sourceReferenceId: string;
    sourceVersion: string;
    sourceDigest: string;
    startOffset?: number | null;
    endOffset?: number | null;
    excerpt?: string | null;
  }>;
  sourceCheck?: { messageId: string; digest: string };
};
type UpdateInput = {
  documentId: string;
  expectedRevision: number;
  title?: string;
  content?: string;
  qualification?: Qualification;
  validFrom?: string | null;
  validUntil?: string | null;
  replaceDocumentId?: string;
  replacedExpectedRevision?: number;
};

function validatedDates(validFrom?: string | null, validUntil?: string | null) {
  if (validFrom && validUntil && new Date(validFrom) > new Date(validUntil))
    throw new MemoryConflictError("Validity start must be before its end");
}
const commandRetry = { retryUniqueViolation: true };

/** Authorization and transitions for product memory: what a person or their bot may read and change. */
export class MarkdownMemoryLibrary {
  private readonly docs: MemoryDocuments;
  constructor(private readonly prisma: PrismaClient) {
    this.docs = new MemoryDocuments(prisma);
  }

  async list(actor: Actor, input: LibraryInput) {
    const facetWhere = this.docs.where(actor, { ...input, status: undefined });
    const where = { ...facetWhere, ...(input.status ? { status: input.status } : {}) };
    const cursor = input.cursor
      ? await this.prisma.memoryDocument.findFirst({
          where: { id: input.cursor, ...where },
          select: { id: true, updatedAt: true },
        })
      : null;
    const clauses: Prisma.MemoryDocumentWhereInput[] = [];
    if (cursor)
      clauses.push({
        OR: [
          { updatedAt: { lt: cursor.updatedAt } },
          { updatedAt: cursor.updatedAt, id: { gt: cursor.id } },
        ],
      });
    if (input.query)
      clauses.push({
        OR: [
          { title: { contains: input.query, mode: "insensitive" } },
          { content: { contains: input.query, mode: "insensitive" } },
        ],
      });
    const rows = await this.prisma.memoryDocument.findMany({
      where: { ...where, ...(clauses.length ? { AND: clauses } : {}) },
      include: this.docs.include(actor),
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: Math.min(input.limit ?? 30, 100) + 1,
    });
    const items = rows.slice(0, input.limit ?? 30).map((row) => this.docs.summary(actor, row));
    const counts = await this.prisma.memoryDocument.groupBy({
      by: ["status"],
      where: facetWhere,
      _count: true,
    });
    const count = (status: string) => counts.find((row) => row.status === status)?._count ?? 0;
    return {
      items,
      nextCursor: rows.length > (input.limit ?? 30) ? (items.at(-1)?.id ?? null) : null,
      facets: {
        active: count("active"),
        proposed: count("proposed"),
        withdrawn: count("withdrawn"),
      },
    };
  }

  async get(actor: Actor, id: string) {
    const row = await this.docs.find(actor, id);
    const publications = await this.prisma.memoryDocument.findMany({
      where: { sourceDocumentId: row.id, ...this.docs.where(actor) },
      include: this.docs.include(actor),
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    });
    return {
      ...this.docs.document(actor, row),
      evidence: await this.docs.evidence(actor, row.id, row.revision),
      publications: publications.map((publication) => ({
        id: publication.id,
        title: publication.title,
        revision: publication.revision,
        canWithdraw: this.docs.canEdit(actor, publication),
      })),
    };
  }

  history(actor: Actor, id: string) {
    return this.docs.history(actor, id);
  }

  async importOkf(
    actor: Actor,
    input: {
      collection: MemoryCollectionKind;
      botId?: string;
      content: string;
      idempotencyKey?: string;
    },
  ) {
    return this.create(actor, {
      ...okfMemory(input.content),
      collection: input.collection,
      botId: input.botId,
      idempotencyKey: input.idempotencyKey,
      active: false,
    });
  }

  async create(actor: Actor, input: CreateInput) {
    return withTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          validatedDates(input.validFrom, input.validUntil);
          const botId =
            input.collection === "agent" ? (input.botId ?? this.docs.botId) : input.botId;
          const commandFingerprint = fingerprint({
            command: "create",
            collection: input.collection,
            botId: botId ?? null,
            title: titleFor(input.content, input.title),
            content: input.content,
            qualification: storedQualification(input.qualification),
            validFrom: input.validFrom ?? null,
            validUntil: input.validUntil ?? null,
            source: input.source ?? null,
            active: input.active === true,
          });
          return withMemoryCommand(
            tx,
            actor,
            { key: input.idempotencyKey, fingerprint: commandFingerprint },
            this.docs.replay(actor, tx),
            async () => {
              const collection = await this.docs.collection(tx, actor, input.collection, botId);
              if (input.collection === "agent" && collection.ownerUserId !== actor.userId)
                throw new MemoryAccessError();
              if (input.sourceCheck) {
                const [source] = await findSourceMessages(tx, [input.sourceCheck.messageId], actor);
                if (!source || messageDigest(source.blocks) !== input.sourceCheck.digest)
                  throw new MemoryAccessError();
              }
              await this.docs.validateEntityRefs(tx, actor, collection.id, input.qualification);
              const row = await tx.memoryDocument.create({
                data: {
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                  collectionId: collection.id,
                  botId: input.collection === "agent" ? collection.botId : null,
                  scope: input.collection === "agent" ? "bot" : "user",
                  path: `memory/${randomUUID()}.md`,
                  title: titleFor(input.content, input.title),
                  content: input.content,
                  status: input.active ? "active" : "proposed",
                  qualification: storedQualification(input.qualification),
                  validFrom: input.validFrom ? new Date(input.validFrom) : null,
                  validUntil: input.validUntil ? new Date(input.validUntil) : null,
                  sourceKind: input.source?.kind,
                  sourceReferenceId: input.source?.referenceId,
                  sourceExcerpt: input.source?.excerpt,
                },
              });
              await this.docs.revise(
                tx,
                row,
                actor.userId,
                input.idempotencyKey,
                commandFingerprint,
              );
              if (input.evidence?.length) {
                await tx.memoryEvidence.createMany({
                  data: input.evidence.map((proof) => ({
                    documentId: row.id,
                    revision: row.revision,
                    sourceKind: proof.sourceKind,
                    sourceRole: proof.sourceRole ?? null,
                    sourceReferenceId: proof.sourceReferenceId,
                    sourceVersion: proof.sourceVersion,
                    sourceDigest: proof.sourceDigest,
                    startOffset: proof.startOffset ?? null,
                    endOffset: proof.endOffset ?? null,
                    excerpt: proof.excerpt ?? null,
                  })),
                });
              }
              return this.docs.document(actor, {
                ...row,
                collection,
                space: { memberships: [] },
              } as MemoryRow);
            },
          );
        }, serializable),
      commandRetry,
    );
  }

  async proposeConsolidation(actor: Actor, input: Parameters<typeof proposeConsolidation>[2]) {
    const proposed = await proposeConsolidation(this.docs, actor, input);
    return this.get(actor, proposed.id);
  }

  /** Remember: a person keeps one of their messages as active memory, quoting it as evidence. */
  async captureMessage(
    actor: Actor,
    input: {
      messageId: string;
      botId?: string;
      title?: string;
      content?: string;
      qualification?: Qualification;
      idempotencyKey?: string;
    },
  ) {
    const [message] = await findSourceMessages(this.prisma, [input.messageId], actor);
    if (!message) throw new MemoryAccessError();
    const sourceText = messageText(message.blocks);
    const content = input.content ?? sourceText;
    if (!content) throw new MemoryConflictError("The message has no retainable text");
    const digest = messageDigest(message.blocks);
    const created = await this.create(actor, {
      collection: input.botId ? "agent" : "personal",
      botId: input.botId,
      title: input.title,
      content,
      qualification: input.qualification,
      idempotencyKey: input.idempotencyKey,
      active: true,
      source: { kind: "message", referenceId: message.id },
      sourceCheck: { messageId: message.id, digest },
      evidence: [
        {
          sourceKind: "message",
          sourceRole: message.role === "user" ? "user" : "assistant",
          sourceReferenceId: message.id,
          sourceVersion: digest,
          sourceDigest: digest,
          startOffset: 0,
          endOffset: Math.min(sourceText.length, 4_000),
          excerpt: sourceText.slice(0, 4_000),
        },
      ],
    });
    return this.get(actor, created.id);
  }

  async update(actor: Actor, input: UpdateInput) {
    return this.docs.mutate(
      actor,
      input.documentId,
      input.expectedRevision,
      async (tx, row) => {
        if (!this.docs.canEdit(actor, row)) throw new MemoryAccessError();
        if (input.qualification)
          await this.docs.validateEntityRefs(tx, actor, row.collectionId, input.qualification);
        const date = (value: string | null | undefined, current: Date | null) =>
          value === undefined ? current : value ? new Date(value) : null;
        const validFrom = date(input.validFrom, row.validFrom);
        const validUntil = date(input.validUntil, row.validUntil);
        validatedDates(validFrom?.toISOString(), validUntil?.toISOString());
        if (input.replaceDocumentId) {
          if (input.replaceDocumentId === row.id || !input.replacedExpectedRevision)
            throw new MemoryConflictError();
          const replaced = await this.docs.find(actor, input.replaceDocumentId, tx);
          if (!this.docs.canEdit(actor, replaced)) throw new MemoryAccessError();
          if (replaced.revision !== input.replacedExpectedRevision) throw new MemoryConflictError();
          await supersede(this.docs, tx, replaced.id, actor.userId);
        }
        return tx.memoryDocument.update({
          where: { id: row.id },
          data: {
            title: input.title === undefined ? row.title : titleFor(row.content, input.title),
            content: input.content ?? row.content,
            qualification: input.qualification
              ? storedQualification(input.qualification)
              : row.qualification === null
                ? Prisma.JsonNull
                : row.qualification,
            validFrom,
            validUntil,
            replacesDocumentId: input.replaceDocumentId ?? row.replacesDocumentId,
            revision: { increment: 1 },
            accessVersion: { increment: 1 },
          },
        });
      },
      async (tx, changed) => {
        if (changed.status === "proposed" || changed.status === "active")
          await carryConsolidationEvidence(this.docs, tx, actor, input.expectedRevision, changed);
      },
    );
  }
  accept(actor: Actor, id: string, expected: number) {
    return acceptConsolidation(this.docs, actor, id, expected);
  }
  acceptConsolidation(actor: Actor, id: string, expected: number, replaceSources = false) {
    return acceptConsolidation(this.docs, actor, id, expected, replaceSources);
  }
  restore(actor: Actor, id: string, expected: number) {
    return this.transition(actor, id, expected, "active", ["withdrawn"]);
  }
  withdraw(actor: Actor, id: string, expected: number) {
    return this.transition(actor, id, expected, "withdrawn", ["active", "proposed", "superseded"]);
  }

  /** Copy a memory into the Space collection as an independent, active publication. */
  async publish(
    actor: Actor,
    input: Omit<CreateInput, "collection"> & {
      documentId: string;
      expectedRevision: number;
      includeSourceExcerpt: boolean;
    },
  ) {
    return withTransactionRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const source = await this.docs.find(actor, input.documentId, tx);
          if (!this.docs.canEdit(actor, source) || source.revision !== input.expectedRevision)
            throw source.revision !== input.expectedRevision
              ? new MemoryConflictError()
              : new MemoryAccessError();
          const commandFingerprint = fingerprint({
            command: "publish",
            sourceDocumentId: source.id,
            sourceRevision: source.revision,
            title: titleFor(input.content, input.title),
            content: input.content,
            qualification: storedQualification(input.qualification),
            includeSourceExcerpt: input.includeSourceExcerpt,
          });
          return withMemoryCommand(
            tx,
            actor,
            { key: input.idempotencyKey, fingerprint: commandFingerprint },
            this.docs.replay(actor, tx),
            async () => {
              const collection = await this.docs.collection(tx, actor, "space");
              await this.docs.validateEntityRefs(tx, actor, collection.id, input.qualification);
              const row = await tx.memoryDocument.create({
                data: {
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                  collectionId: collection.id,
                  scope: "user",
                  path: `published/${randomUUID()}.md`,
                  title: titleFor(input.content, input.title),
                  content: input.content,
                  status: "active",
                  qualification: storedQualification(input.qualification),
                  sourceDocumentId: source.id,
                  sourceRevision: source.revision,
                  sourceKind: input.includeSourceExcerpt ? "document" : null,
                  sourceExcerpt: input.includeSourceExcerpt ? source.content.slice(0, 4_000) : null,
                },
              });
              await this.docs.revise(
                tx,
                row,
                actor.userId,
                input.idempotencyKey,
                commandFingerprint,
              );
              return this.docs.document(actor, {
                ...row,
                collection,
                space: { memberships: [] },
              } as MemoryRow);
            },
          );
        }, serializable),
      commandRetry,
    );
  }

  private transition(
    actor: Actor,
    id: string,
    expected: number,
    status: MemoryStatus,
    from: MemoryStatus[],
  ) {
    return this.docs.mutate(actor, id, expected, async (tx, row) => {
      if (!this.docs.canEdit(actor, row) || !from.includes(row.status as MemoryStatus))
        throw new MemoryAccessError();
      return tx.memoryDocument.update({
        where: { id },
        data: { status, revision: { increment: 1 }, accessVersion: { increment: 1 } },
      });
    });
  }
}
