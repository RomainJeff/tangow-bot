import { Trans, useLingui } from "@lingui/react/macro";
import type { VoiceCatalogEntry, VoiceCredential, VoiceInfo, VoiceStatus } from "@tangow/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
} from "@tangow/ui-web";
import { XIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { rpc } from "../lib/rpc";

export function VoiceSettingsOverlay({
  onClose,
  embedded = false,
  onBusyChange,
  onOpenProviders,
}: {
  onClose: () => void;
  /** Render panel body only for the shared Settings shell. */
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
  /** Keys are connected in the account Providers section. */
  onOpenProviders?: () => void;
}) {
  const { t } = useLingui();
  const voiceSelectId = useId();
  const [catalog, setCatalog] = useState<VoiceCatalogEntry[]>([]);
  const [credentials, setCredentials] = useState<VoiceCredential[]>([]);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"voice" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const busy = pending !== null;

  useEffect(() => {
    return () => onBusyChange?.(false);
  }, [onBusyChange]);

  function markPending(next: "voice" | "test" | null) {
    setPending(next);
    onBusyChange?.(next !== null);
  }

  async function refresh(nextProvider?: string) {
    const [nextCatalog, nextCredentials, nextStatus] = await Promise.all([
      rpc.voice.catalog(),
      rpc.voice.credentials(),
      rpc.voice.status(),
    ]);
    const selected =
      nextProvider || provider || nextStatus.provider || nextCredentials[0]?.provider || "";
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    setStatus(nextStatus);
    setProvider(selected);
    const cred = nextCredentials.find((entry) => entry.provider === selected);
    const activeVoice = cred?.voiceId ?? "";
    setVoiceId(activeVoice);
    if (cred) {
      const listed = await rpc.voice.voices({ provider: selected });
      setVoices(listed);
      if (!activeVoice && listed[0]) setVoiceId(listed[0].id);
    } else {
      setVoices([]);
    }
  }

  useEffect(() => {
    void refresh()
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t`Could not load voice settings`),
      )
      .finally(() => setLoading(false));
  }, []);

  const connectedCatalog = catalog.filter((entry) =>
    credentials.some((cred) => cred.provider === entry.id),
  );
  const selected = catalog.find((entry) => entry.id === provider);
  const credential = credentials.find((entry) => entry.provider === provider);
  const voiceOptions = useMemo(
    () => (voices.length ? voices : voiceId ? [{ id: voiceId, label: voiceId }] : []),
    [voices, voiceId],
  );

  async function chooseVoice(nextVoiceId: string) {
    setVoiceId(nextVoiceId);
    if (!credential) return;
    markPending("voice");
    setError(null);
    try {
      await rpc.voice.setVoice({ voiceId: nextVoiceId, provider: selected?.id });
      await refresh(selected?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save that voice`);
    } finally {
      markPending(null);
    }
  }

  async function testVoice() {
    setError(null);
    setNotice(null);
    markPending("test");
    try {
      const { speaker } = await import("../lib/tts.js");
      await speaker.speak(t`Hi, this is how I'll sound when I read replies out loud.`);
      if (speaker.state.error) {
        setError(speaker.state.error);
        return;
      }
      setNotice(t`If you heard that, voice is ready.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not play a test clip`);
    } finally {
      markPending(null);
    }
  }

  const body = (
    <>
      {!embedded ? (
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <DialogTitle className="text-2xl font-medium text-foreground">
              <Trans>Voice</Trans>
            </DialogTitle>
          </div>
          <DialogClose
            aria-label={t`Close voice settings`}
            disabled={busy}
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon />
          </DialogClose>
        </div>
      ) : null}

      <div className="rk-scroll flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-6 sm:px-8 md:flex-row md:overflow-hidden">
        {connectedCatalog.length > 1 ? (
          <div className="flex min-h-0 shrink-0 flex-col md:w-[280px]">
            <div className="mb-3 text-[13.5px] text-muted-foreground">
              <Trans>Providers</Trans>
            </div>
            <div className="rk-scroll rounded-card bg-group shadow-group md:overflow-y-auto">
              {connectedCatalog.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setProvider(entry.id);
                    setError(null);
                    setNotice(null);
                    markPending("voice");
                    void refresh(entry.id)
                      .catch((err: unknown) =>
                        setError(
                          err instanceof Error ? err.message : t`Could not load voice settings`,
                        ),
                      )
                      .finally(() => markPending(null));
                  }}
                  className={`flex w-full items-center gap-3 border-b border-border px-3.5 py-3 text-start transition-colors last:border-0 disabled:pointer-events-none disabled:opacity-50 ${
                    entry.id === provider ? "bg-muted" : "hover:bg-accent"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-foreground">{entry.name}</span>
                    <span className="mt-0.5 block text-[12px] text-muted-foreground/80">
                      {entry.transcribe ? (
                        <Trans>Speak + transcribe</Trans>
                      ) : (
                        <Trans>Speak only</Trans>
                      )}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="rk-scroll min-w-0 md:min-h-0 md:flex-1 md:overflow-y-auto">
          {loading ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Loading voice providers…</Trans>
            </p>
          ) : null}
          {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
          {notice ? <p className="mb-4 text-sm text-success">{notice}</p> : null}
          {!loading && !credentials.length && onOpenProviders ? (
            <Button type="button" variant="secondary" onClick={onOpenProviders}>
              <Trans>Connect a voice provider</Trans>
            </Button>
          ) : null}
          {selected && credential ? (
            <>
              <Field>
                <FieldLabel htmlFor={voiceSelectId}>
                  <Trans>Voice</Trans>
                </FieldLabel>
                <NativeSelect
                  id={voiceSelectId}
                  className="w-full"
                  value={voiceId}
                  disabled={busy}
                  onChange={(event) => void chooseVoice(event.target.value)}
                >
                  {voiceOptions.map((voice) => (
                    <NativeSelectOption key={voice.id} value={voice.id}>
                      {voice.label}
                      {voice.description ? ` · ${voice.description}` : ""}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Button
                type="button"
                variant="secondary"
                className="mt-4 rounded-full"
                disabled={busy || !status?.ready}
                onClick={() => void testVoice()}
              >
                {pending === "test" ? <Trans>Playing…</Trans> : <Trans>Hear a sample</Trans>}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </>
  );

  if (embedded) {
    return (
      <div data-testid="voice-settings" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {body}
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (busy) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogContent
        variant="window"
        data-testid="voice-settings"
        aria-describedby={undefined}
        showCloseButton={false}
        className="flex h-[min(680px,calc(100%-2rem))] w-[920px] flex-col gap-0 overflow-hidden p-0 sm:h-[min(680px,calc(100%-5rem))] sm:max-w-[calc(100%-5rem)]"
      >
        {body}
      </DialogContent>
    </Dialog>
  );
}
