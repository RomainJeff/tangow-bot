import { Trans, useLingui } from "@lingui/react/macro";
import type { SpaceDecisionConfig } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";

const DECISION_PROVIDER = "openrouter";

/** Space decision provider: lets bots delegate multi-step page tasks to browser_run. */
export function DecisionModelSettingsPanel({
  onBusyChange,
}: {
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const apiKeyId = useId();
  const baseUrlId = useId();
  const modelId = useId();
  const [config, setConfig] = useState<SpaceDecisionConfig | null | undefined>(undefined);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [pending, setPending] = useState<"connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = pending !== null;

  useEffect(() => {
    let cancelled = false;
    rpc.decision
      .providerConfig()
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setConfig(null);
        setError(err instanceof Error ? err.message : t`Could not load decision model settings`);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  function markPending(next: "connect" | "disconnect" | null) {
    setPending(next);
    onBusyChange?.(next !== null);
  }

  async function connect() {
    setError(null);
    markPending("connect");
    try {
      const next = await rpc.decision.connectProvider({
        provider: DECISION_PROVIDER,
        settings: {
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...(model.trim() ? { modelId: model.trim() } : {}),
        },
        credentials: { apiKey: apiKey.trim() },
      });
      setConfig(next);
      setApiKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not connect OpenRouter`);
    } finally {
      markPending(null);
    }
  }

  async function disconnect() {
    setError(null);
    markPending("disconnect");
    try {
      await rpc.decision.disconnectProvider();
      setConfig(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not disconnect OpenRouter`);
    } finally {
      markPending(null);
    }
  }

  return (
    <div
      data-testid="decision-model-settings"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <p className="px-6 pt-1 text-reasoning text-muted-foreground sm:px-8">
        <Trans>Let bots complete multi-step web page tasks faster.</Trans>
      </p>
      <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
        {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
        {config === undefined ? null : config ? (
          <div className="rounded-card border border-border bg-surface px-4 py-3">
            <div className="text-label text-muted-foreground">
              <Trans>Connected</Trans>
            </div>
            <div className="mt-1 text-row-name text-foreground">
              {config.settings.baseUrl ? `OpenRouter (${config.settings.baseUrl})` : "OpenRouter"}
            </div>
            <Button
              type="button"
              variant="quickReply"
              size="quickReply"
              disabled={busy}
              onClick={() => void disconnect()}
              className="mt-3"
            >
              {pending === "disconnect" ? <Trans>Disconnecting…</Trans> : <Trans>Disconnect</Trans>}
            </Button>
          </div>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor={apiKeyId}>
                <Trans>OpenRouter API key</Trans>
              </FieldLabel>
              <Input
                id={apiKeyId}
                value={apiKey}
                disabled={busy}
                onChange={(event) => setApiKey(event.target.value)}
                type="password"
                autoComplete="new-password"
              />
            </Field>
            <details className="group mt-4 rounded-card border border-border">
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-sm text-foreground">
                <span>
                  <Trans>Advanced</Trans>
                </span>
                <span
                  aria-hidden="true"
                  className="text-muted-foreground transition-transform group-open:rotate-90"
                >
                  ›
                </span>
              </summary>
              <div className="space-y-4 border-t border-border p-3">
                <Field>
                  <FieldLabel htmlFor={baseUrlId}>
                    <Trans>Base URL</Trans>
                  </FieldLabel>
                  <Input
                    id={baseUrlId}
                    value={baseUrl}
                    disabled={busy}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://openrouter.ai"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={modelId}>
                    <Trans>Model</Trans>
                  </FieldLabel>
                  <Input
                    id={modelId}
                    value={model}
                    disabled={busy}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="typesafe/jev-1.13"
                  />
                </Field>
              </div>
            </details>
            <Button
              type="button"
              variant="capsuleSecondary"
              size="capsule"
              className="mt-5"
              disabled={busy || !apiKey.trim()}
              onClick={() => void connect()}
            >
              {pending === "connect" ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
