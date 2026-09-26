import { Trans, useLingui } from "@lingui/react/macro";
import type { AiConsentStatus, MemoryClassifierSettings as Settings } from "@rakazo/contracts";
import { AI_DATA_DISCLOSURES } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { rpc, selectedSpaceId } from "../lib/rpc";

export function JudgmentConnectionSettings({
  onBusyChange,
}: {
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [consent, setConsent] = useState<AiConsentStatus | null>(null);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const [spaceId] = useState(selectedSpaceId);
  const options = { context: { spaceId } };
  useEffect(() => {
    let active = true;
    rpc.models.judgmentConnection
      .get(undefined, { context: { spaceId } })
      .then((value) => {
        if (!active) return;
        setSettings(value);
        setProvider(value.connection?.provider ?? value.providers[0]?.id ?? "");
        setModel(value.connection?.model ?? value.providers[0]?.defaultModel ?? "");
      })
      .catch(() => {
        if (active) setError(t`Could not load classification settings.`);
      });
    return () => {
      active = false;
    };
  }, [spaceId, t]);

  const connectedProvider = settings?.connection?.provider;
  const connectedModel = settings?.connection?.model;
  useEffect(() => {
    let active = true;
    setConsent(null);
    if (connectedProvider && connectedModel) {
      rpc.aiConsent
        .status({ uses: ["memory-classification"] }, { context: { spaceId } })
        .then((value) => {
          if (active) setConsent(value);
        })
        .catch(() => {
          if (active) setError(t`Could not load data sharing.`);
        });
    }
    return () => {
      active = false;
    };
  }, [connectedProvider, connectedModel, spaceId, t]);

  async function changeConsent(key: string, allowed: boolean) {
    if (pending.current || !consent) return;
    pending.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      if (allowed) await rpc.aiConsent.revoke({ key }, options);
      else
        await rpc.aiConsent.allow(
          {
            scope: consent.scope,
            version: consent.version,
            keys: [key],
            query: { uses: ["memory-classification"] },
          },
          options,
        );
      setConsent(await rpc.aiConsent.status({ uses: ["memory-classification"] }, options));
    } catch {
      setError(t`Could not update data sharing. Try again.`);
    } finally {
      pending.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  async function save(disconnect = false) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const value = disconnect
        ? await rpc.models.judgmentConnection.disconnect(undefined, options)
        : await rpc.models.judgmentConnection.connect(
            { provider, model: model.trim(), apiKey: apiKey.trim() },
            options,
          );
      setSettings(value);
      setApiKey("");
      setEditing(false);
    } catch {
      setError(
        disconnect
          ? t`Could not disconnect. Try again.`
          : t`Could not connect. Check the API key and model, then retry.`,
      );
    } finally {
      pending.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <section
      className="mb-6 space-y-4 border-b border-border pb-6"
      aria-labelledby={`${id}-title`}
      data-testid="judgment-connection-settings"
    >
      <h3 id={`${id}-title`} className="font-medium">
        <Trans>Judgment connection</Trans>
      </h3>
      {settings ? <p className="text-sm text-muted-foreground">{settings.spaceName}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!settings ? (
        <p role="status">
          <Trans>Loading…</Trans>
        </p>
      ) : settings.connection && !editing ? (
        <>
          <p className="text-sm">
            {settings.providers.find(({ id }) => id === settings.connection?.provider)?.name ??
              settings.connection.provider}{" "}
            · {settings.connection.model}
          </p>
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Connected</Trans>
          </p>
          {consent?.recipients.map((recipient) => (
            <details key={recipient.key} open={!recipient.allowed} className="space-y-2">
              <summary className="cursor-pointer text-sm">
                <Trans>Data sharing</Trans>
              </summary>
              <p className="text-sm text-muted-foreground">
                {recipient.name} · {recipient.detail}
              </p>
              <p className="text-sm text-muted-foreground">{AI_DATA_DISCLOSURES[recipient.use]}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void changeConsent(recipient.key, recipient.allowed)}
              >
                {recipient.allowed ? (
                  <Trans>Withdraw permission</Trans>
                ) : (
                  <Trans>Allow memory analysis</Trans>
                )}
              </Button>
            </details>
          ))}
          {settings.canConfigure ? (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(true)}>
                <Trans>Edit</Trans>
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void save(true)}>
                <Trans>Disconnect</Trans>
              </Button>
            </div>
          ) : null}
        </>
      ) : !settings.canConfigure ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Ask a Space owner to connect a classifier.</Trans>
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field>
            <FieldLabel htmlFor={`${id}-provider`}>
              <Trans>Classifier</Trans>
            </FieldLabel>
            <NativeSelect
              id={`${id}-provider`}
              value={provider}
              disabled={busy}
              onChange={(event) => setProvider(event.target.value)}
            >
              {settings.providers.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-model`}>
              <Trans>Model</Trans>
            </FieldLabel>
            <Input
              id={`${id}-model`}
              value={model}
              maxLength={120}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => setModel(event.target.value)}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-key`}>
              <Trans>API key</Trans>
            </FieldLabel>
            <Input
              id={`${id}-key`}
              type="password"
              value={apiKey}
              maxLength={4096}
              disabled={busy}
              autoComplete="new-password"
              onChange={(event) => setApiKey(event.target.value)}
              required
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !apiKey.trim() || !model.trim() || !provider}>
              {busy ? <Trans>Testing…</Trans> : <Trans>Test and connect</Trans>}
            </Button>
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setApiKey("");
                  setModel(settings.connection?.model ?? "");
                  setError(null);
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}
