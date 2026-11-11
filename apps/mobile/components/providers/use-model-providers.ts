import type { ModelCategoryAssignment, ModelOAuthBegin, ThinkingLevel } from "@tangow/contracts";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
} from "@tangow/contracts";
import { createModelProbe, featuredModelProviders, initialModelProbeState } from "@tangow/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Linking } from "react-native";
import type { MobileMe, MobileModel, MobileModelCredential } from "../../lib/api";
import { rpc } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import {
  cancelModelOAuthAttempt,
  finishModelOAuthAttempt,
  waitForModelOAuth,
} from "../../lib/model-auth";

type ModelSelection = {
  provider?: string;
  modelId?: string;
};

/** Model provider keys: catalog, credentials, the picked provider's form and subscription sign-in. */
export function useModelProviders() {
  const { t } = useI18n();
  const [routing, setRouting] = useState<{ auto: boolean; categories: ModelCategoryAssignment[] }>({
    auto: false,
    categories: [],
  });
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [provider, setProvider] = useState("");
  const [showAllProviders, setShowAllProviders] = useState(false);
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [reasoning, setReasoning] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MODEL_MAX_TOKENS));
  const [contextWindow, setContextWindow] = useState(String(DEFAULT_MODEL_CONTEXT_WINDOW));
  const [supportsImages, setSupportsImages] = useState(false);
  const [maxImagesPerPrompt, setMaxImagesPerPrompt] = useState("");
  const [showEndpointHelp, setShowEndpointHelp] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [{ models: probeModels, probing }, setProbe] = useState(initialModelProbeState);
  const [modelProbe] = useState(() => createModelProbe(setProbe));
  const resetOpenAiCompatibleProbe = modelProbe.reset;
  const [oauth, setOauth] = useState<ModelOAuthBegin | null>(null);
  const [pasteCode, setPasteCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"connect" | "default" | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const oauthAbortRef = useRef<AbortController | null>(null);
  const oauthLoginIdRef = useRef<string | null>(null);
  const oauthCodeSubmittingRef = useRef(false);

  const cancelOAuth = useCallback(() => {
    const loginId = oauthLoginIdRef.current;
    oauthLoginIdRef.current = null;
    cancelModelOAuthAttempt(oauthAbortRef, () => {
      setOauth(null);
      setOauthPending(false);
    });
    if (loginId) void rpc("models/cancelOAuth", { loginId }).catch(() => undefined);
  }, []);

  const load = useCallback(async (preferred: ModelSelection = {}) => {
    setError(null);
    const [nextMe, nextCatalog, nextCredentials, nextRouting] = await Promise.all([
      rpc<MobileMe>("me"),
      rpc<MobileModel[]>("models/list"),
      rpc<MobileModelCredential[]>("models/credentials"),
      rpc<{ auto: boolean; categories: ModelCategoryAssignment[] }>("models/routing"),
    ]);
    const nextProvider =
      (preferred.provider && nextCatalog.some((entry) => entry.provider === preferred.provider)
        ? preferred.provider
        : nextMe.defaultProvider) ??
      nextCatalog[0]?.provider ??
      "";
    const nextCredential = nextCredentials.find((entry) => entry.provider === nextProvider);
    const nextModel =
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? preferred.modelId?.trim() ||
          nextCredential?.modelId ||
          (nextMe.defaultProvider === OPENAI_COMPATIBLE_PROVIDER_ID ? nextMe.defaultModel : "") ||
          ""
        : (nextCatalog.find(
            (entry) => entry.provider === nextProvider && entry.id === preferred.modelId,
          )?.id ??
          nextCatalog.find(
            (entry) => entry.provider === nextProvider && entry.id === nextMe.defaultModel,
          )?.id ??
          nextCatalog.find((entry) => entry.provider === nextProvider)?.id ??
          "");
    setMe(nextMe);
    setRouting(nextRouting);
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
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
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load()
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : t("Could not load model settings")),
        )
        .finally(() => setLoading(false));
      return () => {
        modelProbe.invalidate();
        cancelOAuth();
      };
    }, [cancelOAuth, load]),
  );

  const groups = useMemo(() => {
    const grouped = new Map<string, MobileModel[]>();
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
  const featuredProviders = useMemo(
    () =>
      featuredModelProviders(
        groups.map((group) => group.entries[0]!),
        provider,
      ),
    [groups, provider],
  );
  const visibleGroups = useMemo(() => {
    if (showAllProviders) return groups;
    const byId = new Map(groups.map((group) => [group.id, group]));
    return featuredProviders.map((entry) => byId.get(entry.provider)!);
  }, [groups, featuredProviders, showAllProviders]);
  const modelsForProvider = catalog.filter((entry) => entry.provider === provider);
  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const credential = credentials.find((entry) => entry.provider === provider);
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
    cancelOAuth();
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
      request: (input) => rpc<{ models: string[] }>("models/probeOpenAiCompatible", input),
      onSuccess: (models) => {
        setModelId((current) => current.trim() || models[0] || "");
        setNotice(
          models.length === 0
            ? t("Server found. Enter a model name.")
            : models.length === 1
              ? t("Found {count} model.", { count: 1 })
              : t("Found {count} models.", { count: models.length }),
        );
      },
      onError: (err) =>
        setError(err instanceof Error ? err.message : t("Could not reach this model server")),
    });
  }

  async function setModelDefault() {
    if (!selected || !credential) return;
    const activeModelId = modelId.trim();
    if (!activeModelId) return;
    setError(null);
    setNotice(null);
    setPending("default");
    try {
      await rpc("models/setAuto", { enabled: false });
      await rpc("models/setDefault", { provider: selected.provider, modelId: activeModelId });
      await load({ provider, modelId: activeModelId });
      setNotice(t("Model updated."));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not change the default model"));
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
      setError(t("Enter a whole number from 1 to 1000 for the image limit."));
      return;
    }
    const maxImagesPerPromptInput =
      supportsImages && !maxImagesPerPrompt.trim() ? null : parsedMaxImagesPerPrompt;

    const parsedMaxTokens = parseModelMaxTokens(maxTokens);
    if (parsedMaxTokens === undefined) {
      setError(
        t("Enter a whole number from 1 to {max} for maximum output tokens.", {
          max: MAX_MODEL_MAX_TOKENS,
        }),
      );
      return;
    }
    const parsedContextWindow = parseModelContextWindow(contextWindow);
    if (parsedContextWindow === undefined) {
      setError(
        t("Enter a whole number from 1 to {max} for the context limit.", {
          max: MAX_MODEL_CONTEXT_WINDOW,
        }),
      );
      return;
    }
    setError(null);
    setNotice(null);
    setPending("connect");
    try {
      await rpc(
        "models/connect",
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
      await load({ provider, modelId });
      setNotice(
        isOpenAiCompatible
          ? t("Saved.")
          : t("Connected and using {label}.", { label: selected.label }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not connect this provider"));
    } finally {
      setPending(null);
    }
  }

  async function finishSubscriptionSignIn(loginId: string, controller: AbortController) {
    await waitForModelOAuth(loginId, controller.signal);
    if (controller.signal.aborted) return;
    await rpc("models/finishOAuth", { loginId }, { signal: controller.signal });
    if (controller.signal.aborted) return;
    oauthLoginIdRef.current = null;
    setOauth(null);
    await load({ provider, modelId });
    if (controller.signal.aborted) return;
    setNotice(t("Connected and using {label}.", { label: selected?.label ?? t("this model") }));
  }

  async function startSubscriptionSignIn() {
    if (!selected) return;
    setError(null);
    setNotice(null);
    setOauthPending(true);
    const controller = new AbortController();
    oauthAbortRef.current = controller;
    let waitingForCode = false;
    try {
      const started = await rpc<ModelOAuthBegin>(
        "models/beginOAuth",
        {
          provider: selected.provider,
          modelId: selected.id,
          label: selected.providerName ?? selected.provider,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      oauthLoginIdRef.current = started.loginId;
      setPasteCode("");
      setOauth(started);
      await Linking.openURL(started.verificationUri);
      waitingForCode = started.mode === "auth-url";
      if (!waitingForCode) await finishSubscriptionSignIn(started.loginId, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      const loginId = oauthLoginIdRef.current;
      oauthLoginIdRef.current = null;
      if (loginId) void rpc("models/cancelOAuth", { loginId }).catch(() => undefined);
      setError(err instanceof Error ? err.message : t("Could not start sign-in"));
      setOauth(null);
    } finally {
      if (!waitingForCode) {
        finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
      }
    }
  }

  async function submitOAuthCode() {
    if (oauth?.mode !== "auth-url" || oauthCodeSubmittingRef.current) return;
    const controller = oauthAbortRef.current;
    const code = pasteCode.trim();
    if (!controller || !code) return;
    oauthCodeSubmittingRef.current = true;
    setPasteCode("");
    setError(null);
    let submitted = false;
    let retryable = false;
    try {
      await rpc(
        "models/submitOAuthCode",
        { loginId: oauth.loginId, code },
        {
          signal: controller.signal,
        },
      );
      submitted = true;
      await finishSubscriptionSignIn(oauth.loginId, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (submitted) {
        oauthLoginIdRef.current = null;
        setOauth(null);
        void rpc("models/cancelOAuth", { loginId: oauth.loginId }).catch(() => undefined);
      } else {
        retryable = true;
        setPasteCode(code);
      }
      setError(err instanceof Error ? err.message : t("Could not finish sign-in"));
    } finally {
      oauthCodeSubmittingRef.current = false;
      if (!retryable) {
        finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
      }
    }
  }

  return {
    acceptsKey,
    apiKey,
    baseUrl,
    busy,
    cancelOAuth,
    catalog,
    chooseProvider,
    connectKey,
    contextWindow,
    credential,
    credentials,
    effectiveBaseUrl,
    error,
    featuredProviders,
    groups,
    isActive,
    isOpenAiCompatible,
    loading,
    maxImagesPerPrompt,
    maxTokens,
    modelId,
    modelsForProvider,
    notice,
    oauth,
    oauthPending,
    openAiCompatibleReady,
    pasteCode,
    pending,
    probeModels,
    probeServerModels,
    probing,
    provider,
    reasoning,
    selected,
    setContextWindow,
    setError,
    setMaxImagesPerPrompt,
    setMaxTokens,
    setModelDefault,
    setModelId,
    setNotice,
    setPasteCode,
    setReasoning,
    setShowAdvanced,
    setShowAllProviders,
    setShowApiKey,
    setShowEndpointHelp,
    setSupportsImages,
    setThinkingLevel,
    showAdvanced,
    showAllProviders,
    showApiKey,
    showEndpointHelp,
    startSubscriptionSignIn,
    submitOAuthCode,
    subscriptionSignIn,
    supportsImages,
    thinkingLevel,
    updateApiKey,
    updateBaseUrl,
    visibleGroups,
  };
}
