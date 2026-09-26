import { createHash, randomUUID } from "node:crypto";
import type {
  Actor,
  BotMemoryClassificationResult,
  MemoryCollectionKind,
  MemoryMethodAnnotation,
  MemoryMethodSnapshot,
  MemoryQualification,
  MemoryStatus,
} from "@rakazo/contracts";
import {
  BotMemoryClassificationResultSchema,
  MemoryMethodSnapshotSchema,
  MemoryQualificationSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, withTransactionRetry } from "@rakazo/db";
import type { MemoryBotClassificationExample, MemoryBotClassifier } from "./bot-classification.js";
import {
  classifyMemoryWithBot,
  prepareMemoryBotClassificationExamples,
  shortlistBotMemoryNeighbors,
} from "./bot-classification.js";
import { parseOkfDocument, serializeOkfDocument } from "./okf.js";

export class MemoryConflictError extends Error {
  constructor(message = "Memory changed; reload before saving") {
    super(message);
    this.name = "MemoryConflictError";
  }
}
export class MemoryAccessError extends Error {
  constructor() {
    super("Memory not found");
    this.name = "MemoryAccessError";
  }
}

export type LibraryInput = {
  collection?: MemoryCollectionKind;
  botId?: string;
  query?: string;
  status?: MemoryStatus;
  cursor?: string;
  limit?: number;
};
type Qualification = MemoryQualification;
type SourceKind = "message" | "thread" | "run" | "document" | "inherited";
type MemoryRow = Prisma.MemoryDocumentGetPayload<{
  include: { collection: true; space: { select: { memberships: { select: { role: true } } } } };
}>;
type StoredMemoryRow = Prisma.MemoryDocumentGetPayload<Record<string, never>>;
type StoredBotClassificationExample = MemoryBotClassificationExample & {
  feedbackId: string;
  documentId: string;
  reviewerId: string;
  sourceRevision: number;
  neighborRefs: Array<{ id: string; revision: number; content: string }>;
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStoredBotClassificationExample(value: unknown): value is StoredBotClassificationExample {
  if (!isRecord(value)) return false;
  return (
    typeof value.feedbackId === "string" &&
    typeof value.documentId === "string" &&
    typeof value.reviewerId === "string" &&
    Number.isSafeInteger(value.sourceRevision) &&
    typeof value.content === "string" &&
    Array.isArray(value.reviewedQuestionKeys) &&
    value.reviewedQuestionKeys.every((key) => typeof key === "string") &&
    isRecord(value.answers) &&
    Object.values(value.answers).every((answer) => answer === null || typeof answer === "string") &&
    Array.isArray(value.neighbors) &&
    value.neighbors.every(
      (neighbor) => isRecord(neighbor) && typeof neighbor.content === "string",
    ) &&
    Array.isArray(value.neighborRefs) &&
    value.neighborRefs.every(
      (neighbor) =>
        isRecord(neighbor) &&
        typeof neighbor.id === "string" &&
        Number.isSafeInteger(neighbor.revision) &&
        typeof neighbor.content === "string",
    )
  );
}
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

const qualification = (value: unknown): Qualification => {
  if (!value || typeof value !== "object") return { subjects: [] };
  const parsed = MemoryQualificationSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const record = value as Record<string, unknown>;
  const objectiveRecord =
    record.objective && typeof record.objective === "object"
      ? (record.objective as Record<string, unknown>)
      : undefined;
  const objective =
    typeof objectiveRecord?.label === "string"
      ? {
          label: objectiveRecord.label,
          ...(typeof objectiveRecord.keyResult === "string"
            ? { keyResult: objectiveRecord.keyResult }
            : {}),
        }
      : undefined;
  return {
    kind: typeof record.kind === "string" ? (record.kind as Qualification["kind"]) : undefined,
    subjects: Array.isArray(record.subjects)
      ? record.subjects.filter((x): x is string => typeof x === "string")
      : [],
    impact: record.impact === "important" || record.impact === "normal" ? record.impact : undefined,
    objective,
    profileVersion: record.profileVersion === "okf-tolaria/0.1" ? record.profileVersion : undefined,
    documentType: typeof record.documentType === "string" ? record.documentType : undefined,
    nature:
      record.nature === "decision" ||
      record.nature === "preference" ||
      record.nature === "observation" ||
      record.nature === "procedure" ||
      record.nature === "hypothesis"
        ? record.nature
        : undefined,
    entityRefs: Array.isArray(record.entityRefs)
      ? record.entityRefs.filter(
          (ref): ref is NonNullable<Qualification["entityRefs"]>[number] =>
            typeof ref === "object" &&
            ref !== null &&
            (ref.kind === "project" ||
              ref.kind === "responsibility" ||
              ref.kind === "topic" ||
              ref.kind === "person") &&
            typeof ref.documentId === "string",
        )
      : undefined,
    relations: Array.isArray(record.relations)
      ? record.relations.filter(
          (relation): relation is NonNullable<Qualification["relations"]>[number] =>
            typeof relation === "object" &&
            relation !== null &&
            typeof relation.documentId === "string" &&
            [
              "duplicate",
              "complement",
              "contradiction",
              "possible_replacement",
              "related",
            ].includes(String(relation.relation)),
        )
      : undefined,
    unknownMetadata:
      typeof record.unknownMetadata === "object" &&
      record.unknownMetadata !== null &&
      !Array.isArray(record.unknownMetadata)
        ? (record.unknownMetadata as Record<string, unknown>)
        : undefined,
  };
};

function titleFor(content: string, supplied?: string) {
  if (supplied?.trim()) return supplied.trim();
  return (
    content
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean)
      ?.slice(0, 240) || "Untitled memory"
  );
}
function validatedDates(validFrom?: string | null, validUntil?: string | null) {
  if (validFrom && validUntil && new Date(validFrom) > new Date(validUntil))
    throw new MemoryConflictError("Validity start must be before its end");
}
function fingerprint(value: unknown) {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function contentFingerprint(content: string) {
  return fingerprint({ content });
}
function relevanceScore(left: string, right: string) {
  const tokens = (value: string) =>
    new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.sqrt(a.size * b.size);
}
function storedQualification(value?: Qualification): Prisma.InputJsonValue {
  const normalize = (input: unknown, depth = 0): Prisma.InputJsonValue | null => {
    if (depth > 16) throw new MemoryConflictError("Imported metadata is too deeply nested");
    if (input === null) return null;
    if (typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map((item) => normalize(item, depth + 1));
    if (
      typeof input === "object" &&
      input !== null &&
      Object.getPrototypeOf(input) === Object.prototype
    )
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [key, normalize(item, depth + 1)]),
      );
    throw new MemoryConflictError("Imported metadata must contain JSON values");
  };
  const normalized = normalize(value ?? { subjects: [] });
  if (normalized === null) throw new MemoryConflictError("Qualification must be a JSON object");
  return normalized;
}
function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
function isRetryableCommandConflict(error: unknown): boolean {
  if (isUniqueViolation(error)) return true;
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const candidate = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  return (
    candidate.code === "P2034" ||
    candidate.meta?.driverAdapterError?.cause?.originalCode === "40001"
  );
}
export async function withMemoryCommandRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 4 || !isRetryableCommandConflict(error)) throw error;
    }
  }
}

type MemoryDependencyReader = Pick<
  Prisma.TransactionClient,
  "memoryEvidence" | "memoryDocument" | "memoryRevision"
>;

