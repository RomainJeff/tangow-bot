import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { registerLocalProvider } from "./pi-local-provider.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  registerOpenAiCompatibleCatalog,
} from "./pi-openai-compatible-provider.js";

let catalogModelsCache: Models | undefined;

function catalogModels(): Models {
  catalogModelsCache ??= registerOpenAiCompatibleCatalog(registerLocalProvider(builtinModels()));
  return catalogModelsCache;
}

/**
 * Static catalog entry for a model, or undefined when the catalog does not know it. The
 * OpenRouter retry mirrors the runtime's own provider fallback so callers describe the model
 * that will actually be called.
 */
export function catalogModel(provider: string, modelId: string): Model<Api> | undefined {
  const models = catalogModels();
  const model = models.getModel(provider, modelId);
  if (model) return model;
  if (provider === "openrouter" || provider === OPENAI_COMPATIBLE_PROVIDER_ID) return undefined;
  return models.getModel("openrouter", modelId);
}

/**
 * Context window declared by the catalog. Undefined for a model outside it, which leaves callers
 * on their own fallback rather than inventing a size.
 */
export function catalogContextWindow(provider: string, modelId: string): number | undefined {
  return catalogModel(provider, modelId)?.contextWindow;
}
