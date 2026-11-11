import { randomUUID } from "node:crypto";
import {
  type Api,
  type AssistantMessageEventStream,
  clampThinkingLevel,
  type Model,
  type Models,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentRunRequest } from "@tangow/adapter-kit";
import { DEFAULT_OPENROUTER_MODEL_ID } from "./deployment-model.js";
import { piProviderId } from "./model-catalog.js";
import { PiRuntimeCredentialStore, toOAuthCredential } from "./pi-credentials.js";
import { registerLocalProvider } from "./pi-local-provider.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  registerOpenAiCompatibleCatalog,
  registerOpenAiCompatibleRuntime,
} from "./pi-openai-compatible-provider.js";
import {
  MODEL_STREAM_MAX_RETRIES,
  MODEL_STREAM_TIMEOUT_MS,
  resolveCompletionMaxTokens,
} from "./pi-runtime-limits.js";

/**
 * Which pi-ai model a run's model config names, and how one call to it is made.
 */

// Built on first use, not at module load: entry points call loadRootEnv() after
// their imports, and ESM hoists those imports, so module-level env reads here
// would run before .env is loaded and miss the local provider entirely.
let catalogModelsCache: Models | undefined;
function catalogModels(): Models {
  catalogModelsCache ??= registerOpenAiCompatibleCatalog(registerLocalProvider(builtinModels()));
  return catalogModelsCache;
}

// Reasoning-capable models must not start at "off": for OpenRouter, pi-ai maps
// that to reasoning.effort "none", which 400s on endpoints that mandate
// reasoning (e.g. google/gemini-3.7-flash). Keep a real level when model.reasoning
// is set; plain models stay off.
const REASONING_MODEL_THINKING_LEVEL: ModelThinkingLevel = "medium";
export function thinkingLevelFor(
  model: Model<Api>,
  preferred?: ModelThinkingLevel | null,
): ModelThinkingLevel {
  if (!model.reasoning) return "off";
  if (preferred) return clampThinkingLevel(model, preferred);
  return clampThinkingLevel(model, REASONING_MODEL_THINKING_LEVEL);
}

function configuredOpenRouterModel(id: string): Model<"openai-completions"> {
  // A configured model can intentionally be newer than Pi's static catalog. Keep
  // pricing conservative, but enable reasoning: unknown OpenRouter endpoints
  // (e.g. gemini-3.7-flash before the snapshot catches up) often mandate it, and
  // thinkingLevel "off" becomes effort "none" which those endpoints reject.
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 4_096,
  };
}

export function resolveRuntimeModel(modelConfig: AgentRunRequest["model"]): {
  provider: string;
  modelId: string;
  models: Models;
  model: Model<Api> | undefined;
  apiKey: string | undefined;
} {
  const provider =
    modelConfig.provider === "scripted" ? "openrouter" : piProviderId(modelConfig.provider);
  const envDefaultModel = process.env.PI_DEFAULT_MODEL?.trim();
  const envDefaultProvider = process.env.PI_DEFAULT_PROVIDER?.trim() || "openrouter";
  const modelId =
    modelConfig.id === "scripted"
      ? envDefaultModel || DEFAULT_OPENROUTER_MODEL_ID
      : modelConfig.id.trim();
  const models = modelsForRequest({ model: modelConfig }, provider);
  let model = models.getModel(provider, modelId);
  if (!model && provider !== "openrouter" && provider !== OPENAI_COMPATIBLE_PROVIDER_ID) {
    model = models.getModel("openrouter", modelId);
  }
  if (
    !model &&
    provider === "openrouter" &&
    envDefaultProvider === "openrouter" &&
    modelId === envDefaultModel
  ) {
    model = configuredOpenRouterModel(modelId);
  }
  const apiKey = modelConfig.oauth
    ? undefined
    : modelConfig.provider === OPENAI_COMPATIBLE_PROVIDER_ID
      ? modelConfig.apiKey || "local"
      : // Only OpenRouter may fall back to the OpenRouter env key. Handing it to
        // another provider would ship our key to a vendor it was not issued for.
        (modelConfig.apiKey ??
        (provider === "openrouter" ? process.env.OPENROUTER_API_KEY : undefined));
  return { provider, modelId, models, model, apiKey };
}

/**
 * One model call as the runtime makes it, with the key this process holds: what a relay runs
 * for a guest that has no key. Throws for a model the catalog does not know.
 */
