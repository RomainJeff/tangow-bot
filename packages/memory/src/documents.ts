import type {
  Actor,
  MemoryCollectionKind,
  MemoryQualification,
  MemoryStatus,
} from "@rakazo/contracts";
import { MemoryQualificationSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, withTransactionRetry } from "@rakazo/db";
import type { StoredMemoryRow } from "./access.js";
import {
  checkDocumentProof,
  isMemoryRecallEligible,
  MemoryAccessError,
  MemoryConflictError,
  quotesMessage,
  visibleWhere,
} from "./access.js";
import { findSourceMessages, isRecord, memoryCollection, normalizeJsonValue } from "./shared.js";

export type Qualification = MemoryQualification;
export type SourceKind = "message" | "thread" | "run" | "document" | "inherited";
export type MemoryRow = Prisma.MemoryDocumentGetPayload<{
  include: { collection: true; space: { select: { memberships: { select: { role: true } } } } };
}>;
type Db = Prisma.TransactionClient | PrismaClient;

export const qualification = (value: unknown): Qualification => {
  if (!isRecord(value)) return { subjects: [] };
  const parsed = MemoryQualificationSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // Keep every field that is still valid on its own when the stored value as a whole is not.
  const fields: Record<string, unknown> = { subjects: [] };
  for (const [key, schema] of Object.entries(MemoryQualificationSchema.shape)) {
    const field = schema.safeParse(value[key]);
    if (field.success && field.data !== undefined) fields[key] = field.data;
  }
  return fields as Qualification;
};

/** Message sources stay private to their thread, so only their kind is shown. */
export function sources(row: {
  sourceKind: string | null;
  sourceReferenceId: string | null;
  sourceExcerpt: string | null;
  sourceDocumentId: string | null;
}) {
  if (row.sourceKind) {
    const message = row.sourceKind === "message";
    return [
      {
        kind: row.sourceKind as SourceKind,
        referenceId: message ? null : row.sourceReferenceId,
        excerpt: message ? null : row.sourceExcerpt,
      },
    ];
  }
  return row.sourceDocumentId
    ? []
    : [{ kind: "inherited" as const, referenceId: null, excerpt: null }];
}

export function storedQualification(value?: Qualification): Prisma.InputJsonValue {
  try {
    return normalizeJsonValue(value ?? { subjects: [] }) as Prisma.InputJsonValue;
  } catch (error) {
    throw new MemoryConflictError(error instanceof Error ? error.message : undefined);
  }
}

export const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };

/**
 * The documents one actor can see, optionally narrowed to one bot: finding, presenting and
 * revising them. Every library operation reads through here, so the bot scope holds everywhere.
 */
export class MemoryDocuments {
  constructor(
    readonly prisma: PrismaClient,
    readonly botId?: string,
  ) {}

  where(actor: Actor, input: Parameters<typeof visibleWhere>[1] = {}) {
    return visibleWhere(actor, input, this.botId);
  }

  include(actor: Actor) {
    return {
      collection: true,
      space: {
        select: { memberships: { where: { userId: actor.userId }, select: { role: true } } },
      },
    } satisfies Prisma.MemoryDocumentInclude;
  }

  async find(actor: Actor, id: string, db: Db = this.prisma): Promise<MemoryRow> {
    const row = await db.memoryDocument.findFirst({
      where: { id, ...this.where(actor) },
      include: this.include(actor),
    });
    if (!row) throw new MemoryAccessError();
    return row;
  }

  findOrNull(actor: Actor, id: string, db: Db = this.prisma) {
    return this.find(actor, id, db).catch(() => null);
  }

  /** The collection a new memory goes to; a bot collection only for the actor's own bot. */
  async collection(
    tx: Prisma.TransactionClient,
    actor: Actor,
    kind: MemoryCollectionKind,
    botId?: string,
  ) {
    if (kind === "agent" && (!botId || (this.botId && botId !== this.botId)))
      throw new MemoryAccessError();
    if (
      kind === "agent" &&
      !(await tx.bot.findFirst({
        where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      }))
    )
      throw new MemoryAccessError();
    return memoryCollection(tx, actor, kind, botId ?? null);
  }

