import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { VoiceCatalogEntry, VoiceCredential } from "@tangow/contracts";
import { Button, Field, FieldLabel, Input } from "@tangow/ui-web";
import { useEffect, useId, useState } from "react";
import { localizedProviderHint } from "../lib/localized-provider-hint";
import { rpc } from "../lib/rpc";
import { ModelDetail } from "./model-settings/model-detail";
import { useModelSettings } from "./model-settings/use-model-settings";

/** Model and voice keys belong to the account: the same keys serve every space. */
export function ProvidersSettings({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const { t } = useLingui();
  const settings = useModelSettings();
  const { providerQuery, setProviderQuery, filteredGroups, credentials, provider, chooseProvider } =
    settings;
  const apiKeyId = useId();
  const [kind, setKind] = useState<"model" | "voice">("model");
  const [voiceCatalog, setVoiceCatalog] = useState<VoiceCatalogEntry[]>([]);
  const [voiceCredentials, setVoiceCredentials] = useState<VoiceCredential[]>([]);
  const [voiceProvider, setVoiceProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState<"connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const busy = pending !== null;

  useEffect(() => {
    return () => onBusyChange?.(false);
  }, [onBusyChange]);

  function markPending(next: "connect" | "disconnect" | null) {
    setPending(next);
    onBusyChange?.(next !== null);
  }

  async function refreshVoice() {
    const [nextCatalog, nextCredentials] = await Promise.all([
      rpc.voice.catalog(),
      rpc.voice.credentials(),
    ]);
    setVoiceCatalog(nextCatalog);
    setVoiceCredentials(nextCredentials);
  }

  useEffect(() => {
    void refreshVoice().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : t`Could not load voice settings`),
    );
  }, []);

  const query = providerQuery.trim().toLowerCase();
  const filteredVoice = query
    ? voiceCatalog.filter((entry) => [entry.id, entry.name].join(" ").toLowerCase().includes(query))
    : voiceCatalog;
  const selectedVoice = voiceCatalog.find((entry) => entry.id === voiceProvider);
  const voiceCredential = voiceCredentials.find((entry) => entry.provider === voiceProvider);

  async function connectKey() {
    if (!selectedVoice || !apiKey.trim()) return;
    setError(null);
    setNotice(null);
    markPending("connect");
    try {
      await rpc.voice.connect({ provider: selectedVoice.id, apiKey: apiKey.trim() });
      setApiKey("");
      await refreshVoice();
      setNotice(t`Connected ${selectedVoice.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not connect this voice provider`);
    } finally {
      markPending(null);
    }
  }

  async function disconnectProvider() {
    if (!voiceCredential) return;
    setError(null);
    setNotice(null);
    markPending("disconnect");
    try {
      await rpc.voice.disconnect({ provider: voiceCredential.provider });
      setApiKey("");
      await refreshVoice();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not disconnect this voice provider`);
    } finally {
      markPending(null);
    }
  }

  const rowClass = (selected: boolean) =>
    `flex w-full items-center gap-3 border-b border-border px-3.5 py-3 text-start transition-colors last:border-0 disabled:pointer-events-none disabled:opacity-50 ${
      selected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"
    }`;

  return (
    <div
      data-testid="providers-settings"
      className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-6 sm:px-8 md:flex-row md:overflow-hidden"
    >
      <div className="flex shrink-0 flex-col md:min-h-0 md:w-[310px]">
        <label className="sr-only" htmlFor="model-provider-search">
          <Trans>Search providers</Trans>
        </label>
        <Input
          id="model-provider-search"
          value={providerQuery}
          onChange={(event) => setProviderQuery(event.target.value)}
          placeholder={t`Search providers`}
          className="h-10 rounded-xl px-3.5"
        />
        <div className="rk-scroll mt-3 flex flex-col gap-3 md:min-h-0 md:flex-1 md:overflow-y-auto">
          <section aria-label={t`Models`}>
            <div className="mb-2 text-[13.5px] text-muted-foreground">
              <Trans>Models</Trans>
            </div>
            <div className="rk-scroll max-h-[240px] overflow-y-auto rounded-card bg-group shadow-group md:max-h-64">
              {filteredGroups.length ? (
                filteredGroups.map((group) => {
                  const connected = credentials.some((entry) => entry.provider === group.id);
                  return (
                    <button
                      key={group.id}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setKind("model");
                        chooseProvider(group.id);
                      }}
                      className={rowClass(kind === "model" && group.id === provider)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] text-foreground">
                          {group.name}
                        </span>
                        <span className="mt-0.5 block text-[12px] text-muted-foreground/80">
                          <Plural value={group.entries.length} one="# model" other="# models" />
                          {" · "}
                          {localizedProviderHint(group.entries[0]!)}
                        </span>
                      </span>
                      {connected ? (
                        <span className="text-[12px] text-success">
                          <Trans>Connected</Trans>
                        </span>
                      ) : null}
                    </button>
                  );
                })
              ) : (
                <p className="px-3.5 py-4 text-[13px] text-muted-foreground">
                  <Trans>No providers found.</Trans>
                </p>
              )}
            </div>
          </section>
          {filteredVoice.length ? (
            <section aria-label={t`Voice`}>
              <div className="mb-2 text-[13.5px] text-muted-foreground">
                <Trans>Voice</Trans>
              </div>
              <div className="rounded-card bg-group shadow-group">
                {filteredVoice.map((entry) => {
                  const connected = voiceCredentials.some((cred) => cred.provider === entry.id);
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        settings.cancelOAuthAttempt();
                        setKind("voice");
                        setVoiceProvider(entry.id);
                        setApiKey("");
                        setError(null);
                        setNotice(null);
                      }}
                      className={rowClass(kind === "voice" && entry.id === voiceProvider)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] text-foreground">
                          {entry.name}
                        </span>
                        <span className="mt-0.5 block text-[12px] text-muted-foreground/80">
                          {entry.transcribe ? (
                            <Trans>Speak + transcribe</Trans>
                          ) : (
                            <Trans>Speak only</Trans>
                          )}
                        </span>
                      </span>
                      {connected ? (
                        <span className="text-[12px] text-success">
                          <Trans>Connected</Trans>
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {kind === "model" ? (
        <ModelDetail settings={settings} />
      ) : (
        <div className="rk-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
          {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
          {notice ? <p className="mb-4 text-sm text-success">{notice}</p> : null}
          {selectedVoice ? (
            <>
              <Field>
                <FieldLabel htmlFor={apiKeyId}>
                  <Trans>API key</Trans>
                </FieldLabel>
                <Input
                  id={apiKeyId}
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={voiceCredential ? t`Paste a replacement key` : t`Paste your API key`}
                />
              </Field>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  disabled={busy || apiKey.trim().length < 8}
                  onClick={() => void connectKey()}
                >
                  {pending === "connect" ? (
                    <Trans>Connecting…</Trans>
                  ) : voiceCredential ? (
                    <Trans>Replace key</Trans>
                  ) : (
                    <Trans>Connect</Trans>
                  )}
                </Button>
                {voiceCredential ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void disconnectProvider()}
                  >
                    {pending === "disconnect" ? (
                      <Trans>Disconnecting…</Trans>
                    ) : (
                      <Trans>Disconnect</Trans>
                    )}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