export function streamRunModel(
  config: AgentRunRequest["model"],
  context: TranscriptContext,
  options: { sessionId?: string; signal?: AbortSignal } = {},
): { model: Model<Api>; stream: AssistantMessageEventStream } {
  const selected = resolveRuntimeModel(config);
  if (!selected.model) throw new Error(`Unknown model ${selected.provider}/${selected.modelId}`);
  const model = modelForCompletion(selected.model, config.maxTokens);
  const thinkingLevel = thinkingLevelFor(model, config.thinkingLevel);
  const stream = selected.models.streamSimple(model, context, {
    ...reliableStreamOptions(
      model,
      { ...options, reasoning: thinkingLevel === "off" ? undefined : thinkingLevel },
      config.maxTokens,
    ),
    apiKey: selected.apiKey,
  });
  return { model, stream };
}

/** The catalog model a guest names for its own runtime. Its calls go through the relay. */
export function guestRuntimeModel(config: AgentRunRequest["model"]): Model<Api> {
  const selected = resolveRuntimeModel(config);
  if (!selected.model) throw new Error(`Unknown model ${selected.provider}/${selected.modelId}`);
  const model = modelForCompletion(selected.model, config.maxTokens);
  return config.contextWindow ? { ...model, contextWindow: config.contextWindow } : model;
}

export function modelsForRequest(
  request: Pick<AgentRunRequest, "model">,
  provider: string,
): Models {
  const oauth = request.model.oauth;
  if (oauth) {
    const persist = oauth.persist;
    return registerOpenAiCompatibleCatalog(
      registerLocalProvider(
        builtinModels({
          credentials: new PiRuntimeCredentialStore(
            provider,
            toOAuthCredential(oauth.credential),
            persist ? (next) => persist(next) : undefined,
          ),
        }),
      ),
    );
  }
  if (
    provider === OPENAI_COMPATIBLE_PROVIDER_ID &&
    request.model.baseUrl &&
    request.model.id.trim()
  ) {
    const models = registerOpenAiCompatibleCatalog(registerLocalProvider(builtinModels()));
    return registerOpenAiCompatibleRuntime(models, {
      modelId: request.model.id,
      baseUrl: request.model.baseUrl,
      reasoning: request.model.reasoning,
      acceptsImages: request.model.acceptsImages,
      maxTokens: request.model.maxTokens,
      contextWindow: request.model.contextWindow,
    });
  }
  return catalogModels();
}

export function modelForCompletion(model: Model<Api>, configuredMaxTokens?: number): Model<Api> {
  const maxTokens = resolveCompletionMaxTokens(model.maxTokens, configuredMaxTokens);
  if (maxTokens === model.maxTokens) return model;
  return { ...model, maxTokens };
}

/** Stable OpenCode affinity id for a bot conversation (and optional nested agent). */
export function conversationSessionId(threadId: string, botId: string, agentId?: string): string {
  return agentId ? `${threadId}:${botId}:${agentId}` : `${threadId}:${botId}`;
}

export function isOpenCodeProvider(provider: string): boolean {
  return provider === "opencode" || provider === "opencode-go";
}

export function reliableStreamOptions(
  model: Pick<Model<Api>, "api" | "provider" | "maxTokens">,
  options?: SimpleStreamOptions,
  configuredMaxTokens?: number,
): SimpleStreamOptions {
  let next: SimpleStreamOptions = {
    ...options,
    timeoutMs: options?.timeoutMs ?? MODEL_STREAM_TIMEOUT_MS,
    maxRetries: options?.maxRetries ?? MODEL_STREAM_MAX_RETRIES,
    maxTokens: resolveCompletionMaxTokens(model.maxTokens, configuredMaxTokens, options?.maxTokens),
  };

  if (model.provider === "openai-codex" || model.api === "openai-codex-responses") {
    // Pi cannot fall back after a WebSocket has emitted its start event. Long tool
    // runs then surface abnormal close 1006 as a terminal model error. SSE has
    // bounded network retries and no long-lived connection between tool turns.
    next = { ...next, transport: "sse" };
  }

  // OpenCode Go/Zen require a sticky x-opencode-session header (affinity + some
  // models 400 without it). Pi 0.85.1 does not attach that header on its own.
  if (isOpenCodeProvider(model.provider)) {
    const sessionId = next.sessionId?.trim() || randomUUID();
    next = {
      ...next,
      sessionId,
      headers: {
        "x-opencode-session": sessionId,
        "x-opencode-client": "rakazo",
        ...next.headers,
      },
    };
  }

  return next;
}