/** Reject derived memories when any source in their bounded dependency chain is stale or inaccessible. */
export async function isMemoryRecallEligible(
  prisma: MemoryDependencyReader,
  input: { spaceId: string; userId: string },
  document: { id: string; revision: number; collectionId: string },
) {
  return verifyDocumentDependencies(
    prisma,
    input,
    document.id,
    document.revision,
    document.collectionId,
    new Set(),
    { count: 0 },
    0,
  );
}

async function verifyDocumentDependencies(
  prisma: MemoryDependencyReader,
  actor: { spaceId: string; userId: string },
  documentId: string,
  revision: number,
  collectionId: string,
  visited: Set<string>,
  budget: { count: number },
  depth: number,
): Promise<boolean> {
  const key = `${documentId}:${revision}`;
  if (depth > 10 || budget.count >= 64 || visited.has(key)) return false;
  const nextVisited = new Set(visited).add(key);
  budget.count += 1;
  const allProofs = await prisma.memoryEvidence.findMany({
    where: { documentId, sourceKind: "document" },
    orderBy: { createdAt: "asc" },
  });
  const proofs = allProofs.filter((proof) => proof.revision === revision);
  if (!proofs.length) return allProofs.length === 0;
  if (proofs.length < 2 || proofs.length > 8) return false;
  const now = new Date();
  for (const proof of proofs) {
    const source = await prisma.memoryDocument.findFirst({
      where: {
        id: proof.sourceReferenceId,
        spaceId: actor.spaceId,
        space: { memberships: { some: { userId: actor.userId } } },
        collection: { OR: [{ kind: "space" }, { ownerUserId: actor.userId }] },
      },
      select: {
        id: true,
        collectionId: true,
        revision: true,
        status: true,
        content: true,
        validFrom: true,
        validUntil: true,
      },
    });
    if (!source || source.collectionId !== collectionId) return false;
    const sourceRevision = Number(proof.sourceVersion);
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1) return false;
    const inValidity =
      (!source.validFrom || source.validFrom <= now) &&
      (!source.validUntil || source.validUntil >= now);
    let dependencyRevision: number;
    if (source.status === "active" && source.revision === sourceRevision && inValidity) {
      if (
        proof.sourceDigest !==
        fingerprint({ id: source.id, revision: source.revision, content: source.content })
      )
        return false;
      dependencyRevision = source.revision;
    } else {
      if (
        proof.sourceRole !== "replacement" ||
        source.status !== "superseded" ||
        source.revision !== sourceRevision + 1 ||
        !inValidity
      )
        return false;
      const original = await prisma.memoryRevision.findUnique({
        where: { documentId_revision: { documentId: source.id, revision: sourceRevision } },
        select: { content: true },
      });
      if (
        !original ||
        proof.sourceDigest !==
          fingerprint({ id: source.id, revision: sourceRevision, content: original.content })
      )
        return false;
      dependencyRevision = sourceRevision;
    }
    if (
      !(await verifyDocumentDependencies(
        prisma,
        actor,
        source.id,
        dependencyRevision,
        source.collectionId,
        nextVisited,
        budget,
        depth + 1,
      ))
    )
      return false;
  }
  return true;
}

/** Authorization and transitions for product memory. The legacy store delegates its human paths here. */
export class MarkdownMemoryLibrary {
  constructor(private readonly prisma: PrismaClient) {}

