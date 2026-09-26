import type { MemoryClassificationToolResult } from "@rakazo/adapter-kit";
import type { Actor, BotMemoryClassificationResult, MemoryMethodSnapshot } from "@rakazo/contracts";
import {
  AI_CONSENT_REQUIRED,
  AI_DISCLOSURE_VERSION,
  MemoryMethodSnapshotSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { MemoryBotClassifier } from "@rakazo/memory";
import { MarkdownMemoryLibrary, MemoryAccessError, MemoryConflictError } from "@rakazo/memory";
import { aiRecipient } from "./ai-consent.js";
import { createMemoryBotClassifierConnection } from "./memory-bot-classifier-factory.js";
import { memoryManagementEnabled } from "./memory-management-tools.js";
import type { EncryptedSecretStore } from "./secrets.js";

type ClassifierResolver = (
  actor: Pick<Actor, "userId" | "spaceId">,
  method: Pick<MemoryMethodSnapshot, "provider" | "model">,
) => Promise<MemoryBotClassifier>;

export type BotMemoryClassificationRequest = {
  actor: Pick<Actor, "userId" | "spaceId">;
  botId: string;
  memoryId: string;
  expectedRevision?: number;
};

export type BotMemoryClassificationService = {
  /** Runtime entry: the actor must own the bot and private agent memories stay bot-scoped. */
  classifyForBot(input: BotMemoryClassificationRequest): Promise<MemoryClassificationToolResult>;
  /** UI entry: a visible shared method may classify only an explicitly shared Space method. */
  classifyVisibleMethod(
    input: BotMemoryClassificationRequest,
  ): Promise<BotMemoryClassificationResult & { reviewPath: string }>;
};

export class MemoryClassificationConsentRequired extends Error {
  constructor(readonly reviewPath: string) {
    super(AI_CONSENT_REQUIRED);
    this.name = "MemoryClassificationConsentRequired";
  }
}

export function createBotMemoryClassificationService(input: {
  prisma: PrismaClient;
  secrets: Pick<EncryptedSecretStore, "load">;
  resolveClassifier?: ClassifierResolver;
}): BotMemoryClassificationService {
  const library = new MarkdownMemoryLibrary(input.prisma);
  const resolveClassifier =
    input.resolveClassifier ??
    ((actor, method) =>
      resolveMemoryBotClassifier({ prisma: input.prisma, secrets: input.secrets }, actor, method));

  async function classify(
    request: BotMemoryClassificationRequest,
    allowSharedMethod: boolean,
  ): Promise<BotMemoryClassificationResult & { reviewPath: string }> {
    const libraryActor = await resolveLibraryActor(request.actor);
    const document = await library.get(libraryActor, request.memoryId);
    const bot = await input.prisma.bot.findFirst({
      where: { id: request.botId, spaceId: request.actor.spaceId, archivedAt: null },
      select: {
        id: true,
        name: true,
        userId: true,
        memoryMethodDisabledAt: true,
        instructions: true,
      },
    });
    if (!bot || bot.memoryMethodDisabledAt) throw new MemoryAccessError();
    const isOwner = bot.userId === request.actor.userId;
    if (!isOwner && !allowSharedMethod) throw new MemoryAccessError();

    const row = await input.prisma.botMemoryMethod.findFirst({
      where: { botId: bot.id },
      orderBy: { version: "desc" },
    });
    if (!row) throw new MemoryConflictError("Prepare the method from your bot Instructions first");
    if (row.instructions !== bot.instructions)
      throw new MemoryConflictError("Bot instructions changed. Prepare the method again.");
    const method = MemoryMethodSnapshotSchema.parse({
      id: row.id,
      botId: row.botId,
      version: row.version,
      instructions: row.instructions,
      prepared: row.prepared,
      provider: row.provider,
      model: row.model,
      allowedCollections: row.allowedCollections,
      sharing: row.sharing,
      createdAt: row.createdAt.toISOString(),
    });
    if (!isOwner && (document.collection.kind !== "space" || method.sharing !== "space"))
      throw new MemoryAccessError();
    if (!method.allowedCollections.includes(document.collection.kind))
      throw new MemoryConflictError("This bot method does not allow this memory collection");
    if (document.collection.kind === "agent" && document.collection.botId !== bot.id)
      throw new MemoryAccessError();
    if (request.expectedRevision !== undefined && document.revision !== request.expectedRevision)
      throw new MemoryConflictError("This memory changed; open it again before classifying");

    let classifier: MemoryBotClassifier;
    try {
      classifier = await resolveClassifier(request.actor, method);
    } catch (error) {
      if (error instanceof Error && error.message === AI_CONSENT_REQUIRED)
        throw new MemoryClassificationConsentRequired(`/app/${bot.id}`);
      throw error;
    }
    const result = await library.classifyByBot(
      libraryActor,
      {
        botId: bot.id,
        botName: bot.name,
        method,
        documentId: document.id,
        expectedRevision: request.expectedRevision ?? document.revision,
      },
      classifier,
    );
    return { ...result, reviewPath: reviewPath(document, bot.id, result.classificationId) };
  }

  return {
    classifyForBot: async (request) => {
      if (!(await memoryManagementEnabled(input.prisma, request.actor, request.botId)))
        throw new MemoryAccessError();
      const result = await classify(request, false);
      return {
        classificationId: result.classificationId,
        documentId: result.candidate.id,
        revision: result.candidate.revision,
        suggestion: result.suggestion,
        questions: result.method.prepared.questions.map(({ key, label, options }) => ({
          key,
          label,
          options,
        })),
        reviewPath: `/app/${request.botId}`,
      };
    },
    classifyVisibleMethod: (request) => classify(request, true),
  };

  async function resolveLibraryActor(actor: Pick<Actor, "userId" | "spaceId">): Promise<Actor> {
    const user = await input.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { email: true },
    });
    if (!user) throw new MemoryAccessError();
    // Runtime classification has no deployment-owner privileges; the library only needs these
    // identity fields for visibility checks.
    return { ...actor, email: user.email, isDeploymentOwner: false };
  }
}