  canEdit(actor: Actor, row: MemoryRow) {
    return row.collection.kind !== "space"
      ? row.collection.ownerUserId === actor.userId
      : row.userId === actor.userId ||
          row.space.memberships.some((membership) => membership.role === "owner");
  }

  summary(actor: Actor, row: MemoryRow) {
    return {
      id: row.id,
      collection: {
        kind: row.collection.kind as MemoryCollectionKind,
        ownerUserId: row.collection.ownerUserId,
        botId: row.collection.botId,
      },
      title: row.title,
      revision: row.revision,
      accessVersion: row.accessVersion,
      status: row.status as MemoryStatus,
      qualification: qualification(row.qualification),
      validFrom: row.validFrom?.toISOString() ?? null,
      validUntil: row.validUntil?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      canEdit: this.canEdit(actor, row),
      canPublish: this.canEdit(actor, row),
      canWithdraw: this.canEdit(actor, row),
    };
  }

  document(actor: Actor, row: MemoryRow) {
    return {
      ...this.summary(actor, row),
      content: row.content,
      sources: sources(row),
      publications: [],
    };
  }

  /** A command replay returns the document the first attempt produced, or conflicts. */
  replay(actor: Actor, tx: Prisma.TransactionClient) {
    return async (documentId: string | null, sameFingerprint: boolean) => {
      if (!documentId || !sameFingerprint) throw new MemoryConflictError();
      return this.document(actor, await this.find(actor, documentId, tx));
    };
  }

  async revise(
    tx: Prisma.TransactionClient,
    row: StoredMemoryRow,
    actorUserId: string,
    idempotencyKey?: string,
    commandFingerprint?: string,
  ) {
    await tx.memoryRevision.create({
      data: {
        documentId: row.id,
        revision: row.revision,
        content: row.content,
        title: row.title,
        status: row.status,
        qualification: row.qualification === null ? Prisma.JsonNull : row.qualification,
        validFrom: row.validFrom,
        validUntil: row.validUntil,
        accessVersion: row.accessVersion,
        actorUserId,
        idempotencyKey,
        commandFingerprint,
        sourceDocumentId: row.sourceDocumentId,
        sourceRevision: row.sourceRevision,
        sourceKind: row.sourceKind,
        sourceReferenceId: row.sourceReferenceId,
        sourceExcerpt: row.sourceExcerpt,
        replacesDocumentId: row.replacesDocumentId,
      },
    });
  }

  /** Change one document at its expected revision and record the new revision. */
  async mutate(
    actor: Actor,
    id: string,
    expected: number,
    operation: (tx: Prisma.TransactionClient, row: MemoryRow) => Promise<StoredMemoryRow>,
    afterRevise?: (tx: Prisma.TransactionClient, changed: StoredMemoryRow) => Promise<void>,
  ) {
    return withTransactionRetry(async () => {
      const result = await this.prisma.$transaction(async (tx) => {
        const row = await this.find(actor, id, tx);
        if (row.revision !== expected) throw new MemoryConflictError();
        const changed = await operation(tx, row);
        await this.revise(tx, changed, actor.userId);
        await afterRevise?.(tx, changed);
        return {
          document: this.document(actor, {
            ...changed,
            collection: row.collection,
            space: row.space,
          }),
          documentId: changed.id,
          revision: changed.revision,
        };
      }, serializable);
      return {
        ...result.document,
        evidence: await this.evidence(actor, result.documentId, result.revision),
      };
    });
  }