  async list(actor: Actor, input: LibraryInput) {
    const facetWhere = await this.visibleWhere(actor, { ...input, status: undefined });
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
      include: {
        collection: true,
        space: {
          select: { memberships: { where: { userId: actor.userId }, select: { role: true } } },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: Math.min(input.limit ?? 30, 100) + 1,
    });
    const items = rows.slice(0, input.limit ?? 30).map((row) => this.summary(actor, row));
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
    const row = await this.findVisible(actor, id);
    const publications = await this.prisma.memoryDocument.findMany({
      where: {
        sourceDocumentId: row.id,
        spaceId: actor.spaceId,
        space: { memberships: { some: { userId: actor.userId } } },
        collection: { OR: [{ kind: "space" }, { ownerUserId: actor.userId }] },
      },
      include: {
        collection: true,
        space: {
          select: { memberships: { where: { userId: actor.userId }, select: { role: true } } },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    });
    return {
      ...this.document(actor, row),
      evidence: await this.visibleEvidence(actor, row.id, row.revision),
      publications: publications.map((publication) => ({
        id: publication.id,
        title: publication.title,
        revision: publication.revision,
        canWithdraw: this.canEdit(actor, publication),
      })),
    };
  }
  async classifyByBot(
    actor: Actor,
    input: {
      botId: string;
      botName: string;
      method: MemoryMethodSnapshot;
      documentId: string;
      expectedRevision: number;
    },
    classifier?: MemoryBotClassifier,
  ) {
    const candidateRow = await this.findVisible(actor, input.documentId);
    if (candidateRow.revision !== input.expectedRevision) throw new MemoryConflictError();
    const authorizedMethod = await this.currentBotMethod(
      this.prisma,
      actor,
      candidateRow,
      input.botId,
      input.method.id,
      input.method.version,
    );
    if (!authorizedMethod || fingerprint(authorizedMethod.method) !== fingerprint(input.method))
      throw new MemoryAccessError();
    if (
      candidateRow.status === "withdrawn" ||
      candidateRow.status === "superseded" ||
      (candidateRow.validFrom !== null && candidateRow.validFrom > new Date()) ||
      (candidateRow.validUntil !== null && candidateRow.validUntil < new Date()) ||
      !(await isMemoryRecallEligible(this.prisma, actor, candidateRow))
    )
      throw new MemoryConflictError("Only current memories can be classified");

    const candidate = {
      id: candidateRow.id,
      revision: candidateRow.revision,
      content: candidateRow.content,
      qualification: await this.visibleQualification(actor, candidateRow),
    };
    const rows = await this.prisma.memoryDocument.findMany({
      where: {
        collectionId: candidateRow.collectionId,
        status: "active",
        ...(await this.visibleWhere(actor, {})),
      },
      include: {
        collection: true,
        space: {
          select: { memberships: { where: { userId: actor.userId }, select: { role: true } } },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: 200,
    });
    const now = new Date();
    const authorized = await Promise.all(
      rows.map(async (row) => {
        if ((row.validFrom && row.validFrom > now) || (row.validUntil && row.validUntil < now))
          return null;
        if (!(await isMemoryRecallEligible(this.prisma, actor, row))) return null;
        return {
          id: row.id,
          revision: row.revision,
          content: row.content,
          qualification: await this.visibleQualification(actor, row),
        };
      }),
    );
    const neighbors = shortlistBotMemoryNeighbors(
      candidate,
      authorized.filter((row): row is NonNullable<typeof row> => row !== null),
    );
    const method = {
      id: input.method.id,
      version: input.method.version,
      instructions: input.method.instructions,
      prepared: input.method.prepared,
    };
    const examplePool = await this.botClassificationExamples(
      actor,
      candidateRow,
      input.botId,
      input.method,
      candidate.content,
    );
    const examples: MemoryBotClassificationExample[] = examplePool.map((example) => ({
      content: example.content,
      reviewedQuestionKeys: example.reviewedQuestionKeys,
      answers: example.answers,
      neighbors: example.neighbors,
    }));
    const selected = prepareMemoryBotClassificationExamples(
      examples,
      input.method.prepared.questions,
    );
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
      { method, candidate, neighbors, examples },
      classifier,
    );
    const classificationId = await withTransactionRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const current = await this.findVisibleTx(tx, actor, input.documentId);
          if (
            current.revision !== input.expectedRevision ||
            current.accessVersion !== candidateRow.accessVersion ||
            current.collectionId !== candidateRow.collectionId ||
            current.status === "withdrawn" ||
            current.status === "superseded" ||
            contentFingerprint(current.content) !== contentFingerprint(candidate.content) ||
            (current.validFrom !== null && current.validFrom > new Date()) ||
            (current.validUntil !== null && current.validUntil < new Date()) ||
            !(await isMemoryRecallEligible(tx, actor, current))
          )
            throw new MemoryConflictError();
          const currentMethod = await this.currentBotMethod(
            tx,
            actor,
            current,
            input.botId,
            input.method.id,
            input.method.version,
          );
          if (!currentMethod || fingerprint(currentMethod.method) !== fingerprint(input.method))
            throw new MemoryConflictError("This bot method changed; classify the memory again");
          await this.validateBotClassificationExamplesTx(
            tx,
            actor,
            candidateRow,
            input.botId,
            input.method,
            storedExamples,
          );
          for (const neighbor of neighbors) {
            const fresh = await this.findVisibleTx(tx, actor, neighbor.id);
            if (
              fresh.collectionId !== candidateRow.collectionId ||
              fresh.status !== "active" ||
              fresh.revision !== neighbor.revision ||
              contentFingerprint(fresh.content) !== contentFingerprint(neighbor.content) ||
              (fresh.validFrom !== null && fresh.validFrom > new Date()) ||
              (fresh.validUntil !== null && fresh.validUntil < new Date()) ||
              !(await isMemoryRecallEligible(tx, actor, fresh))
            )
              throw new MemoryConflictError();
          }
          const run = await tx.memoryClassificationRun.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: input.botId,
              methodId: input.method.id,
              methodVersion: input.method.version,
              methodSnapshot: {
                bot: { id: input.botId, name: currentMethod.bot.name },
                method: currentMethod.method,
              } as unknown as Prisma.InputJsonValue,
              documentId: input.documentId,
              collectionId: candidateRow.collectionId,
              revision: input.expectedRevision,
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
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
    return {
      candidate,
      neighbors,
      bot: { id: input.botId, name: authorizedMethod.bot.name },
      method: input.method,
      suggestion,
      classificationId,
    };
  }

  /** Read an existing bot classification only while its memory, method and provenance remain valid. */
  async getBotClassificationRun(
    actor: Actor,
    input: { classificationId: string; documentId: string },
  ): Promise<BotMemoryClassificationResult | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const run = await tx.memoryClassificationRun.findFirst({
          where: {
            id: input.classificationId,
            documentId: input.documentId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            methodId: { not: null },
          },
        });
        if (!run?.methodId || !run.methodVersion || !run.botId || !isRecord(run.methodSnapshot))
          throw new MemoryAccessError();
        const envelope = run.methodSnapshot;
        const parsedMethod = MemoryMethodSnapshotSchema.safeParse(envelope.method);
        if (
          !parsedMethod.success ||
          !isRecord(envelope.bot) ||
          envelope.bot.id !== run.botId ||
          typeof envelope.bot.name !== "string"
        )
          throw new MemoryConflictError("This classification run is no longer available");
        const method = parsedMethod.data;
        if (
          method.id !== run.methodId ||
          method.version !== run.methodVersion ||
          method.botId !== run.botId
        )
          throw new MemoryConflictError("This classification run is no longer available");

        const row = await this.findVisibleTx(tx, actor, run.documentId);
        if (
          row.revision !== run.revision ||
          row.accessVersion !== run.accessVersion ||
          row.collectionId !== run.collectionId ||
          row.status !== "active" ||
          (row.validFrom !== null && row.validFrom > new Date()) ||
          (row.validUntil !== null && row.validUntil < new Date()) ||
          !(await isMemoryRecallEligible(tx, actor, row))
        )
          throw new MemoryConflictError("The classified memory changed; classify it again");

        const candidate = isRecord(run.candidate) ? run.candidate : null;
        if (
          !candidate ||
          candidate.id !== row.id ||
          candidate.revision !== row.revision ||
          typeof candidate.content !== "string" ||
          contentFingerprint(candidate.content) !== contentFingerprint(row.content) ||
          contentFingerprint(candidate.content) !== run.sourceDigest
        )
          throw new MemoryConflictError("The classified memory changed; classify it again");
        const candidateQualification = MemoryQualificationSchema.safeParse(candidate.qualification);
        const currentQualification = await this.visibleQualification(actor, row);
        if (
          !candidateQualification.success ||
          fingerprint(candidateQualification.data) !== fingerprint(currentQualification)
        )
          throw new MemoryConflictError("The classified memory changed; classify it again");

        const currentMethod = await this.currentBotMethod(
          tx,
          actor,
          row,
          run.botId,
          run.methodId,
          run.methodVersion,
        );
        if (!currentMethod || fingerprint(currentMethod.method) !== fingerprint(method))
          throw new MemoryAccessError();

        if (!Array.isArray(run.neighbors) || run.neighbors.length > 8)
          throw new MemoryConflictError("This classification run is no longer available");
        const neighbors: BotMemoryClassificationResult["neighbors"] = [];
        for (const snapshot of run.neighbors) {
          if (
            !isRecord(snapshot) ||
            typeof snapshot.id !== "string" ||
            !Number.isSafeInteger(snapshot.revision) ||
            typeof snapshot.content !== "string"
          )
            throw new MemoryConflictError("This classification run is no longer available");
          const current = await this.findVisibleTx(tx, actor, snapshot.id).catch(() => null);
          if (
            !current ||
            current.collectionId !== row.collectionId ||
            current.status !== "active" ||
            current.revision !== snapshot.revision ||
            contentFingerprint(current.content) !== contentFingerprint(snapshot.content) ||
            (current.validFrom !== null && current.validFrom > new Date()) ||
            (current.validUntil !== null && current.validUntil < new Date()) ||
            !(await isMemoryRecallEligible(tx, actor, current))
          )
            throw new MemoryConflictError("A classified neighbor changed; classify again");
          const qualification = MemoryQualificationSchema.safeParse(snapshot.qualification);
          const visible = await this.visibleQualification(actor, current);
          if (!qualification.success || fingerprint(qualification.data) !== fingerprint(visible))
            throw new MemoryConflictError("A classified neighbor changed; classify again");
          neighbors.push({
            id: current.id,
            revision: current.revision,
            content: current.content,
            qualification: visible,
          });
        }

        if (
          !Array.isArray(run.examples) ||
          run.examples.length > 4 ||
          !run.examples.every(isStoredBotClassificationExample)
        )
          throw new MemoryConflictError("This classification run is no longer available");
        await this.validateBotClassificationExamplesTx(
          tx,
          actor,
          row,
          run.botId,
          { id: run.methodId, version: run.methodVersion },
          run.examples,
        );

        const priorFeedback = await tx.memoryClassificationFeedback.findUnique({
          where: { runId: run.id },
          select: { id: true },
        });
        if (priorFeedback) return null;

        const suggestion = run.prediction;
        if (!isRecord(suggestion) || !isRecord(suggestion.answers))
          throw new MemoryConflictError("This classification run is no longer available");
        const answers = suggestion.answers;
        const questions = method.prepared.questions;
        if (
          Object.keys(answers).length !== questions.length ||
          questions.some((question) => {
            const answer = answers[question.key];
            return !(
              answer === null ||
              (typeof answer === "string" &&
                question.options.some((option) => option.key === answer))
            );
          })
        )
          throw new MemoryConflictError("This classification run is no longer available");

        const result = BotMemoryClassificationResultSchema.safeParse({
          candidate: {
            id: row.id,
            revision: row.revision,
            content: row.content,
            qualification: currentQualification,
          },
          neighbors,
          bot: { id: run.botId, name: envelope.bot.name },
          method,
          suggestion,
          classificationId: run.id,
        });
        if (!result.success)
          throw new MemoryConflictError("This classification run is no longer available");
        return result.data;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /** Save a human judgment as an immutable annotation, independent of document qualification. */
  async reviewBotClassification(
    actor: Actor,
    input: {
      classificationId: string;
      expectedRevision: number;
      reviewedQuestionKeys: string[];
      answers: Record<string, string | null>;
      shareWithTeam?: boolean;
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
      shareWithTeam: input.shareWithTeam ?? false,
    });
    return withTransactionRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const run = await tx.memoryClassificationRun.findFirst({
            where: {
              id: input.classificationId,
              spaceId: actor.spaceId,
              userId: actor.userId,
              methodId: { not: null },
            },
          });
          if (!run?.methodSnapshot || !run.methodId || !run.botId || !run.methodVersion)
            throw new MemoryAccessError();
          const prior = await tx.memoryClassificationFeedback.findUnique({
            where: { runId: run.id },
          });
          const row = await this.findVisibleTx(tx, actor, run.documentId);
          if (prior) {
            if (prior.payloadFingerprint !== payloadFingerprint) throw new MemoryConflictError();
            return { feedbackId: prior.id };
          }
          if (
            row.revision !== input.expectedRevision ||
            run.revision !== input.expectedRevision ||
            row.accessVersion !== run.accessVersion ||
            row.collectionId !== run.collectionId ||
            row.status === "withdrawn" ||
            row.status === "superseded" ||
            (row.validFrom && row.validFrom > new Date()) ||
            (row.validUntil && row.validUntil < new Date()) ||
            !(await isMemoryRecallEligible(tx, actor, row)) ||
            contentFingerprint(row.content) !== run.sourceDigest
          )
            throw new MemoryConflictError("The classified memory changed; classify it again");
          const methodEnvelope = run.methodSnapshot as {
            bot: { id: string; name: string };
            method: MemoryMethodSnapshot;
          };
          const method = methodEnvelope.method;
          const methodRow = await tx.botMemoryMethod.findUnique({
            where: { id: run.methodId },
            select: { botId: true, version: true, sharing: true },
          });
          const currentMethod = await this.currentBotMethod(
            tx,
            actor,
            row,
            run.botId,
            run.methodId,
            run.methodVersion,
          );
          if (
            !methodRow ||
            methodRow.botId !== run.botId ||
            methodRow.version !== run.methodVersion ||
            !currentMethod ||
            fingerprint(currentMethod.method) !== fingerprint(method) ||
            (input.shareWithTeam &&
              (row.collection.kind !== "space" || methodRow.sharing !== "space"))
          )
            throw new MemoryAccessError();
          const questionMap = new Map(
            method.prepared.questions.map((question) => [question.key, question]),
          );
          if (
            input.reviewedQuestionKeys.some((key) => !questionMap.has(key)) ||
            input.reviewedQuestionKeys.some((key) => {
              const answer = input.answers[key];
              return (
                answer !== null &&
                !questionMap.get(key)!.options.some((option) => option.key === answer)
              );
            })
          )
            throw new MemoryAccessError();
          if (!Array.isArray(run.neighbors) || run.neighbors.length > 8)
            throw new MemoryConflictError();
          const runNeighbors = run.neighbors as Array<{
            id: string;
            revision: number;
            content: string;
          }>;
          for (const neighbor of runNeighbors) {
            const fresh = await this.findVisibleTx(tx, actor, neighbor.id).catch(() => null);
            if (
              !fresh ||
              fresh.collectionId !== row.collectionId ||
              fresh.status !== "active" ||
              fresh.revision !== neighbor.revision ||
              contentFingerprint(fresh.content) !== contentFingerprint(neighbor.content) ||
              !(await isMemoryRecallEligible(tx, actor, fresh))
            )
              throw new MemoryConflictError("A classified neighbor changed; classify again");
          }
          const examples = Array.isArray(run.examples)
            ? (run.examples as StoredBotClassificationExample[])
            : [];
          await this.validateBotClassificationExamplesTx(
            tx,
            actor,
            row,
            run.botId,
            { id: run.methodId, version: run.methodVersion },
            examples,
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
              reviewedDimensions: input.reviewedQuestionKeys as unknown as Prisma.InputJsonValue,
              reviewed: input.answers as unknown as Prisma.InputJsonValue,
              prediction: run.prediction as Prisma.InputJsonValue,
              payloadFingerprint,
              qualificationAfter: row.qualification as Prisma.InputJsonValue,
              resultRevision: row.revision,
              sharedWithTeam: input.shareWithTeam ?? false,
            },
            select: { id: true },
          });
          return { feedbackId: feedback.id };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async memoryAnnotations(actor: Actor, documentId: string): Promise<MemoryMethodAnnotation[]> {
    const row = await this.findVisible(actor, documentId);
    const feedback = await this.prisma.memoryClassificationFeedback.findMany({
      where: {
        spaceId: actor.spaceId,
        documentId,
        OR: [
          { userId: actor.userId },
          ...(row.collection.kind === "space" ? [{ sharedWithTeam: true }] : []),
        ],
      },
      include: {
        method: { include: { bot: { select: { id: true, name: true } } } },
        run: { select: { methodSnapshot: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
    return feedback.flatMap((item) => {
      if (!item.methodVersion) return [];
      const snapshot = item.run.methodSnapshot as {
        bot?: { id?: string; name?: string };
        method?: MemoryMethodSnapshot;
      } | null;
      const method = snapshot?.method;
      const bot =
        item.method?.bot ??
        (snapshot?.bot?.id && snapshot.bot.name
          ? { id: snapshot.bot.id, name: snapshot.bot.name }
          : null);
      const methodId = item.method?.id ?? method?.id;
      if (
        !method ||
        !bot ||
        !methodId ||
        !method.prepared?.questions ||
        (item.userId !== actor.userId &&
          (!item.sharedWithTeam || row.collection.kind !== "space" || method.sharing !== "space"))
      )
        return [];
      return [
        {
          id: item.id,
          bot,
          method: {
            id: methodId,
            version: item.methodVersion,
            questions: method.prepared.questions,
          },
          answers: item.reviewed as Record<string, string | null>,
          createdAt: item.createdAt.toISOString(),
          sharedWithTeam: item.sharedWithTeam,
          revokedAt: item.revokedAt?.toISOString() ?? null,
          isOwn: item.userId === actor.userId,
        },
      ];
    });
  }
  async revokeClassificationFeedback(actor: Actor, feedbackId: string) {
    await withTransactionRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const feedback = await tx.memoryClassificationFeedback.findFirst({
            where: { id: feedbackId, spaceId: actor.spaceId, userId: actor.userId },
          });
          if (!feedback) throw new MemoryAccessError();
          if (feedback.revokedAt) return;
          await tx.memoryClassificationFeedback.update({
            where: { id: feedback.id },
            data: { revokedAt: new Date(), revokedByUserId: actor.userId },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
    return { ok: true as const };
  }
  private async currentBotMethod(
    db: Prisma.TransactionClient | PrismaClient,
    actor: Actor,
    document: MemoryRow,
    botId: string,
    methodId: string,
    version: number,
  ): Promise<{ bot: { id: string; name: string }; method: MemoryMethodSnapshot } | null> {
    const bot = await db.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, archivedAt: null },
      select: {
        id: true,
        name: true,
        userId: true,
        memoryMethodDisabledAt: true,
        instructions: true,
      },
    });
    if (!bot || bot.memoryMethodDisabledAt) return null;
    const membership = await db.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
      select: { spaceId: true },
    });
    if (!membership) return null;
    const latest = await db.botMemoryMethod.findFirst({
      where: { botId },
      orderBy: { version: "desc" },
    });
    if (
      !latest ||
      latest.instructions !== bot.instructions ||
      latest.id !== methodId ||
      latest.version !== version ||
      !Array.isArray(latest.allowedCollections) ||
      !(latest.allowedCollections as string[]).includes(document.collection.kind)
    )
      return null;
    const isOwner = bot.userId === actor.userId;
    if (!isOwner && (document.collection.kind !== "space" || latest.sharing !== "space"))
      return null;
    if (document.collection.kind === "agent" && document.collection.botId !== botId) return null;
    return {
      bot: { id: bot.id, name: bot.name },
      method: {
        id: latest.id,
        botId,
        version: latest.version,
        instructions: latest.instructions,
        prepared: latest.prepared as MemoryMethodSnapshot["prepared"],
        provider: latest.provider as MemoryMethodSnapshot["provider"],
        model: latest.model,
        allowedCollections: latest.allowedCollections as MemoryMethodSnapshot["allowedCollections"],
        sharing: latest.sharing as MemoryMethodSnapshot["sharing"],
        createdAt: latest.createdAt.toISOString(),
      },
    };
  }

  private async botClassificationExamples(
    actor: Actor,
    candidateRow: MemoryRow,
    botId: string,
    method: MemoryMethodSnapshot,
    candidateContent: string,
  ): Promise<StoredBotClassificationExample[]> {
    const canUseShared = candidateRow.collection.kind === "space" && method.sharing === "space";
    const feedback = await this.prisma.memoryClassificationFeedback.findMany({
      where: {
        spaceId: actor.spaceId,
        collectionId: candidateRow.collectionId,
        documentId: { not: candidateRow.id },
        botId,
        methodId: method.id,
        methodVersion: method.version,
        ...(canUseShared
          ? { OR: [{ userId: actor.userId }, { sharedWithTeam: true }] }
          : { userId: actor.userId }),
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
        const source = await this.loadBotClassificationExample(actor, candidateRow, item.id);
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
        const validKeys = reviewedQuestionKeys.filter((key) => {
          const answer = answers[key];
          return (
            answer === null ||
            (typeof answer === "string" &&
              allowedQuestions.get(key)!.options.some((option) => option.key === answer))
          );
        });
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
      .map((item) => ({ item, score: relevanceScore(candidateContent, item.content) }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.item.feedbackId.localeCompare(right.item.feedbackId),
      )
      .slice(0, 100)
      .map(({ item }) => item);
  }

  private async loadBotClassificationExample(
    actor: Actor,
    candidateRow: MemoryRow,
    feedbackId: string,
    tx: Prisma.TransactionClient | PrismaClient = this.prisma,
  ): Promise<{
    content: string;
    revision: number;
    reviewerId: string;
    neighbors: Array<{ id: string; revision: number; content: string }>;
  } | null> {
    const feedback = await tx.memoryClassificationFeedback.findFirst({
      where: {
        id: feedbackId,
        spaceId: actor.spaceId,
        collectionId: candidateRow.collectionId,
        revokedAt: null,
        methodId: { not: null },
      },
      include: { run: true, method: true },
    });
    if (
      !feedback ||
      feedback.documentId === candidateRow.id ||
      !feedback.methodId ||
      !feedback.botId ||
      !feedback.methodVersion
    )
      return null;
    if (
      feedback.userId !== actor.userId &&
      (candidateRow.collection.kind !== "space" ||
        !feedback.sharedWithTeam ||
        feedback.method?.sharing !== "space")
    )
      return null;
    if (feedback.userId !== actor.userId) {
      const reviewerMembership = await tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: actor.spaceId, userId: feedback.userId } },
        select: { spaceId: true },
      });
      if (!reviewerMembership) return null;
    }
    const source = await this.findVisibleTx(tx, actor, feedback.documentId).catch(() => null);
    if (
      source?.status !== "active" ||
      source.revision !== feedback.resultRevision ||
      (source.validFrom && source.validFrom > new Date()) ||
      (source.validUntil && source.validUntil < new Date()) ||
      contentFingerprint(source.content) !== feedback.sourceDigest ||
      !(await isMemoryRecallEligible(tx, actor, source))
    )
      return null;
    if (!Array.isArray(feedback.run.neighbors) || feedback.run.neighbors.length > 8) return null;
    const neighbors: Array<{ id: string; revision: number; content: string }> = [];
    for (const snapshot of feedback.run.neighbors as Array<{
      id: string;
      revision: number;
      content: string;
    }>) {
      const current = await this.findVisibleTx(tx, actor, snapshot.id).catch(() => null);
      if (
        !current ||
        current.collectionId !== candidateRow.collectionId ||
        current.status !== "active" ||
        current.revision !== snapshot.revision ||
        contentFingerprint(current.content) !== contentFingerprint(snapshot.content) ||
        (current.validFrom && current.validFrom > new Date()) ||
        (current.validUntil && current.validUntil < new Date()) ||
        !(await isMemoryRecallEligible(tx, actor, current))
      )
        return null;
      neighbors.push({ id: current.id, revision: current.revision, content: current.content });
    }
    return {
      content: source.content,
      revision: source.revision,
      reviewerId: feedback.userId,
      neighbors,
    };
  }

  private async validateBotClassificationExamplesTx(
    tx: Prisma.TransactionClient,
    actor: Actor,
    candidateRow: MemoryRow,
    botId: string,
    method: Pick<MemoryMethodSnapshot, "id" | "version">,
    examples: StoredBotClassificationExample[],
  ) {
    for (const example of examples) {
      const current = await this.loadBotClassificationExample(
        actor,
        candidateRow,
        example.feedbackId,
        tx,
      );
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
        example.reviewedQuestionKeys.some(
          (key) => latestByKey.get(key)?.id !== example.feedbackId,
        ) ||
        example.reviewedQuestionKeys.some(
          (key) => (feedback.reviewed as Record<string, unknown>)[key] !== example.answers[key],
        )
      )
        throw new MemoryConflictError("A reviewed example changed; classify the memory again");
    }
  }

  async search(actor: Actor, input: LibraryInput & { query: string }) {
    return (await this.list(actor, input)).items;
  }
  async exportMarkdown(actor: Actor, input: LibraryInput) {
    const where = await this.visibleWhere(actor, { ...input, status: "active" });
    const docs = await this.prisma.memoryDocument.findMany({
      where,
      include: {
        collection: true,
        space: {
          select: { memberships: { where: { userId: actor.userId }, select: { role: true } } },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    });
    return docs.map((doc) => `# ${this.summary(actor, doc).title}\n\n${doc.content}`).join("\n\n");
  }

  async exportOkf(actor: Actor, documentId: string, expectedRevision: number) {
    const row = await this.findVisible(actor, documentId);
    if (row.revision !== expectedRevision) throw new MemoryConflictError();
    const value = await this.visibleQualification(actor, row);
    const legacy = {
      ...(value.objective ? { objective: value.objective } : {}),
      ...(value.subjects.length ? { subjects: value.subjects } : {}),
      ...(value.impact ? { impact: value.impact } : {}),
    };
    const markdown = serializeOkfDocument({
      profileVersion: "okf-tolaria/0.1",
      documentType: value.documentType ?? "Memory",
      ...(value.nature ? { nature: value.nature } : {}),
      ...(value.entityRefs ? { entityRefs: value.entityRefs } : {}),
      ...(value.relations ? { relations: value.relations } : {}),
      content: row.content,
      ...(value.unknownMetadata || Object.keys(legacy).length
        ? {
            unknownMetadata: {
              ...(value.unknownMetadata ?? {}),
              ...(Object.keys(legacy).length ? { legacyRakazo: legacy } : {}),
            },
          }
        : {}),
    });
    const current = await this.findVisible(actor, documentId);
    if (current.revision !== expectedRevision || current.collectionId !== row.collectionId)
      throw new MemoryConflictError();
    return markdown;
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
    const parsed = parseOkfDocument(input.content);
    if (parsed.documentType.length > 120) throw new MemoryConflictError("OKF type is too long");
    return this.create(actor, {
      collection: input.collection,
      botId: input.botId,
      title: titleFor(parsed.content),
      content: parsed.content,
      qualification: {
        subjects: [],
        profileVersion: parsed.profileVersion,
        documentType: parsed.documentType,
        nature: parsed.nature,
        unknownMetadata: {
          ...(parsed.unknownMetadata ?? {}),
          ...(parsed.entityRefs ? { unresolvedEntityRefs: parsed.entityRefs } : {}),
          ...(parsed.relations ? { unresolvedRelations: parsed.relations } : {}),
        },
      },
      idempotencyKey: input.idempotencyKey,
      active: false,
    });
  }

  async create(actor: Actor, input: CreateInput) {
    return withMemoryCommandRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          validatedDates(input.validFrom, input.validUntil);
          const commandFingerprint = fingerprint({
            command: "create",
            collection: input.collection,
            botId: input.botId ?? null,
            title: titleFor(input.content, input.title),
            content: input.content,
            qualification: storedQualification(input.qualification),
            validFrom: input.validFrom ?? null,
            validUntil: input.validUntil ?? null,
            source: input.source ?? null,
            active: input.active === true,
          });
          if (input.idempotencyKey) {
            const command = await tx.memoryCommand.findUnique({
              where: {
                spaceId_userId_key: {
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                  key: input.idempotencyKey,
                },
              },
            });
            if (command) {
              if (command.fingerprint !== commandFingerprint || !command.documentId)
                throw new MemoryConflictError();
              const prior = await this.findVisibleTx(tx, actor, command.documentId);
              return this.document(actor, prior);
            }
            await tx.memoryCommand.create({
              data: {
                spaceId: actor.spaceId,
                userId: actor.userId,
                key: input.idempotencyKey,
                fingerprint: commandFingerprint,
              },
            });
          }
          const collection = await this.collection(tx, actor, input.collection, input.botId);
          if (input.collection === "agent" && collection.ownerUserId !== actor.userId)
            throw new MemoryAccessError();
          if (input.sourceCheck) {
            const source = await tx.message.findFirst({
              where: {
                id: input.sourceCheck.messageId,
                role: { in: ["user", "bot", "assistant"] },
                thread: { spaceId: actor.spaceId, userId: actor.userId },
              },
              select: { blocks: true },
            });
            if (!source || fingerprint(source.blocks) !== input.sourceCheck.digest)
              throw new MemoryAccessError();
          }
          await this.validateEntityRefs(tx, actor, collection.id, input.qualification);
          const row = await tx.memoryDocument.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              collectionId: collection.id,
              botId: input.collection === "agent" ? input.botId : null,
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
          await this.revise(tx, row, actor.userId, input.idempotencyKey, commandFingerprint);
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
          if (input.idempotencyKey)
            await tx.memoryCommand.update({
              where: {
                spaceId_userId_key: {
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                  key: input.idempotencyKey,
                },
              },
              data: { documentId: row.id },
            });
          return this.document(actor, {
            ...row,
            collection,
            space: { memberships: [] },
          } as MemoryRow);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async proposeConsolidation(
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
    const proposed = await withMemoryCommandRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const commandFingerprint = fingerprint({
            command: "consolidate",
            sources: input.sources,
            title: titleFor(input.content, input.title),
            content: input.content,
          });
          if (input.idempotencyKey) {
            const command = await tx.memoryCommand.findUnique({
              where: {
                spaceId_userId_key: {
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                  key: input.idempotencyKey,
                },
              },
            });
            if (command) {
              if (command.fingerprint !== commandFingerprint || !command.documentId)
                throw new MemoryConflictError();
              return this.document(actor, await this.findVisibleTx(tx, actor, command.documentId));
            }
            await tx.memoryCommand.create({
              data: {
                spaceId: actor.spaceId,
                userId: actor.userId,
                key: input.idempotencyKey,
                fingerprint: commandFingerprint,
              },
            });
          }
          const sources = [];
          for (const reference of input.sources) {
            const source = await this.findVisibleTx(tx, actor, reference.documentId);
            if (source.revision !== reference.revision || source.status !== "active")
              throw new MemoryConflictError();
            sources.push(source);
          }
          const collectionId = sources[0]!.collectionId;
          if (sources.some((source) => source.collectionId !== collectionId))
            throw new MemoryAccessError();
          for (const source of sources) {
            if (!(await isMemoryRecallEligible(tx, actor, source)))
              throw new MemoryConflictError(
                "A consolidation source depends on stale or inaccessible evidence",
              );
          }
          const first = sources[0]!;
          const row = await tx.memoryDocument.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              collectionId,
              botId: first.botId,
              scope: first.scope,
              path: `memory/${randomUUID()}.md`,
              title: titleFor(input.content, input.title),
              content: input.content,
              status: "proposed",
              qualification: { subjects: [] },
            },
          });
          await this.revise(tx, row, actor.userId, input.idempotencyKey, commandFingerprint);
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
          if (input.idempotencyKey)
            await tx.memoryCommand.update({
              where: {
                spaceId_userId_key: {
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                  key: input.idempotencyKey,
                },
              },
              data: { documentId: row.id },
            });
          return this.document(actor, await this.findVisibleTx(tx, actor, row.id));
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
    return this.get(actor, proposed.id);
  }

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
    const message = await this.prisma.message.findFirst({
      where: {
        id: input.messageId,
        role: { in: ["user", "bot", "assistant"] },
        thread: { spaceId: actor.spaceId, userId: actor.userId },
      },
      select: { id: true, blocks: true, role: true },
    });
    if (!message) throw new MemoryAccessError();
    const sourceText = Array.isArray(message.blocks)
      ? message.blocks
          .flatMap((block) =>
            typeof block === "object" &&
            block !== null &&
            "kind" in block &&
            block.kind === "text" &&
            "text" in block &&
            typeof block.text === "string"
              ? [block.text]
              : [],
          )
          .join("\n")
      : "";
    const content = input.content ?? sourceText;
    if (!content) throw new MemoryConflictError("The message has no retainable text");
    const digest = fingerprint(message.blocks);
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
    return this.mutate(
      actor,
      input.documentId,
      input.expectedRevision,
      async (tx, row) => {
        if (!this.canEdit(actor, row)) throw new MemoryAccessError();
        if (input.qualification)
          await this.validateEntityRefs(tx, actor, row.collectionId, input.qualification);
        const validFrom =
          input.validFrom === undefined
            ? row.validFrom
            : input.validFrom
              ? new Date(input.validFrom)
              : null;
        const validUntil =
          input.validUntil === undefined
            ? row.validUntil
            : input.validUntil
              ? new Date(input.validUntil)
              : null;
        validatedDates(validFrom?.toISOString(), validUntil?.toISOString());
        if (input.replaceDocumentId) {
          if (input.replaceDocumentId === row.id || !input.replacedExpectedRevision)
            throw new MemoryConflictError();
          const replaced = await this.findVisibleTx(tx, actor, input.replaceDocumentId);
          if (!this.canEdit(actor, replaced)) throw new MemoryAccessError();
          if (replaced.revision !== input.replacedExpectedRevision) throw new MemoryConflictError();
          const superseded = await tx.memoryDocument.update({
            where: { id: replaced.id },
            data: {
              status: "superseded",
              revision: { increment: 1 },
              accessVersion: { increment: 1 },
            },
          });
          await this.revise(tx, superseded, actor.userId);
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
          await this.copyCurrentDocumentEvidence(tx, actor, input.expectedRevision, changed);
      },
    );
  }
  async accept(actor: Actor, id: string, expected: number) {
    return this.acceptConsolidation(actor, id, expected, false);
  }
  async acceptConsolidation(actor: Actor, id: string, expected: number, replaceSources: boolean) {
    let evidenceToCopy: Prisma.MemoryEvidenceGetPayload<Record<string, never>>[] = [];
    return this.mutate(
      actor,
      id,
      expected,
      async (tx, row) => {
        if (!this.canEdit(actor, row) || row.status !== "proposed") throw new MemoryAccessError();
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
            const source = await this.findVisibleTx(tx, actor, proof.sourceReferenceId);
            if (
              source.status !== "active" ||
              source.revision !== Number(proof.sourceVersion) ||
              proof.sourceDigest !==
                fingerprint({
                  id: source.id,
                  revision: source.revision,
                  content: source.content,
                }) ||
              source.collectionId !== row.collectionId
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
              if (!this.canEdit(actor, source)) throw new MemoryAccessError();
              const superseded = await tx.memoryDocument.update({
                where: { id: source.id },
                data: {
                  status: "superseded",
                  revision: { increment: 1 },
                  accessVersion: { increment: 1 },
                },
              });
              await this.revise(tx, superseded, actor.userId);
            }
          }
        }
        const activated = await tx.memoryDocument.update({
          where: { id: row.id },
          data: { status: "active", revision: { increment: 1 }, accessVersion: { increment: 1 } },
        });
        return activated;
      },
      async (tx, activated) => {
        if (evidenceToCopy.length)
          await tx.memoryEvidence.createMany({
            data: evidenceToCopy.map((proof) => ({
              documentId: activated.id,
              revision: activated.revision,
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
      },
    );
  }
  async restore(actor: Actor, id: string, expected: number) {
    return this.transition(actor, id, expected, "active", ["withdrawn"]);
  }
  async withdraw(actor: Actor, id: string, expected: number) {
    return this.transition(actor, id, expected, "withdrawn", ["active", "proposed", "superseded"]);
  }

  async publish(
    actor: Actor,
    input: Omit<CreateInput, "collection"> & {
      documentId: string;
      expectedRevision: number;
      includeSourceExcerpt: boolean;
    },
  ) {
    return withMemoryCommandRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const source = await this.findVisibleTx(tx, actor, input.documentId);
          if (!this.canPublish(actor, source) || source.revision !== input.expectedRevision)
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
          if (input.idempotencyKey) {
            const command = await tx.memoryCommand.findUnique({
              where: {
                spaceId_userId_key: {
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                  key: input.idempotencyKey,
                },
              },
            });
            if (command) {
              if (command.fingerprint !== commandFingerprint || !command.documentId)
                throw new MemoryConflictError();
              return this.document(actor, await this.findVisibleTx(tx, actor, command.documentId));
            }
            await tx.memoryCommand.create({
              data: {
                spaceId: actor.spaceId,
                userId: actor.userId,
                key: input.idempotencyKey,
                fingerprint: commandFingerprint,
              },
            });
          }
          const collection = await this.collection(tx, actor, "space");
          await this.validateEntityRefs(tx, actor, collection.id, input.qualification);
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
          await this.revise(tx, row, actor.userId, input.idempotencyKey, commandFingerprint);
          if (input.idempotencyKey)
            await tx.memoryCommand.update({
              where: {
                spaceId_userId_key: {
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                  key: input.idempotencyKey,
                },
              },
              data: { documentId: row.id },
            });
          return this.document(actor, {
            ...row,
            collection,
            space: { memberships: [] },
          } as MemoryRow);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async history(actor: Actor, id: string) {
    const row = await this.findVisible(actor, id);
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
        evidence: await this.visibleEvidence(actor, row.id, revision.revision),
        sources: revision.sourceKind
          ? [
              {
                kind: revision.sourceKind as SourceKind,
                referenceId:
                  revision.sourceKind === "message" ? null : (revision.sourceReferenceId ?? null),
                excerpt:
                  revision.sourceKind === "message" ? null : (revision.sourceExcerpt ?? null),
              },
            ]
          : revision.sourceDocumentId
            ? []
            : [{ kind: "inherited" as const, referenceId: null, excerpt: null }],
        publications: [],
      })),
    );
  }

  private async transition(
    actor: Actor,
    id: string,
    expected: number,
    status: MemoryStatus,
    from: MemoryStatus[],
  ) {
    return this.mutate(actor, id, expected, async (tx, row) => {
      if (!this.canEdit(actor, row) || !from.includes(row.status as MemoryStatus))
        throw new MemoryAccessError();
      return tx.memoryDocument.update({
        where: { id },
        data: { status, revision: { increment: 1 }, accessVersion: { increment: 1 } },
      });
    });
  }
  private async mutate(
    actor: Actor,
    id: string,
    expected: number,
    operation: (tx: Prisma.TransactionClient, row: MemoryRow) => Promise<StoredMemoryRow>,
    afterRevise?: (tx: Prisma.TransactionClient, changed: StoredMemoryRow) => Promise<void>,
  ) {
    return withTransactionRetry(async () => {
      const result = await this.prisma.$transaction(
        async (tx) => {
          const row = await this.findVisibleTx(tx, actor, id);
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
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return {
        ...result.document,
        evidence: await this.visibleEvidence(actor, result.documentId, result.revision),
      };
    });
  }
  private async revise(
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
  private async collection(
    tx: Prisma.TransactionClient,
    actor: Actor,
    kind: MemoryCollectionKind,
    botId?: string,
  ) {
    if (kind === "agent" && !botId) throw new MemoryAccessError();
    if (
      kind === "agent" &&
      !(await tx.bot.findFirst({
        where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      }))
    )
      throw new MemoryAccessError();
    const ownerUserId = kind === "space" ? null : actor.userId;
    const selectedBotId = kind === "agent" ? botId! : null;
    const existing = await tx.memoryCollection.findFirst({
      where: { spaceId: actor.spaceId, kind, ownerUserId, botId: selectedBotId },
    });
    return (
      existing ??
      tx.memoryCollection.create({
        data: { spaceId: actor.spaceId, kind, ownerUserId, botId: selectedBotId },
      })
    );
  }
  private async visibleWhere(actor: Actor, input: LibraryInput) {
    return {
      spaceId: actor.spaceId,
      space: { memberships: { some: { userId: actor.userId } } },
      ...(input.status ? { status: input.status } : {}),
      collection: {
        ...(input.collection ? { kind: input.collection } : {}),
        OR: [{ kind: "space" }, { ownerUserId: actor.userId }],
      },
      ...(input.botId ? { botId: input.botId } : {}),
    };
  }
  private async findVisible(actor: Actor, id: string) {
    const row = await this.prisma.memoryDocument.findFirst({
      where: { id, ...(await this.visibleWhere(actor, {})) },
      include: {
        collection: true,
        space: {
          select: { memberships: { where: { userId: actor.userId }, select: { role: true } } },
        },
      },
    });
    if (!row) throw new MemoryAccessError();
    return row;
  }
  private async validateEntityRefs(
    tx: Prisma.TransactionClient,
    actor: Actor,
    collectionId: string,
    value?: Qualification,
  ) {
    const refs = value?.entityRefs ?? [];
    for (const ref of refs) {
      const target = await this.findVisibleTx(tx, actor, ref.documentId);
      if (target.collectionId !== collectionId) throw new MemoryAccessError();
    }
  }
  private async copyCurrentDocumentEvidence(
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
      let source: MemoryRow;
      try {
        source = await this.findVisibleTx(tx, actor, proof.sourceReferenceId);
      } catch {
        return;
      }
      const originalRevision = Number(proof.sourceVersion);
      if (source.collectionId !== changed.collectionId || !Number.isSafeInteger(originalRevision))
        return;
      if (source.status === "active" && source.revision === originalRevision) {
        if (
          proof.sourceDigest !==
          fingerprint({ id: source.id, revision: source.revision, content: source.content })
        )
          return;
        if (!(await isMemoryRecallEligible(tx, actor, source))) return;
        continue;
      }
      if (
        proof.sourceRole !== "replacement" ||
        source.status !== "superseded" ||
        source.revision !== originalRevision + 1
      )
        return;
      const original = await tx.memoryRevision.findUnique({
        where: { documentId_revision: { documentId: source.id, revision: originalRevision } },
        select: { content: true },
      });
      if (
        !original ||
        proof.sourceDigest !==
          fingerprint({ id: source.id, revision: originalRevision, content: original.content })
      )
        return;
      if (
        !(await isMemoryRecallEligible(tx, actor, {
          id: source.id,
          revision: originalRevision,
          collectionId: source.collectionId,
        }))
      )
        return;
    }
    await tx.memoryEvidence.createMany({
      data: evidence.map((proof) => ({
        documentId: changed.id,
        revision: changed.revision,
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
  private async visibleQualification(actor: Actor, row: MemoryRow): Promise<Qualification> {
    const value = qualification(row.qualification);
    const visibleReference = async (documentId: string) => {
      try {
        const target = await this.findVisible(actor, documentId);
        return target.collectionId === row.collectionId;
      } catch {
        return false;
      }
    };
    const entityRefs = await Promise.all(
      (value.entityRefs ?? []).map(async (ref) =>
        (await visibleReference(ref.documentId)) ? ref : null,
      ),
    );
    const relations = await Promise.all(
      (value.relations ?? []).map(async (relation) =>
        (await visibleReference(relation.documentId)) ? relation : null,
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
  private async visibleEvidence(actor: Actor, documentId: string, revision: number) {
    const evidence = await this.prisma.memoryEvidence.findMany({
      where: { documentId, revision },
      orderBy: { createdAt: "asc" },
    });
    if (evidence.length === 0) return [];
    const messageIds = evidence
      .filter((item) => item.sourceKind === "message")
      .map((item) => item.sourceReferenceId);
    const messages = messageIds.length
      ? await this.prisma.message.findMany({
          where: {
            id: { in: messageIds },
            role: { in: ["user", "bot", "assistant"] },
            thread: { spaceId: actor.spaceId, userId: actor.userId },
          },
          select: { id: true, blocks: true, role: true },
        })
      : [];
    const byId = new Map(messages.map((message) => [message.id, message]));
    return Promise.all(
      evidence.map(async (item) => {
        const message = byId.get(item.sourceReferenceId);
        const sourceText =
          message && Array.isArray(message.blocks)
            ? message.blocks
                .flatMap((block) =>
                  typeof block === "object" &&
                  block !== null &&
                  "kind" in block &&
                  block.kind === "text" &&
                  "text" in block &&
                  typeof block.text === "string"
                    ? [block.text]
                    : [],
                )
                .join("\n")
            : "";
        const hasExactExcerpt = Boolean(
          message &&
            Number.isSafeInteger(item.startOffset) &&
            Number.isSafeInteger(item.endOffset) &&
            item.startOffset !== null &&
            item.endOffset !== null &&
            item.endOffset > item.startOffset &&
            item.endOffset <= sourceText.length &&
            item.excerpt !== null &&
            sourceText.slice(item.startOffset, item.endOffset) === item.excerpt,
        );
        const accessible =
          item.sourceKind === "message"
            ? message !== undefined &&
              fingerprint(message.blocks) === item.sourceVersion &&
              hasExactExcerpt
            : item.sourceKind === "document" &&
              (await this.isCurrentDocumentEvidence(actor, item, true));
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
    proof: {
      sourceReferenceId: string;
      sourceVersion: string | null;
      sourceDigest: string;
      sourceRole: string | null;
    },
    allowSupersededReplacement: boolean,
  ) {
    let source: MemoryRow;
    try {
      source = await this.findVisible(actor, proof.sourceReferenceId);
    } catch {
      return false;
    }
    const originalRevision = Number(proof.sourceVersion);
    if (!Number.isSafeInteger(originalRevision) || originalRevision < 1) return false;
    const now = new Date();
    if (
      source.status === "active" &&
      source.revision === originalRevision &&
      (!source.validFrom || source.validFrom <= now) &&
      (!source.validUntil || source.validUntil >= now) &&
      proof.sourceDigest ===
        fingerprint({ id: source.id, revision: source.revision, content: source.content })
    )
      return isMemoryRecallEligible(this.prisma, actor, source);
    if (
      !allowSupersededReplacement ||
      source.status !== "superseded" ||
      source.revision !== originalRevision + 1 ||
      proof.sourceRole !== "replacement" ||
      (source.validFrom !== null && source.validFrom > now) ||
      (source.validUntil !== null && source.validUntil < now)
    )
      return false;
    const original = await this.prisma.memoryRevision.findUnique({
      where: { documentId_revision: { documentId: source.id, revision: originalRevision } },
      select: { content: true },
    });
    return (
      original !== null &&
      proof.sourceDigest ===
        fingerprint({
          id: source.id,
          revision: originalRevision,
          content: original.content,
        }) &&
      isMemoryRecallEligible(this.prisma, actor, {
        id: source.id,
        revision: originalRevision,
        collectionId: source.collectionId,
      })
    );
  }
  private async findVisibleTx(tx: Prisma.TransactionClient, actor: Actor, id: string) {
    const row = await tx.memoryDocument.findFirst({
      where: {
        id,
        spaceId: actor.spaceId,
        space: { memberships: { some: { userId: actor.userId } } },
        collection: { OR: [{ kind: "space" }, { ownerUserId: actor.userId }] },
      },
      include: {
        collection: true,
        space: {
          select: { memberships: { where: { userId: actor.userId }, select: { role: true } } },
        },
      },
    });
    if (!row) throw new MemoryAccessError();
    return row;
  }
  private canEdit(actor: Actor, row: MemoryRow) {
    return row.collection.kind !== "space"
      ? row.collection.ownerUserId === actor.userId
      : row.userId === actor.userId ||
          row.space.memberships.some((membership) => membership.role === "owner");
  }
  private canPublish(actor: Actor, row: MemoryRow) {
    return this.canEdit(actor, row);
  }
  private summary(actor: Actor, row: MemoryRow) {
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
      canPublish: this.canPublish(actor, row),
      canWithdraw: this.canEdit(actor, row),
    };
  }
  private document(actor: Actor, row: MemoryRow) {
    return {
      ...this.summary(actor, row),
      content: row.content,
      sources: row.sourceKind
        ? [
            {
              kind: row.sourceKind as SourceKind,
              referenceId: row.sourceKind === "message" ? null : (row.sourceReferenceId ?? null),
              excerpt: row.sourceKind === "message" ? null : (row.sourceExcerpt ?? null),
            },
          ]
        : row.sourceDocumentId
          ? []
          : [{ kind: "inherited" as const, referenceId: null, excerpt: null }],
      publications: [],
    };
  }
}
