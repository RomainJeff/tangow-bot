import { useLingui } from "@lingui/react/macro";
import type { Me, ThinkingLevel } from "@tangow/contracts";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  openAiCompatibleProbeSuccessMessage,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
} from "@tangow/contracts";
import { createModelProbe, initialModelProbeState } from "@tangow/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelCatalogEntry, ModelCredential } from "../../lib/model-auth";
import { rpc } from "../../lib/rpc";
import { useModelOAuthSignIn } from "../../lib/use-model-oauth-signin";

export function useModelSettings() {
  const { t } = useLingui();
  const [routing, setRouting] = useState<Awaited<ReturnType<typeof rpc.models.routing>>>({
    auto: false,
    categories: [],
  });
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [provider, setProvider] = useState("");
  const [providerQuery, setProviderQuery] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [reasoning, setReasoning] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MODEL_MAX_TOKENS));
  const [contextWindow, setContextWindow] = useState(String(DEFAULT_MODEL_CONTEXT_WINDOW));
  const [supportsImages, setSupportsImages] = useState(false);
  const [maxImagesPerPrompt, setMaxImagesPerPrompt] = useState("");
  const [{ models: probeModels, probing }, setProbe] = useState(initialModelProbeState);
  const [modelProbe] = useState(() => createModelProbe(setProbe));
  const resetOpenAiCompatibleProbe = modelProbe.reset;
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"connect" | "default" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const detailScrollRef = useRef<HTMLDivElement>(null);
  const refreshRevisionRef = useRef(0);
  const selectionRevisionRef = useRef(0);
  const selectedLabelRef = useRef<string | undefined>(undefined);

  const {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    cancelOAuthAttempt,
    startSubscriptionSignIn,
    submitOAuthCode,
  } = useModelOAuthSignIn({
    onClearError: () => setError(null),
    onError: setError,
    onFinished: async (controller) => {
      await refresh();
      if (controller.signal.aborted) return;
      setNotice(t`Connected and using ${selectedLabelRef.current ?? "this model"}.`);
    },
  });

  async function refresh() {
    const refreshRevision = ++refreshRevisionRef.current;
    const selectionRevision = selectionRevisionRef.current;
    const [nextCatalog, nextCredentials, nextMe, nextRouting] = await Promise.all([
      rpc.models.list(),
      rpc.models.credentials(),
      rpc.me(),
      rpc.models.routing(),
    ]);
    if (refreshRevision !== refreshRevisionRef.current) return;
    const nextProvider =
      provider && nextCatalog.some((entry) => entry.provider === provider)
        ? provider
        : (nextMe.defaultProvider ?? nextCatalog[0]?.provider ?? "");
    const nextCredential = nextCredentials.find((entry) => entry.provider === nextProvider);
    const nextModel =
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? (nextCredential?.modelId ??
          (nextMe.defaultProvider === OPENAI_COMPATIBLE_PROVIDER_ID ? nextMe.defaultModel : "") ??
          "")
        : (nextCatalog.find((entry) => entry.provider === nextProvider && entry.id === modelId)
            ?.id ??
          nextCatalog.find(
            (entry) => entry.provider === nextProvider && entry.id === nextMe.defaultModel,
          )?.id ??
          nextCatalog.find((entry) => entry.provider === nextProvider)?.id ??
          "");
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    setMe(nextMe);
    setRouting(nextRouting);
    if (selectionRevision === selectionRevisionRef.current) {
      resetOpenAiCompatibleProbe();
      setProvider(nextProvider);
      setModelId(nextModel);
      if (nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID) {
        setBaseUrl(nextCredential?.baseUrl ?? "");
        setReasoning(nextCredential?.reasoning ?? false);
        setThinkingLevel(nextCredential?.thinkingLevel ?? null);
        setMaxTokens(String(nextCredential?.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS));
        setContextWindow(String(nextCredential?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW));
        setSupportsImages(nextCredential?.supportsImages ?? false);
        setMaxImagesPerPrompt(String(nextCredential?.maxImagesPerPrompt ?? ""));
      }
    }
  }

  useEffect(() => {
    void refresh()
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t`Could not load model settings`),
      )
      .finally(() => setLoading(false));
    return () => {
      refreshRevisionRef.current += 1;
      modelProbe.invalidate();
    };
  }, []);

  const groups = useMemo(() => {
    const grouped = new Map<string, ModelCatalogEntry[]>();
    for (const entry of catalog) {
      const entries = grouped.get(entry.provider) ?? [];
      entries.push(entry);
      grouped.set(entry.provider, entries);
    }
    return [...grouped].map(([id, entries]) => ({
      id,
      name: entries[0]?.providerName ?? id,
      entries,
    }));
  }, [catalog]);
  const filteredGroups = useMemo(() => {
    const query = providerQuery.trim().toLowerCase();
    if (!query) return groups;
    return groups.filter((group) =>
      [group.id, group.name, ...group.entries.flatMap((entry) => [entry.id, entry.label])]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [groups, providerQuery]);
  const modelsForProvider = catalog.filter((entry) => entry.provider === provider);
  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  selectedLabelRef.current = selected?.label;
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const credential = credentials.find((entry) => entry.provider === provider);
  const currentEntry = catalog.find(
    (entry) => entry.provider === me?.defaultProvider && entry.id === me?.defaultModel,
  );
  const isActive =
    !routing.auto &&
    me?.defaultProvider === selected?.provider &&
    me?.defaultModel === (isOpenAiCompatible ? modelId.trim() : selected?.id);
  const acceptsKey = selected?.auth !== "oauth";
  const subscriptionSignIn = selected?.signIn !== undefined;
  const busy = pending !== null || oauthPending;
  const effectiveBaseUrl = baseUrl.trim();
  const openAiCompatibleReady = openAiCompatibleConnectReady({
    baseUrl: effectiveBaseUrl,
    modelId,
  });

  function updateBaseUrl(nextBaseUrl: string) {
    setBaseUrl(nextBaseUrl);
    resetOpenAiCompatibleProbe();
    setError(null);
    setNotice(null);
  }

  function updateApiKey(nextApiKey: string) {
    setApiKey(nextApiKey);
    resetOpenAiCompatibleProbe();
  }

  function chooseProvider(nextProvider: string) {
    cancelOAuthAttempt();
    selectionRevisionRef.current += 1;
    const nextCredential = credentials.find((entry) => entry.provider === nextProvider);
    setProvider(nextProvider);
    setReasoning(nextCredential?.reasoning ?? false);
    setThinkingLevel(nextCredential?.thinkingLevel ?? null);
    setMaxTokens(String(nextCredential?.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS));
    setContextWindow(String(nextCredential?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW));
    setSupportsImages(nextCredential?.supportsImages ?? false);
    setMaxImagesPerPrompt(String(nextCredential?.maxImagesPerPrompt ?? ""));
    setModelId(
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? (nextCredential?.modelId ?? "")
        : (catalog.find((entry) => entry.provider === nextProvider)?.id ?? ""),
    );
    setBaseUrl(
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID ? (nextCredential?.baseUrl ?? "") : "",
    );
    detailScrollRef.current?.scrollTo({ top: 0 });
    setApiKey("");
    resetOpenAiCompatibleProbe();
    setError(null);
    setNotice(null);
  }

  async function probeServerModels() {
    if (!baseUrl.trim()) return;
    setError(null);
    setNotice(null);
    await modelProbe.probe({
      baseUrl,
      apiKey,
      request: rpc.models.probeOpenAiCompatible,
      onSuccess: (models) => {
        setModelId((current) => current.trim() || models[0] || "");
        setNotice(openAiCompatibleProbeSuccessMessage(models.length));
      },
      onError: (err) =>
        setError(err instanceof Error ? err.message : t`Could not reach this model server`),
    });
  }

  async function setModelDefault() {
    if (!selected || !credential) return;
    const activeModelId = isOpenAiCompatible ? modelId.trim() : selected.id;
    if (isOpenAiCompatible && !activeModelId) return;
    setError(null);
    setNotice(null);
    setPending("default");
    try {
      await rpc.models.setAuto({ enabled: false });
      await rpc.models.setDefault({ provider: selected.provider, modelId: activeModelId });
      await refresh();
      setNotice(isOpenAiCompatible ? t`Model updated.` : t`Now using ${selected.label}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not change the default model`);
    } finally {
      setPending(null);
    }
  }

  async function connectKey() {
    if (!selected) return;
    if (isOpenAiCompatible) {
      if (!effectiveBaseUrl || !modelId.trim()) return;
    } else if (!apiKey.trim()) {
      return;
    }
    const parsedMaxImagesPerPrompt = parseModelMaxImagesPerPrompt(
      maxImagesPerPrompt,
      supportsImages,
    );
    if (supportsImages && maxImagesPerPrompt.trim() && parsedMaxImagesPerPrompt === undefined) {
      setError(t`Enter a whole number from 1 to 1000 for the image limit.`);
      return;
    }
    const maxImagesPerPromptInput =
      supportsImages && !maxImagesPerPrompt.trim() ? null : parsedMaxImagesPerPrompt;

    const parsedMaxTokens = parseModelMaxTokens(maxTokens);
    if (parsedMaxTokens === undefined) {
      setError(
        t`Enter a whole number from 1 to ${MAX_MODEL_MAX_TOKENS} for maximum output tokens.`,
      );
      return;
    }
    const parsedContextWindow = parseModelContextWindow(contextWindow);
    if (parsedContextWindow === undefined) {
      setError(
        t`Enter a whole number from 1 to ${MAX_MODEL_CONTEXT_WINDOW} for the context limit.`,
      );
      return;
    }
    setError(null);
    setNotice(null);
    setPending("connect");
    try {
      await rpc.models.connect(
        isOpenAiCompatible
          ? {
              provider: selected.provider,
              baseUrl: effectiveBaseUrl,
              modelId: modelId.trim(),
              reasoning,
              thinkingLevel: reasoning ? thinkingLevel : null,
              maxTokens: parsedMaxTokens,
              contextWindow: parsedContextWindow,
              supportsImages,
              maxImagesPerPrompt: maxImagesPerPromptInput,
              apiKey: apiKey.trim() || undefined,
              label: selected.providerName ?? selected.provider,
            }
          : {
              provider: selected.provider,
              apiKey: apiKey.trim(),
              modelId: selected.id,
              label: selected.providerName ?? selected.provider,
            },
      );
      setApiKey("");
      await refresh();
      detailScrollRef.current?.scrollTo({ top: 0 });
      setNotice(isOpenAiCompatible ? t`Saved.` : t`Connected and using ${selected.label}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not connect this provider`);
    } finally {
      setPending(null);
    }
  }

  function beginSelectedSubscriptionSignIn() {
    if (!selected) return;
    setNotice(null);
    void startSubscriptionSignIn({
      provider: selected.provider,
      modelId: selected.id,
      label: selected.providerName ?? selected.provider,
    });
  }

  return {
    routing,
    catalog,
    refresh,
    loading,
    me,
    currentEntry,
    providerQuery,
    setProviderQuery,
    filteredGroups,
    credentials,
    provider,
    chooseProvider,
    detailScrollRef,
    error,
    setError,
    notice,
    setNotice,
    selected,
    modelsForProvider,
    isOpenAiCompatible,
    credential,
    isActive,
    acceptsKey,
    subscriptionSignIn,
    busy,
    pending,
    baseUrl,
    updateBaseUrl,
    effectiveBaseUrl,
    probing,
    probeModels,
    probeServerModels,
    modelId,
    setModelId,
    selectionRevisionRef,
    reasoning,
    setReasoning,
    thinkingLevel,
    setThinkingLevel,
    maxTokens,
    setMaxTokens,
    contextWindow,
    setContextWindow,
    supportsImages,
    setSupportsImages,
    maxImagesPerPrompt,
    setMaxImagesPerPrompt,
    apiKey,
    updateApiKey,
    openAiCompatibleReady,
    connectKey,
    setModelDefault,
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    cancelOAuthAttempt,
    submitOAuthCode,
    beginSelectedSubscriptionSignIn,
  };
}

export type ModelSettings = ReturnType<typeof useModelSettings>;