  /** Every revision of a visible memory, newest first, each with its evidence verified now. */
  async history(actor: Actor, id: string) {
    const row = await this.find(actor, id);
    const revisions = await this.prisma.memoryRevision.findMany({
      where: { documentId: row.id },
      orderBy: { revision: "desc" },
    });
    return Promise.all(
      revisions.map(async (revision) => ({
        ...this.summary(actor, row),
        content: revision.content,
        title: revision.title,
        revision: revision.revision,
        status: revision.status as MemoryStatus,
        qualification: qualification(revision.qualification),
        validFrom: revision.validFrom?.toISOString() ?? null,
        validUntil: revision.validUntil?.toISOString() ?? null,
        accessVersion: revision.accessVersion,
        actorUserId: revision.actorUserId,
        createdAt: revision.createdAt.toISOString(),
        evidence: await this.evidence(actor, row.id, revision.revision),
        sources: sources(revision),
        publications: [],
      })),
    );
  }

  async validateEntityRefs(
    tx: Prisma.TransactionClient,
    actor: Actor,
    collectionId: string,
    value?: Qualification,
  ) {
    for (const ref of value?.entityRefs ?? []) {
      const target = await this.find(actor, ref.documentId, tx);
      if (target.collectionId !== collectionId) throw new MemoryAccessError();
    }
  }

  /** Qualification without links to documents the actor cannot see in the same collection. */
  async qualification(actor: Actor, row: MemoryRow): Promise<Qualification> {
    const value = qualification(row.qualification);
    const visible = async (documentId: string) =>
      (await this.findOrNull(actor, documentId))?.collectionId === row.collectionId;
    const entityRefs = await Promise.all(
      (value.entityRefs ?? []).map(async (ref) => ((await visible(ref.documentId)) ? ref : null)),
    );
    const relations = await Promise.all(
      (value.relations ?? []).map(async (relation) =>
        (await visible(relation.documentId)) ? relation : null,
      ),
    );
    return {
      ...value,
      entityRefs: entityRefs.filter(
        (ref): ref is NonNullable<Qualification["entityRefs"]>[number] => ref !== null,
      ),
      relations: relations.filter(
        (relation): relation is NonNullable<Qualification["relations"]>[number] =>
          relation !== null,
      ),
    };
  }

  /** A revision's evidence, verified now: a source that changed or is out of reach is "missing". */
  async evidence(actor: Actor, documentId: string, revision: number) {
    const evidence = await this.prisma.memoryEvidence.findMany({
      where: { documentId, revision },
      orderBy: { createdAt: "asc" },
    });
    if (evidence.length === 0) return [];
    const messageIds = evidence
      .filter((item) => item.sourceKind === "message")
      .map((item) => item.sourceReferenceId);
    const messages = await findSourceMessages(this.prisma, messageIds, actor);
    const byId = new Map(messages.map((message) => [message.id, message]));
    return Promise.all(
      evidence.map(async (item) => {
        const message = byId.get(item.sourceReferenceId);
        const accessible =
          item.sourceKind === "message"
            ? quotesMessage(item, message)
            : item.sourceKind === "document" && (await this.isCurrentDocumentEvidence(actor, item));
        return {
          sourceKind: item.sourceKind,
          sourceRole:
            accessible && message
              ? message.role === "user"
                ? ("user" as const)
                : ("assistant" as const)
              : null,
          sourceReferenceId: accessible ? item.sourceReferenceId : null,
          sourceVersion: accessible ? item.sourceVersion : null,
          status: accessible ? ("verified" as const) : ("missing" as const),
          startOffset: accessible ? item.startOffset : null,
          endOffset: accessible ? item.endOffset : null,
          excerpt: accessible ? item.excerpt : null,
        };
      }),
    );
  }

  private async isCurrentDocumentEvidence(
    actor: Actor,
    proof: Parameters<typeof checkDocumentProof>[1],
  ) {
    const source = await this.findOrNull(actor, proof.sourceReferenceId);
    if (!source) return false;
    const revision = await checkDocumentProof(this.prisma, proof, source);
    return revision !== null && isMemoryRecallEligible(this.prisma, actor, { ...source, revision });
  }
}
