import { t } from "@lingui/core/macro";
import type { ThinkingLevel, VoiceInfo } from "@rakazo/contracts";
import {
  type ModelCatalog as CoreModelCatalog,
  connectedModelOptions,
  parseModelOptionKey,
} from "@rakazo/core";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

export type ModelCatalog = CoreModelCatalog & {
  /** False until the catalog loaded: a thinking level is only cleared once its options are known. */
  ready: boolean;
};

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
