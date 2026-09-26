import { ORPCError } from "@orpc/server";
import type { EncryptedSecretStore } from "@rakazo/adapters";
import {
  type createMemoryBotClassifierConnection,
  memoryClassifierProviders,
  resolveMemoryBotClassifier,
  verifyMemoryBotClassifierConnection,
} from "@rakazo/adapters";
import type {
  Actor,
  MemoryClassifierConnectionInput,
  MemoryMethodSnapshot,
} from "@rakazo/contracts";
import { AI_CONSENT_REQUIRED } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { withSerializableRetry } from "./serializable-retry.js";

type Deps = {
  prisma: PrismaClient;
  secrets: Pick<EncryptedSecretStore, "put" | "load">;
  verify?: typeof verifyMemoryBotClassifierConnection;
  createClassifier?: typeof createMemoryBotClassifierConnection;
};

async function membership(
  db: PrismaClient | Prisma.TransactionClient,
  actor: Actor,
  owner = false,
) {
  const member = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { role: true, space: { select: { name: true } } },
  });
  if (!member) throw new ORPCError("FORBIDDEN");
  const canConfigure = member.role
    .split(",")
    .map((role) => role.trim())
    .includes("owner");
  if (owner && !canConfigure) throw new ORPCError("FORBIDDEN");
  return { canConfigure, spaceName: member.space.name };
}

export async function getMemoryClassifierSettings(deps: Deps, actor: Actor) {
  const access = await membership(deps.prisma, actor);
  const connection = await deps.prisma.spaceMemoryClassifierConfig.findUnique({
    where: { spaceId: actor.spaceId },
    select: { provider: true, model: true },
  });
  return { ...access, providers: memoryClassifierProviders, connection };
}

export async function connectMemoryClassifier(
  deps: Deps,
  actor: Actor,
  input: MemoryClassifierConnectionInput,
) {
  await membership(deps.prisma, actor, true);
  if (!memoryClassifierProviders.some(({ id }) => id === input.provider))
    throw new ORPCError("BAD_REQUEST", { message: "Unsupported memory classifier" });
  try {
    await (deps.verify ?? verifyMemoryBotClassifierConnection)(input);
  } catch {
    // Never echo a provider response, request headers, or credentials.
    throw new ORPCError("BAD_REQUEST", {
      message: "Could not verify this connection. Check the API key and model, then retry.",
    });
  }
  const stored = await deps.secrets.put(input.apiKey, {
    operationId: "memory-classifier-connect",
    traceId: "memory-classifier-connect",
    userId: actor.userId,
    spaceId: actor.spaceId,
    signal: new AbortController().signal,
  });
  await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        await membership(tx, actor, true);
        const previous = await tx.spaceMemoryClassifierConfig.findUnique({
          where: { spaceId: actor.spaceId },
        });
        await tx.secret.create({
          data: {
            id: stored.id,
            ciphertext: stored.ciphertext,
            userId: actor.userId,
            spaceId: actor.spaceId,
            kind: "memory-classifier",
          },
        });
        await tx.spaceMemoryClassifierConfig.upsert({
          where: { spaceId: actor.spaceId },
          create: {
            spaceId: actor.spaceId,
            provider: input.provider,
            model: input.model,
            secretId: stored.id,
          },
          update: { provider: input.provider, model: input.model, secretId: stored.id },
        });
        if (previous)
          await tx.secret.deleteMany({
            where: { id: previous.secretId, spaceId: actor.spaceId, kind: "memory-classifier" },
          });
      },
      { isolationLevel: "Serializable" },
    ),
  );
  return getMemoryClassifierSettings(deps, actor);
}

export async function disconnectMemoryClassifier(deps: Deps, actor: Actor) {
  await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        await membership(tx, actor, true);
        const previous = await tx.spaceMemoryClassifierConfig.findUnique({
          where: { spaceId: actor.spaceId },
        });
        await tx.spaceMemoryClassifierConfig.deleteMany({ where: { spaceId: actor.spaceId } });
        if (previous)
          await tx.secret.deleteMany({
            where: { id: previous.secretId, spaceId: actor.spaceId, kind: "memory-classifier" },
          });
      },
      { isolationLevel: "Serializable" },
    ),
  );
  return getMemoryClassifierSettings(deps, actor);
}

/** Resolve the judgment model captured by one active bot-method version. */
export async function resolveBotMemoryClassifier(
  deps: Deps,
  actor: Actor,
  method: Pick<MemoryMethodSnapshot, "provider" | "model">,
) {
  try {
    return await resolveMemoryBotClassifier(deps, actor, method);
  } catch (error) {
    if (error instanceof Error && error.message === AI_CONSENT_REQUIRED)
      throw new ORPCError("FORBIDDEN", { message: AI_CONSENT_REQUIRED });
    if (
      error instanceof Error &&
      /Connect the model|Reconnect the selected model/.test(error.message)
    )
      throw new ORPCError("PRECONDITION_FAILED", { message: error.message });
    throw error;
  }
}
