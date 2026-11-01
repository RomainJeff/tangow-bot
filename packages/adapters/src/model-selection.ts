import type { Actor, ModelCategory, RunModelDecision } from "@rakazo/contracts";
import { ThinkingLevelSchema } from "@rakazo/contracts";
import { MODEL_PROVIDER_NOT_CONNECTED_MESSAGE, UNKNOWN_MODEL_MESSAGE } from "@rakazo/core";
import type { findDefaultModelCredential, PrismaClient } from "@rakazo/db";
import { findModelCredential } from "@rakazo/db";
import { modelAcceptsImageInput } from "./model-vision.js";
import { listPiCatalog, scriptedCatalogEntry } from "./pi-models.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";

type ModelCredential = Awaited<ReturnType<typeof findDefaultModelCredential>>;

export function isCatalogModelChoice(provider: string, modelId: string) {
  return [...listPiCatalog(), scriptedCatalogEntry].some(
    (item) => item.provider === provider && item.id === modelId,
  );
}

export async function validateConnectedModelChoice(
  prisma: PrismaClient,
  actor: Pick<Actor, "userId" | "spaceId">,
  provider: string,
  modelId: string,
) {
  const credential = await findModelCredential(prisma, actor, provider);
  if (!credential) return MODEL_PROVIDER_NOT_CONNECTED_MESSAGE;
  if (isCatalogModelChoice(provider, modelId)) return undefined;
  // Free-form saved IDs only resolve at runtime for openai-compatible connections.
  if (provider !== OPENAI_COMPATIBLE_PROVIDER_ID) {
    return UNKNOWN_MODEL_MESSAGE;
  }
  const savedChoice = await prisma.spaceModelPreference.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      modelId,
      credential: { userId: actor.userId, provider },
    },
    select: { id: true },
  });
  return savedChoice ? undefined : UNKNOWN_MODEL_MESSAGE;
}

export type ModelRouteClassification =
  | { category: ModelCategory; fallback?: never }
  | { category?: never; fallback: "no_decision_provider" | "decision_failed" };

export type ModelRouteInput = {
  bot: {
    modelProvider: string | null;
    modelId: string | null;
    thinkingLevel: string | null;
  } | null;
  overrideCredential: ModelCredential;
  defaultCredential: ModelCredential;
  settings: { defaultModelProvider: string | null; defaultModelId: string | null } | null;
  deployment: { provider: string; model: string } | null;
  routing:
    | { mode: "fixed" }
    | { mode: "auto"; classification: ModelRouteClassification }
    | { mode: "category"; category: ModelCategory };
  categories?: Array<{
    category: ModelCategory;
    modelId: string;
    thinkingLevel: RunModelDecision["thinkingLevel"];
    credential: NonNullable<ModelCredential>;
    acceptsImages?: boolean;
  }>;
  hasImages?: boolean;
  defaultAcceptsImages?: boolean;
};

/** Inputs contain only authorized connections; missing configuration remains an explicit failure. */
export function routeModel(
  input: ModelRouteInput,
): { decision: RunModelDecision; credential: ModelCredential } | null {
  const { bot, overrideCredential, defaultCredential, settings, deployment, routing } = input;
  const hasOverride = routing.mode !== "category" && Boolean(bot?.modelProvider && bot.modelId);
  const thinkingLevel = ThinkingLevelSchema.nullable().parse(bot?.thinkingLevel ?? null);
  if (routing.mode !== "category" && bot?.modelProvider && bot.modelId && overrideCredential) {
    return {
      decision: { mode: "fixed", provider: bot.modelProvider, modelId: bot.modelId, thinkingLevel },
      credential: overrideCredential,
    };
  }
  const mode = hasOverride ? "fixed" : routing.mode;
  const requestedCategory =
    routing.mode === "category"
      ? routing.category
      : routing.mode === "auto"
        ? routing.classification.category
        : undefined;
  let fallback: RunModelDecision["fallback"] =
    mode === "auto" && routing.mode === "auto" ? routing.classification.fallback : undefined;
  const compatible = (provider: string, modelId: string, acceptsImages?: boolean) =>
    !input.hasImages || modelAcceptsImageInput(provider, modelId, acceptsImages);
  if (mode !== "fixed") {
    for (const category of new Set([requestedCategory, "everyday"])) {
      if (!category) continue;
      const assignment = input.categories?.find((item) => item.category === category);
      if (!assignment) {
        fallback ??= "category_unassigned";
        continue;
      }
      if (
        !compatible(assignment.credential.provider, assignment.modelId, assignment.acceptsImages)
      ) {
        fallback = "capability_mismatch";
        continue;
      }
      return {
        decision: {
          mode,
          requestedCategory,
          category: assignment.category,
          provider: assignment.credential.provider,
          modelId: assignment.modelId,
          thinkingLevel: assignment.thinkingLevel ?? null,
          ...(fallback ? { fallback } : {}),
        },
        credential: assignment.credential,
      };
    }
  }
  const provider =
    defaultCredential?.provider ?? settings?.defaultModelProvider ?? deployment?.provider;
  const modelId = defaultCredential?.defaultModel ?? settings?.defaultModelId ?? deployment?.model;
  if (
    !provider ||
    !modelId ||
    (mode !== "fixed" && !compatible(provider, modelId, input.defaultAcceptsImages))
  )
    return null;
  return {
    decision: {
      mode,
      ...(mode !== "fixed" ? { requestedCategory, ...(fallback ? { fallback } : {}) } : {}),
      provider,
      modelId,
      thinkingLevel: hasOverride ? null : thinkingLevel,
    },
    credential: defaultCredential,
  };
}
