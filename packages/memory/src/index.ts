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
import { IsolationError, Prisma } from "@rakazo/db";
import { isMemoryRecallEligible, withMemoryCommandRetry } from "./library.js";

export * from "./bot-classification.js";
export * from "./library.js";
export * from "./okf.js";

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
    const now = new Date();
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        spaceId: context.spaceId,
        space: { memoryRecallEnabled: true, memberships: { some: { userId: context.userId } } },
        scope: request.scope,
        ...(request.botId ? { botId: request.botId } : {}),
        ...(request.path ? { path: request.path } : {}),
        status: "active",
        AND: [
          { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
          { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
        ],
        collection:
          request.scope === "bot"
            ? { kind: "agent", ownerUserId: context.userId }
            : { OR: [{ kind: "space" }, { kind: "personal", ownerUserId: context.userId }] },
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
    const eligible = await Promise.all(
      documents.map(async (doc) =>
        (await isMemoryRecallEligible(this.prisma, context, doc)) ? doc : null,
      ),
    );
    return {
      documents: eligible
        .filter((doc): doc is NonNullable<typeof doc> => doc !== null)
        .map((doc) => ({
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
    const now = new Date();
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        spaceId: context.spaceId,
        space: { memoryRecallEnabled: true, memberships: { some: { userId: context.userId } } },
        status: "active",
        AND: [
          { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
          { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
          request.scope === "bot"
            ? {
                scope: "bot",
                ...(request.botId ? { botId: request.botId } : {}),
                collection: { kind: "agent", ownerUserId: context.userId },
              }
            : request.scope === "user"
              ? {
                  scope: "user",
                  collection: {
                    OR: [{ kind: "space" }, { kind: "personal", ownerUserId: context.userId }],
                  },
                }
              : {
                  OR: [
                    {
                      scope: "bot",
                      ...(request.botId ? { botId: request.botId } : {}),
                      collection: { kind: "agent", ownerUserId: context.userId },
                    },
                    {
                      scope: "user",
                      collection: {
                        OR: [{ kind: "space" }, { kind: "personal", ownerUserId: context.userId }],
                      },
                    },
                  ],
                },
        ],
      },
    });
    const eligible = await Promise.all(
      documents.map(async (doc) =>
        (await isMemoryRecallEligible(this.prisma, context, doc)) ? doc : null,
      ),
    );
    const tokens = searchTokens(request.query);
    return eligible
      .filter((doc): doc is NonNullable<typeof doc> => doc !== null)
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

  async commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision> {
    const membership = await this.prisma.spaceMember.findFirst({
      where: { spaceId: context.spaceId, userId: context.userId },
    });
    if (!membership) throw new IsolationError();
    if (
      request.scope === "bot" &&
      (!request.botId ||
        !(await this.prisma.bot.findFirst({
          where: { id: request.botId, spaceId: context.spaceId, userId: context.userId },
        })))
    )
      throw new IsolationError();
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
    return withMemoryCommandRetry(() =>
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
          const existingCommand = await tx.memoryCommand.findUnique({
            where: {
              spaceId_userId_key: {
                spaceId: context.spaceId,
                userId: context.userId,
                key: commandKey,
              },
            },
          });
          if (existingCommand?.documentId) {
            const existing = await tx.memoryDocument.findFirst({
              where: {
                id: existingCommand.documentId,
                spaceId: context.spaceId,
                userId: context.userId,
              },
            });
            if (!existing) throw new IsolationError();
            return {
              id: existing.id,
              path: existing.path,
              revision: existing.revision,
              content: existing.content,
            };
          }
          await tx.memoryCommand.create({
            data: {
              spaceId: context.spaceId,
              userId: context.userId,
              key: commandKey,
              fingerprint: retryKey,
            },
          });
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
            const sourceMessage = await tx.message.findFirst({
              where: {
                id: proof.sourceReferenceId,
                role: { in: ["user", "bot", "assistant"] },
                thread: {
                  spaceId: context.spaceId,
                  userId: context.userId,
                  ...(request.botId ? { botId: request.botId } : {}),
                },
              },
              select: { blocks: true, role: true },
            });
            if (!sourceMessage) throw new IsolationError();
            const sourceVersion = createHash("sha256")
              .update(JSON.stringify(sourceMessage.blocks))
              .digest("hex");
            if (sourceVersion !== proof.sourceVersion) throw new IsolationError();
            const sourceText = Array.isArray(sourceMessage.blocks)
              ? sourceMessage.blocks
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
            if (
              proof.startOffset === null ||
              proof.endOffset === null ||
              typeof proof.excerpt !== "string" ||
              !Number.isSafeInteger(proof.startOffset) ||
              !Number.isSafeInteger(proof.endOffset) ||
              proof.startOffset < 0 ||
              proof.endOffset <= proof.startOffset ||
              proof.endOffset > sourceText.length ||
              sourceText.slice(proof.startOffset, proof.endOffset) !== proof.excerpt
            )
              throw new IsolationError();
            verifiedEvidence.push({
              sourceKind: proof.sourceKind,
              sourceRole: sourceMessage.role === "user" ? "user" : "assistant",
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
                (await tx.memoryCollection.findFirst({
                  where: {
                    spaceId: context.spaceId,
                    kind: request.scope === "bot" ? "agent" : "personal",
                    ownerUserId: context.userId,
                    botId: request.scope === "bot" ? (request.botId ?? null) : null,
                  },
                })) ??
                (await tx.memoryCollection.create({
                  data: {
                    spaceId: context.spaceId,
                    kind: request.scope === "bot" ? "agent" : "personal",
                    ownerUserId: context.userId,
                    botId: request.scope === "bot" ? (request.botId ?? null) : null,
                  },
                }))
              ).id,
              path: `proposals/${randomUUID()}.md`,
              content,
              title: titleFromContent(content, request.path),
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
          await tx.memoryCommand.update({
            where: {
              spaceId_userId_key: {
                spaceId: context.spaceId,
                userId: context.userId,
                key: commandKey,
              },
            },
            data: { documentId: doc.id },
          });
          return { id: doc.id, path: doc.path, revision: doc.revision, content: doc.content };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
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

/** Keeps exactly one newline between what the document already holds and the addition. */
function titleFromContent(content: string, fallback: string): string {
  return (
    content
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean)
      ?.slice(0, 240) ?? fallback
  );
}

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
