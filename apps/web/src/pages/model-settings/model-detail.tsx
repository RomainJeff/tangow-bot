import { Trans, useLingui } from "@lingui/react/macro";
import type { ThinkingLevel } from "@rakazo/contracts";
import {
  Button,
  Input,
  ModelThinkingOptions,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { ModelPicker } from "./model-picker";
import { SubscriptionSignIn } from "./subscription-sign-in";
import type { ModelSettings } from "./use-model-settings";

export function ModelDetail({ settings }: { settings: ModelSettings }) {
  const { t } = useLingui();
  const {
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
    loading,
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
  } = settings;

  return (
    <div ref={detailScrollRef} className="rk-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="mb-4 text-sm text-success">{notice}</p> : null}
      {selected ? (
        <>
          <div className="block text-[13.5px] text-muted-foreground">
            {isOpenAiCompatible ? (
              <>
                <label className="block" htmlFor="model-base-url">
                  <Trans>Server URL</Trans>
                  <Input
                    id="model-base-url"
                    value={baseUrl}
                    onChange={(event) => updateBaseUrl(event.target.value)}
                    aria-label={t`OpenAI-compatible server URL`}
                    placeholder="http://127.0.0.1:8000/v1"
                    autoComplete="off"
                    className="mt-2 h-10 text-foreground"
                  />
                </label>
                <details className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
                  <summary className="w-fit cursor-pointer select-none">
                    <Trans>Setup help</Trans>
                  </summary>
                  <p className="mt-1">
                    {t`Paste the OpenAI-compatible address from your server. Rakazo adds /v1 if needed.`}
                  </p>
                </details>
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || probing || !effectiveBaseUrl}
                    onClick={() => void probeServerModels()}
                  >
                    {probing ? <Trans>Finding…</Trans> : <Trans>Find models</Trans>}
                  </Button>
                </div>
                <div className="mt-4 block">
                  <span>
                    <Trans>Model</Trans>
                  </span>
                  {probeModels.length && probeModels.includes(modelId) ? (
                    <NativeSelect
                      className="mt-2 w-full text-foreground"
                      value={modelId}
                      onChange={(event) => {
                        cancelOAuthAttempt();
                        selectionRevisionRef.current += 1;
                        setModelId(event.target.value);
                        setError(null);
                        setNotice(null);
                      }}
                      aria-label={t`Models from server`}
                    >
                      {probeModels.map((id) => (
                        <NativeSelectOption key={id} value={id}>
                          {id}
                        </NativeSelectOption>
                      ))}
                      <NativeSelectOption value="">
                        <Trans>Other model…</Trans>
                      </NativeSelectOption>
                    </NativeSelect>
                  ) : (
                    <Input
                      value={modelId}
                      onChange={(event) => {
                        cancelOAuthAttempt();
                        selectionRevisionRef.current += 1;
                        setModelId(event.target.value);
                        setError(null);
                        setNotice(null);
                      }}
                      aria-label={t`Model id`}
                      placeholder="exact-model-id"
                      className="mt-2 h-10 text-foreground"
                    />
                  )}
                  {probeModels.length && !probeModels.includes(modelId) ? (
                    <Button
                      type="button"
                      variant="link"
                      className="mt-2 h-auto px-0 text-[13px] text-muted-foreground underline"
                      onClick={() => setModelId(probeModels[0] ?? "")}
                    >
                      <Trans>Use a found model</Trans>
                    </Button>
                  ) : null}
                </div>
                <ModelThinkingOptions
                  reasoning={reasoning}
                  onReasoningChange={(value) => {
                    selectionRevisionRef.current += 1;
                    setReasoning(value);
                    if (!value) setThinkingLevel(null);
                    setNotice(null);
                  }}
                  disabled={busy}
                  advancedLabel={t`Advanced`}
                  thinkingLabel={t`Supports thinking`}
                  thinkingLevel={thinkingLevel}
                  onThinkingLevelChange={(value) => {
                    selectionRevisionRef.current += 1;
                    setThinkingLevel(value as ThinkingLevel | null);
                    setNotice(null);
                  }}
                  thinkingLevelOptions={[
                    { value: "minimal", label: t`Minimal` },
                    { value: "low", label: t`Low` },
                    { value: "medium", label: t`Medium` },
                    { value: "high", label: t`High` },
                    { value: "xhigh", label: t`Extra high` },
                    { value: "max", label: t`Max` },
                  ]}
                  thinkingLevelLabel={t`Reasoning effort`}
                  thinkingLevelDefaultLabel={t`Default`}
                  maxTokens={maxTokens}
                  onMaxTokensChange={(value) => {
                    selectionRevisionRef.current += 1;
                    setMaxTokens(value);
                    setNotice(null);
                  }}
                  maxTokensLabel={t`Maximum output tokens`}
                  contextWindow={contextWindow}
                  onContextWindowChange={(value) => {
                    selectionRevisionRef.current += 1;
                    setContextWindow(value);
                    setNotice(null);
                  }}
                  contextWindowLabel={t`Context limit`}
                  supportsImages={supportsImages}
                  onSupportsImagesChange={(value) => {
                    selectionRevisionRef.current += 1;
                    setSupportsImages(value);
                    setNotice(null);
                  }}
                  imagesLabel={t`Supports images`}
                  maxImagesPerPrompt={maxImagesPerPrompt}
                  onMaxImagesPerPromptChange={(value) => {
                    selectionRevisionRef.current += 1;
                    setMaxImagesPerPrompt(value);
                    setNotice(null);
                  }}
                  maxImagesLabel={t`Maximum images per request`}
                />
              </>
            ) : (
              <>
                <span>
                  <Trans>Model</Trans>
                </span>
                <ModelPicker
                  options={modelsForProvider}
                  value={selected.id}
                  onChange={(nextModelId) => {
                    cancelOAuthAttempt();
                    selectionRevisionRef.current += 1;
                    setModelId(nextModelId);
                    setError(null);
                    setNotice(null);
                  }}
                />
              </>
            )}
          </div>
          {!isOpenAiCompatible && selected.billing ? (
            <p className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
              {selected.billing}
            </p>
          ) : null}

          {!isOpenAiCompatible ? (
            <div className="mt-5 rounded-card bg-group shadow-group px-4 py-3">
              <div className="text-[12.5px] uppercase tracking-[0.08em] text-muted-foreground/80">
                <Trans>Personal credential</Trans>
              </div>
              <div className="mt-1 text-[15px] text-foreground">
                {credential ? (
                  <Trans>Connected · {credential.label}</Trans>
                ) : (
                  <Trans>Not connected</Trans>
                )}
              </div>
              <div className="mt-1 text-[13px] text-muted-foreground">
                {credential ? (
                  <Trans>Stored securely. Never shown here.</Trans>
                ) : (
                  <Trans>Connect this provider to use it as your personal model.</Trans>
                )}
              </div>
            </div>
          ) : null}

          {subscriptionSignIn ? (
            <SubscriptionSignIn
              oauth={oauth}
              pasteCode={pasteCode}
              setPasteCode={setPasteCode}
              submitOAuthCode={submitOAuthCode}
              busy={busy}
              oauthPending={oauthPending}
              oauthLabel={selected.oauthLabel}
              beginSelectedSubscriptionSignIn={beginSelectedSubscriptionSignIn}
            />
          ) : null}

          {acceptsKey ? (
            <div className="mt-5">
              {isOpenAiCompatible ? (
                <details className="text-[13.5px] text-muted-foreground">
                  <summary className="w-fit cursor-pointer select-none">
                    <Trans>API key</Trans>
                  </summary>
                  <Input
                    aria-label={t`API key`}
                    value={apiKey}
                    onChange={(event) => updateApiKey(event.target.value)}
                    placeholder={t`Optional`}
                    type="password"
                    autoComplete="new-password"
                    className="mt-2 h-10 text-foreground"
                  />
                </details>
              ) : (
                <label
                  className="block text-[13.5px] text-muted-foreground"
                  htmlFor="model-api-key"
                >
                  {credential ? (
                    <Trans>Replace API key</Trans>
                  ) : subscriptionSignIn ? (
                    <Trans>Or connect an API key</Trans>
                  ) : (
                    <Trans>API key</Trans>
                  )}
                  <Input
                    id="model-api-key"
                    value={apiKey}
                    onChange={(event) => updateApiKey(event.target.value)}
                    placeholder="sk-…"
                    type="password"
                    autoComplete="new-password"
                    className="mt-2 h-10 text-foreground"
                  />
                </label>
              )}
              <Button
                type="button"
                variant="secondary"
                className="mt-3 rounded-full"
                size="sm"
                disabled={
                  busy || (isOpenAiCompatible ? !openAiCompatibleReady : apiKey.trim().length < 8)
                }
                onClick={() => void connectKey()}
              >
                {pending === "connect" ? (
                  <Trans>Saving…</Trans>
                ) : isOpenAiCompatible ? (
                  <Trans>Save</Trans>
                ) : credential ? (
                  <Trans>Replace API key</Trans>
                ) : (
                  <Trans>Connect API key</Trans>
                )}
              </Button>
            </div>
          ) : null}

          {selected.auth === "oauth" && !subscriptionSignIn ? (
            <p className="mt-5 text-sm leading-[1.5] text-muted-foreground">
              <Trans>
                This subscription sign-in is not available in Rakazo yet. Use a deployment
                credential or choose another provider.
              </Trans>
            </p>
          ) : null}

          {/* A compatible server's model lives only in the space preference, so it can be switched here. */}
          {isOpenAiCompatible && credential && !isActive ? (
            <div className="mt-6">
              <Button
                type="button"
                variant="secondary"
                className="rounded-full"
                size="sm"
                disabled={busy || !modelId.trim()}
                onClick={() => void setModelDefault()}
              >
                {pending === "default" ? <Trans>Switching…</Trans> : <Trans>Use this model</Trans>}
              </Button>
            </div>
          ) : null}
        </>
      ) : loading ? (
        <p className="text-muted-foreground">
          <Trans>Loading model catalog…</Trans>
        </p>
      ) : (
        <p className="text-muted-foreground">
          <Trans>No model catalog is available.</Trans>
        </p>
      )}
    </div>
  );
}
