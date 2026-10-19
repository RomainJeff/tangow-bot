import type { Actor, MemoryCollectionKind, MemoryStatus } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import { fingerprint, messageDigest, messageText } from "./shared.js";

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
type Reader = Pick<Actor, "spaceId" | "userId">;
export type StoredMemoryRow = Prisma.MemoryDocumentGetPayload<Record<string, never>>;
type DependencyReader = Pick<
  Prisma.TransactionClient,
  "memoryEvidence" | "memoryDocument" | "memoryRevision"
>;

/**
 * The memories an actor can read: in a Space they belong to, shared or in their own collections.
 * With `bot`, another bot's private collection is out of reach too.
 */
export function visibleWhere(actor: Reader, input: LibraryInput = {}, bot?: string) {
  return {
    spaceId: actor.spaceId,
    space: { memberships: { some: { userId: actor.userId } } },
    ...(input.status ? { status: input.status } : {}),
    collection: {
      ...(input.collection ? { kind: input.collection } : {}),
      OR: [{ kind: "space" as const }, { ownerUserId: actor.userId }],
      ...(bot ? { NOT: { kind: "agent", botId: { not: bot } } } : {}),
    },
    ...(input.botId ? { botId: input.botId } : {}),
  } satisfies Prisma.MemoryDocumentWhereInput;
}

/** Visible active memories in their validity window, in a Space with recall on. */
export function recallableWhere(actor: Reader, bot?: string): Prisma.MemoryDocumentWhereInput {
  const visible = visibleWhere(actor, { status: "active" }, bot);
  const now = new Date();
  return {
    ...visible,
    space: { ...visible.space, memoryRecallEnabled: true },
    AND: [
      { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
      { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
    ],
  };
}

export function inValidity(row: Pick<StoredMemoryRow, "validFrom" | "validUntil">) {
  const now = new Date();
  return (!row.validFrom || row.validFrom <= now) && (!row.validUntil || row.validUntil >= now);
}

export function contentFingerprint(content: string) {
  return fingerprint({ content });
}

type MessageProof = {
  sourceVersion: string | null;
  startOffset: number | null;
  endOffset: number | null;
  excerpt: string | null;
};

/** Whether message evidence still quotes its source: same version, the exact excerpt at its offsets. */
export function quotesMessage(proof: MessageProof, message: { blocks: unknown } | undefined) {
  if (!message || messageDigest(message.blocks) !== proof.sourceVersion) return false;
  const text = messageText(message.blocks);
  const { startOffset, endOffset, excerpt } = proof;
  return (
    startOffset !== null &&
    endOffset !== null &&
    typeof excerpt === "string" &&
    Number.isSafeInteger(startOffset) &&
    Number.isSafeInteger(endOffset) &&
    startOffset >= 0 &&
    endOffset > startOffset &&
    endOffset <= text.length &&
    text.slice(startOffset, endOffset) === excerpt
  );
}

/** Reject derived memories when any source in their bounded dependency chain is stale or inaccessible. */
export async function isMemoryRecallEligible(
  db: DependencyReader,
  actor: Reader,
  document: { id: string; revision: number; collectionId: string },
) {
  return verifyDocumentDependencies(db, actor, document, new Set(), { count: 0 }, 0);
}

async function verifyDocumentDependencies(
  db: DependencyReader,
  actor: Reader,
  document: { id: string; revision: number; collectionId: string },
  visited: Set<string>,
  budget: { count: number },
  depth: number,
): Promise<boolean> {
  const key = `${document.id}:${document.revision}`;
  if (depth > 10 || budget.count >= 64 || visited.has(key)) return false;
  const nextVisited = new Set(visited).add(key);
  budget.count += 1;
  const allProofs = await db.memoryEvidence.findMany({
    where: { documentId: document.id, sourceKind: "document" },
    orderBy: { createdAt: "asc" },
  });
  const proofs = allProofs.filter((proof) => proof.revision === document.revision);
  if (!proofs.length) return allProofs.length === 0;
  if (proofs.length < 2 || proofs.length > 8) return false;
  for (const proof of proofs) {
    const source = await db.memoryDocument.findFirst({
      where: { id: proof.sourceReferenceId, ...visibleWhere(actor) },
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
    if (!source || source.collectionId !== document.collectionId) return false;
    const revision = await checkDocumentProof(db, proof, source);
    if (
      revision === null ||
      !(await verifyDocumentDependencies(
        db,
        actor,
        { ...source, revision },
        nextVisited,
        budget,
        depth + 1,
      ))
    )
      return false;
  }
  return true;
}

export type DocumentProof = {
  sourceReferenceId: string;
  sourceVersion: string | null;
  sourceDigest: string;
  sourceRole: string | null;
};

/**
 * The source revision a document proof still vouches for, or null once it went stale: the source
 * must be in its validity window and either unchanged, or superseded by exactly the consolidation
 * that replaced it.
 */
export async function checkDocumentProof(
  db: DependencyReader,
  proof: DocumentProof,
  source: Pick<
    StoredMemoryRow,
    "id" | "revision" | "status" | "content" | "validFrom" | "validUntil"
  >,
  allowReplacement = true,
): Promise<number | null> {
  const revision = Number(proof.sourceVersion);
  if (!Number.isSafeInteger(revision) || revision < 1 || !inValidity(source)) return null;
  if (source.status === "active" && source.revision === revision)
    return proof.sourceDigest === fingerprint({ id: source.id, revision, content: source.content })
      ? revision
      : null;
  if (
    !allowReplacement ||
    proof.sourceRole !== "replacement" ||
    source.status !== "superseded" ||
    source.revision !== revision + 1
  )
    return null;
  const original = await db.memoryRevision.findUnique({
    where: { documentId_revision: { documentId: source.id, revision } },
    select: { content: true },
  });
  return original &&
    proof.sourceDigest === fingerprint({ id: source.id, revision, content: original.content })
    ? revision
    : null;
}

/**
 * Whether a memory row can still feed classification: active (or proposed when allowed), in its
 * validity window, recall-eligible, and unchanged from every expectation given.
 */
export async function isCurrentRow(
  db: DependencyReader,
  actor: Reader,
  row: StoredMemoryRow | null,
  expected: {
    revision?: number;
    collectionId?: string;
    accessVersion?: number;
    contentDigest?: string;
    allowProposed?: boolean;
  } = {},
): Promise<boolean> {
  if (!row) return false;
  return (
    (expected.revision === undefined || row.revision === expected.revision) &&
    (expected.collectionId === undefined || row.collectionId === expected.collectionId) &&
    (expected.accessVersion === undefined || row.accessVersion === expected.accessVersion) &&
    (expected.contentDigest === undefined ||
      contentFingerprint(row.content) === expected.contentDigest) &&
    (row.status === "active" || (expected.allowProposed === true && row.status === "proposed")) &&
    inValidity(row) &&
    (await isMemoryRecallEligible(db, actor, row))
  );
}
