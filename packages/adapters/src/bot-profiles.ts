import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { findDefaultModelCredential, findModelCredential } from "@rakazo/db";
import { DEFAULT_THINKING_LEVEL, selectConfiguredModel } from "./model-selection.js";

type Scope = { userId: string; spaceId: string };

/** Only configuration is inherited; connection secrets stay with the coordinator. */
export type ProfileModelSelection = {
  modelProvider: string;
  modelId: string;
  thinkingLevel: string;
};

type ResolvedModelCredential = {
  secretId: string;
  provider: string;
  defaultModel?: string | null;
  supportsImages?: boolean;
};

export type ProfileConnectionThinkingResolver = (input: {
  scope: Scope;
  provider: string;
  modelId: string;
  credential: ResolvedModelCredential;
}) => Promise<AgentRunRequest["model"]["thinkingLevel"] | null>;

export async function listBotProfiles(prisma: PrismaClient, scope: Scope) {
  const bots = await prisma.bot.findMany({
    where: { ...scope, archivedAt: null },
    select: {
      id: true,
      name: true,
      title: true,
      description: true,
      modelProvider: true,
      modelId: true,
      thinkingLevel: true,
      skills: { select: { skillKey: true, enabled: true } },
      mcpServers: {
        select: {
          serverId: true,
          allowAllTools: true,
          allowedTools: true,
          server: { select: { name: true, enabled: true } },
        },
      },
    },
  });
  return { ok: true, profiles: bots };
}

export async function loadBotProfile(
  prisma: PrismaClient,
  scope: Scope,
  botId: string,
  options?: {
    deployment?: { provider: string; model: string } | null;
    resolveConnectionThinkingLevel?: ProfileConnectionThinkingResolver;
    inheritFrom?: { botId: string; model?: ProfileModelSelection };
  },
) {
  const profile = await prisma.bot.findFirst({
    where: { ...scope, id: botId, archivedAt: null },
    select: {
      modelProvider: true,
      modelId: true,
      thinkingLevel: true,
      instructions: true,
      notifyOnFinish: true,
      skills: { where: scope, select: { skillKey: true, enabled: true } },
      mcpServers: {
        where: { ...scope, server: { ...scope, enabled: true } },
        select: {
          serverId: true,
          allowAllTools: true,
          allowedTools: true,
        },
      },
    },
  });
  if (!profile) throw new Error("Profile bot must belong to this owner and space");
  if (profile.modelProvider && profile.modelId && profile.thinkingLevel) {
    return {
      ...profile,
      modelProvider: profile.modelProvider,
      modelId: profile.modelId,
      thinkingLevel: profile.thinkingLevel,
    };
  }

  const hasOverride = Boolean(profile.modelProvider && profile.modelId);
  if (options?.inheritFrom) {
    // A live delegation freezes the actual turn's choices, even if defaults changed
    // since it started. Direct callers resolve the coordinator through the same path.
    const inherited: ProfileModelSelection =
      options.inheritFrom.model ??
      (await loadBotProfile(prisma, scope, options.inheritFrom.botId, {
        deployment: options.deployment,
        resolveConnectionThinkingLevel: options.resolveConnectionThinkingLevel,
      }));
    return {
      ...profile,
      modelProvider: hasOverride ? profile.modelProvider! : inherited.modelProvider,
      modelId: hasOverride ? profile.modelId! : inherited.modelId,
      thinkingLevel: profile.thinkingLevel ?? inherited.thinkingLevel,
    };
  }
  const [overrideCredential, defaultCredential, settings] = await Promise.all([
    hasOverride
      ? findModelCredential(prisma, scope, profile.modelProvider!, profile.modelId!)
      : Promise.resolve(null),
    findDefaultModelCredential(prisma, scope),
    prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
  ]);
  const selected = selectConfiguredModel({
    bot: profile,
    overrideCredential,
    defaultCredential,
    settings,
    deployment: options?.deployment ?? null,
  });
  if (!selected.provider || !selected.id) {
    throw new Error(
      "No model is configured for this profile or as the Space default: connect a provider or choose a model.",
    );
  }
  const connectionThinkingLevel =
    selected.thinkingLevel ??
    (selected.credential && options?.resolveConnectionThinkingLevel
      ? await options.resolveConnectionThinkingLevel({
          scope,
          provider: selected.provider,
          modelId: selected.id,
          credential: selected.credential,
        })
      : null);
  return {
    ...profile,
    modelProvider: selected.provider,
    modelId: selected.id,
    thinkingLevel: connectionThinkingLevel ?? DEFAULT_THINKING_LEVEL,
  };
}

export async function applyBotProfile(
  prisma: PrismaClient,
  scope: Scope,
  botId: string,
  profile: Awaited<ReturnType<typeof loadBotProfile>>,
) {
  // The child cannot run before this transaction completes. Retries do not widen
  // an MCP allowlist and never copy credentials into the bot or its instructions.
  await prisma.$transaction(async (tx) => {
    await tx.bot.update({
      where: { id: botId },
      data: {
        modelProvider: profile.modelProvider,
        modelId: profile.modelId,
        thinkingLevel: profile.thinkingLevel,
        notifyOnFinish: profile.notifyOnFinish,
      },
    });
    for (const skill of profile.skills) {
      await tx.botSkill.upsert({
        where: { botId_skillKey: { botId, skillKey: skill.skillKey } },
        create: { ...scope, botId, ...skill },
        update: { enabled: skill.enabled },
      });
    }
    for (const server of profile.mcpServers) {
      const data = { ...server, allowedTools: server.allowedTools as Prisma.InputJsonValue };
      await tx.botMcpServer.upsert({
        where: { botId_serverId: { botId, serverId: server.serverId } },
        create: { ...scope, botId, ...data },
        update: data,
      });
    }
  });
}
