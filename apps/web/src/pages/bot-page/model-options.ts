import { t } from "@lingui/core/macro";
import type {
  Bot,
  Me,
  ModelCatalogEntry,
  ModelCredential,
  ThinkingLevel,
  VoiceInfo,
} from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

/** A model a bot can run, keyed `provider::modelId` so one picker value names both. */
export type ModelOption = { key: string; provider: string; modelId: string; label: string };

/** What a bot's model choice is read against: the connections, the catalog and the space default. */
export type ModelCatalog = {
  credentials: ModelCredential[];
  catalog: ModelCatalogEntry[];
  me: Me | null;
  /** False until the catalog loaded: a thinking level is only cleared once its options are known. */
  ready: boolean;
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

export function thinkingLevelLabel(level: ThinkingLevel): string {
  if (level === "xhigh") return t`Extra high`;
  if (level === "low") return t`Low`;
  if (level === "medium") return t`Medium`;
  if (level === "high") return t`High`;
  if (level === "minimal") return t`Minimal`;
  if (level === "max") return t`Max`;
  return `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;
}

/** How the Model row names what a bot runs. */
export function modelSummary(catalog: ModelCatalog, modelKey: string): string {
  const selected = modelKey ? parseModelOptionKey(modelKey) : null;
  if (!selected) return t`Space default`;
  return (
    connectedModelOptions(catalog.credentials, catalog.catalog).find(
      (option) => option.key === modelKey,
    )?.label ?? selected.modelId
  );
}

export function useModelCatalog(): ModelCatalog {
  const [state, setState] = useState<ModelCatalog>({
    credentials: [],
    catalog: [],
    me: null,
    ready: false,
  });
  useEffect(() => {
    let cancelled = false;
    void Promise.all([rpc.models.credentials(), rpc.models.list(), rpc.me()])
      .then(([credentials, catalog, me]) => {
        if (!cancelled) setState({ credentials, catalog, me, ready: true });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export function useVoices(): VoiceInfo[] {
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    void rpc.voice
      .voices({})
      .then((list) => {
        if (!cancelled) setVoices(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return voices;
}
