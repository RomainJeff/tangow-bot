import { createHash, randomUUID } from "node:crypto";
import type {
  AdapterContext,
  MemoryCommitRequest,
  MemoryExportRequest,
  MemoryReadRequest,
  MemoryRevision,
  MemorySearchRequest,
  MemorySearchResult,
  MemorySnapshot,
  MemoryStore,
  PortableFile,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, Prisma, withTransactionRetry } from "@rakazo/db";
import { isMemoryRecallEligible, quotesMessage, recallableWhere } from "./access.js";
import { findSourceMessages, memoryCollection, titleFor, withMemoryCommand } from "./shared.js";

export * from "./library.js";
export * from "./okf.js";
export { messageDigest, messageText } from "./shared.js";

export class MarkdownMemoryStore implements MemoryStore {
  constructor(private readonly prisma: PrismaClient) {}

  describe() {
    return {
      id: "markdown",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, revisions: true, markdownPortable: true },
    };
  }

  async read(request: MemoryReadRequest, context: AdapterContext): Promise<MemorySnapshot> {
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        AND: [
          recallableWhere(context, request.scope === "bot" ? request.botId : undefined),
          request.scope === "bot" ? botMemories : userMemories,
        ],
        ...(request.botId ? { botId: request.botId } : {}),
        ...(request.path ? { path: request.path } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
    const eligible = await this.eligible(documents, context);
    return {
      documents: eligible.map((doc) => ({
        id: doc.id,
        path: doc.path,
        content: doc.content,
        revision: doc.revision,
        accessVersion: doc.accessVersion,
        updatedAt: doc.updatedAt.toISOString(),
      })),
    };
  }

  async search(
    request: MemorySearchRequest,
    context: AdapterContext,
  ): Promise<MemorySearchResult[]> {
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        AND: [
          recallableWhere(context, request.scope === "user" ? undefined : request.botId),
          request.scope === "bot"
            ? botMemories
            : request.scope === "user"
              ? userMemories
              : { OR: [botMemories, userMemories] },
        ],
      },
    });
    const eligible = await this.eligible(documents, context);
    const tokens = searchTokens(request.query);
    return eligible
      .map((doc) => ({ doc, score: lexicalScore(doc.title, doc.content, tokens) }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.doc.updatedAt.getTime() - left.doc.updatedAt.getTime() ||
          left.doc.id.localeCompare(right.doc.id),
      )
      .map(({ doc, score }) => ({
        documentId: doc.id,
        path: doc.path,
        snippet: snippet(doc.content, tokens[0] ?? ""),
        score,
        revision: doc.revision,
        accessVersion: doc.accessVersion,
      }));
  }

  /** Documents whose derived dependencies all still hold. */
  private async eligible<T extends { id: string; revision: number; collectionId: string }>(
    documents: T[],
    context: AdapterContext,
  ) {
    const eligible = await Promise.all(
      documents.map((doc) => isMemoryRecallEligible(this.prisma, context, doc)),
    );
    return documents.filter((_, index) => eligible[index]);
  }

  async commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision> {
    const retryKey = createHash("sha256")
      .update(
        JSON.stringify({
          idempotencyKey: request.idempotencyKey ?? null,
          operationId: context.operationId,
          sourceRunId: request.sourceRunId ?? null,
          scope: request.scope,
          botId: request.botId ?? null,
          path: request.path,
          content: request.content,
          evidence: request.evidence ?? [],
        }),
      )
      .digest("hex");
    const commandKey = `runtime:${request.idempotencyKey ?? retryKey}`;
    return withTransactionRetry(
      () =>
        this.prisma.$transaction(
          async (tx) => {
            const transactionMembership = await tx.spaceMember.findFirst({
              where: { spaceId: context.spaceId, userId: context.userId },
              select: { id: true },
            });
            if (!transactionMembership) throw new IsolationError();
            if (request.scope === "bot") {
              const transactionBot = request.botId
                ? await tx.bot.findFirst({
                    where: { id: request.botId, spaceId: context.spaceId, userId: context.userId },
                    select: { id: true },
                  })
                : null;
              if (!transactionBot) throw new IsolationError();
            }
            return withMemoryCommand(
              tx,
              context,
              { key: commandKey, fingerprint: retryKey },
              async (documentId) => {
                const existing = documentId
                  ? await tx.memoryDocument.findFirst({
                      where: { id: documentId, spaceId: context.spaceId, userId: context.userId },
                    })
                  : null;
                if (!existing) throw new IsolationError();
                return {
                  id: existing.id,
                  path: existing.path,
                  revision: existing.revision,
                  content: existing.content,
                };
              },
              async () => {
                const sourceRun = request.sourceRunId
                  ? await tx.run.findFirst({
                      where: {
                        id: request.sourceRunId,
                        spaceId: context.spaceId,
                        userId: context.userId,
                      },
                      select: { id: true },
                    })
                  : null;
                const sourceThread =
                  !sourceRun && request.sourceThreadId
                    ? await tx.thread.findFirst({
                        where: {
                          id: request.sourceThreadId,
                          spaceId: context.spaceId,
                          userId: context.userId,
                        },
                        select: { id: true },
                      })
                    : null;
                if (
                  (request.sourceRunId && !sourceRun) ||
                  (!sourceRun && request.sourceThreadId && !sourceThread)
                )
                  throw new IsolationError();
                const sourceKind = sourceRun ? "run" : sourceThread ? "thread" : null;
                const sourceReferenceId = sourceRun?.id ?? sourceThread?.id ?? null;
                const verifiedEvidence = [];
                for (const proof of request.evidence ?? []) {
                  if (proof.sourceKind !== "message") continue;
                  const [sourceMessage] = await findSourceMessages(tx, [proof.sourceReferenceId], {
                    spaceId: context.spaceId,
                    userId: context.userId,
                    botId: request.botId,
                  });
                  if (!sourceMessage || !quotesMessage(proof, sourceMessage))
                    throw new IsolationError();
                  verifiedEvidence.push({
                    sourceKind: proof.sourceKind,
                    sourceRole: sourceMessage.role,
                    sourceReferenceId: proof.sourceReferenceId,
                    sourceVersion: proof.sourceVersion,
                    sourceDigest: proof.sourceVersion,
                    startOffset: proof.startOffset,
                    endOffset: proof.endOffset,
                    excerpt: proof.excerpt,
                  });
                }
                // Runtime and tool writes are proposals. They deliberately never mutate an
                // approved or withdrawn document, even when the legacy path matches.
                const content = request.content;
                const doc = await tx.memoryDocument.create({
                  data: {
                    spaceId: context.spaceId,
                    userId: context.userId,
                    botId: request.botId,
                    scope: request.scope,
                    collectionId: (
                      await memoryCollection(
                        tx,
                        context,
                        request.scope === "bot" ? "agent" : "personal",
                        request.botId ?? null,
                      )
                    ).id,
                    path: `proposals/${randomUUID()}.md`,
                    content,
                    title: titleFor(content, undefined, request.path),
                    status: "proposed",
                    sourceKind,
                    sourceReferenceId,
                  },
                });
                await tx.memoryRevision.create({
                  data: {
                    documentId: doc.id,
                    revision: doc.revision,
                    content,
                    sourceRunId: sourceRun?.id,
                    sourceThreadId: sourceThread?.id,
                    sourceKind,
                    sourceReferenceId,
                    title: doc.title,
                    status: doc.status,
                    qualification: doc.qualification === null ? Prisma.JsonNull : doc.qualification,
                    accessVersion: doc.accessVersion,
                  },
                });
                if (verifiedEvidence.length)
                  await tx.memoryEvidence.createMany({
                    data: verifiedEvidence.map((proof) => ({
                      documentId: doc.id,
                      revision: doc.revision,
                      ...proof,
                    })),
                  });
                return { id: doc.id, path: doc.path, revision: doc.revision, content: doc.content };
              },
            );
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      { retryUniqueViolation: true },
    );
  }

  async *exportMarkdown(
    request: MemoryExportRequest,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const snapshot = await this.read(
      { scope: request.scope === "all" ? "user" : request.scope, botId: request.botId },
      context,
    );
    for (const doc of snapshot.documents) {
      yield { path: doc.path, content: new TextEncoder().encode(doc.content) };
    }
  }

  async importMarkdown(
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<MemoryRevision> {
    let last: MemoryRevision | undefined;
    for await (const file of files) {
      last = await this.commit(
        {
          scope: "user",
          path: file.path,
          content: new TextDecoder().decode(file.content),
        },
        context,
      );
    }
    if (!last) throw new Error("No memory files to import");
    return last;
  }
}

/** Narrows recallable memory to the store's legacy scopes; visibility comes from `recallableWhere`. */
const botMemories = { scope: "bot", collection: { kind: "agent" } } as const;
const userMemories = {
  scope: "user",
  collection: { kind: { in: ["space", "personal"] } },
} satisfies Prisma.MemoryDocumentWhereInput;

function snippet(content: string, q: string): string {
  const idx = content.toLowerCase().indexOf(q);
  if (idx < 0) return content.slice(0, 140);
  return content.slice(Math.max(0, idx - 40), idx + q.length + 80);
}
function searchTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 12);
}
function lexicalScore(title: string, content: string, tokens: string[]): number {
  const haystack = `${title}\n${content}`.toLowerCase();
  return tokens.reduce(
    (score, token) =>
      score + (title.toLowerCase().includes(token) ? 3 : 0) + (haystack.includes(token) ? 1 : 0),
    0,
  );
}