function reviewPath(
  document: { id: string; collection: { kind: "personal" | "agent" | "space" } },
  botId: string,
  classificationId?: string,
) {
  const query = new URLSearchParams({
    collection: document.collection.kind,
    ...(document.collection.kind === "agent" ? { bot: botId } : {}),
    memory: document.id,
    ...(classificationId ? { classification: classificationId } : {}),
  });
  return `/app/memory?${query.toString()}`;
}

/** Resolve the method's exact model and consent; never fall back to broad model consent. */
export async function resolveMemoryBotClassifier(
  deps: {
    prisma: PrismaClient;
    secrets: Pick<EncryptedSecretStore, "load">;
    createClassifier?: typeof createMemoryBotClassifierConnection;
  },
  actor: Pick<Actor, "userId" | "spaceId">,
  method: Pick<MemoryMethodSnapshot, "provider" | "model">,
): Promise<MemoryBotClassifier> {
  const member = await deps.prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { spaceId: true },
  });
  if (!member) throw new MemoryAccessError();
  if (method.provider === "local") {
    return createMemoryBotClassifierConnection({ provider: "local", model: method.model });
  }
  const config = await deps.prisma.spaceMemoryClassifierConfig.findUnique({
    where: { spaceId: actor.spaceId },
  });
  if (!config || config.provider !== method.provider || config.model !== method.model)
    throw new MemoryConflictError("Connect the model selected by this bot method");
  const recipient = aiRecipient({
    provider: config.provider,
    modelId: config.model,
    use: "memory-classification",
  });
  const consent = recipient
    ? await deps.prisma.aiDataConsent.findUnique({
        where: {
          userId_spaceId_recipientKey: {
            userId: actor.userId,
            spaceId: actor.spaceId,
            recipientKey: recipient.key,
          },
        },
      })
    : null;
  if (!consent || consent.version !== AI_DISCLOSURE_VERSION) throw new Error(AI_CONSENT_REQUIRED);
  const secret = await deps.prisma.secret.findFirst({
    where: { id: config.secretId, spaceId: actor.spaceId, kind: "memory-classifier" },
  });
  if (!secret) throw new MemoryConflictError("Reconnect the selected model");
  try {
    return (deps.createClassifier ?? createMemoryBotClassifierConnection)({
      provider: method.provider,
      model: method.model,
      apiKey: deps.secrets.load(secret.ciphertext, secret.id),
    });
  } catch {
    throw new MemoryConflictError("Reconnect the selected model");
  }
}
