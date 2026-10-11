import type { Bot, Me, ModelCatalogEntry, ModelCredential, ThinkingLevel } from "@rakazo/contracts";

/** A model a bot can run, keyed `provider::modelId` so one picker value names both. */
export type ModelOption = { key: string; provider: string; modelId: string; label: string };

/** What a bot's model choice is read against: the connections, the catalog and the space default. */
export type ModelCatalog = {
  credentials: ModelCredential[];
  catalog: ModelCatalogEntry[];
  me: Pick<Me, "defaultProvider" | "defaultModel"> | null;
};

function modelOptionKey(provider: string, modelId: string): string {
  return `${provider}::${modelId}`;
}

export function parseModelOptionKey(key: string): { provider: string; modelId: string } | null {
  const separator = key.indexOf("::");
  if (separator <= 0) return null;
  return { provider: key.slice(0, separator), modelId: key.slice(separator + 2) };
}

/** `""` when the bot follows the space default. */
export function botModelKey(bot: Pick<Bot, "modelProvider" | "modelId">): string {
  return bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "";
}

export function catalogLabel(
  catalog: ModelCatalogEntry[],
  provider: string | null | undefined,
  modelId: string,
): string | undefined {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.label;
}

/** Every model a connection can run: a catalog provider expands to its models, a free-form one stays one pair. */
export function connectedModelOptions(
  credentials: ModelCredential[],
  catalog: ModelCatalogEntry[],
): ModelOption[] {
  const options: ModelOption[] = [];
  const seen = new Set<string>();
  for (const credential of credentials) {
    const providerModels = catalog.filter(
      (entry) => entry.provider === credential.provider && !entry.placeholder,
    );
    const credentialInCatalog = Boolean(
      credential.modelId && providerModels.some((entry) => entry.id === credential.modelId),
    );
    const candidates: ModelOption[] =
      credential.modelId && !credentialInCatalog
        ? [
            {
              key: modelOptionKey(credential.provider, credential.modelId),
              provider: credential.provider,
              modelId: credential.modelId,
              label: `${credential.label} · ${credential.modelId}`,
            },
          ]
        : providerModels.map((entry) => ({
            key: modelOptionKey(entry.provider, entry.id),
            provider: entry.provider,
            modelId: entry.id,
            label: `${entry.providerName ?? entry.provider} · ${entry.label}`,
          }));
    for (const option of candidates) {
      if (seen.has(option.key)) continue;
      seen.add(option.key);
      options.push(option);
    }
  }
  return options;
}

/** The thinking levels the model a bot would run offers, and the level it uses by default. */
export function thinkingChoices(
  { credentials, catalog, me }: ModelCatalog,
  modelKey: string,
): { levels: ThinkingLevel[]; fallback: ThinkingLevel } {
  const selected = modelKey ? parseModelOptionKey(modelKey) : null;
  const provider = selected ? selected.provider : (me?.defaultProvider ?? null);
  const modelId = selected ? selected.modelId : (me?.defaultModel ?? null);
  const entry =
    provider && modelId
      ? catalog.find((item) => item.provider === provider && item.id === modelId)
      : undefined;
  const credential = credentials.find(
    (item) => item.provider === provider && item.modelId === modelId,
  );
  const levels = (credential?.thinkingLevels ?? entry?.thinkingLevels ?? []).filter(
    (level) => level !== "off",
  );
  return { levels, fallback: credential?.thinkingLevel ?? "medium" };
}
