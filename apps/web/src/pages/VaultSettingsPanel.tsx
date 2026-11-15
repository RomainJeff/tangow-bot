import { useLingui } from "@lingui/react/macro";
import type { BotSecretDestination } from "@tangow/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  SegmentedControl,
  SettingRow,
} from "@tangow/ui-web";
import { Plus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { PendingRead, SettingsGroup, useConfirm } from "./bot-page/page-kit";

type AuthType = BotSecretDestination["auth"]["type"];

/** "api.example.com" or a full URL, as the HTTPS origin a credential is bound to. */
function siteOrigin(site: string): string {
  const trimmed = site.trim();
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).origin;
  } catch {
    return trimmed;
  }
}

/** The person's credentials in this space. Values are write-only: never read back. */
export function VaultSettingsPanel() {
  const { t } = useLingui();
  const [items, setItems] = useState<BotSecretDestination[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<BotSecretDestination | "new" | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    rpc.vault
      .list()
      .then(setItems)
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  return (
    <div data-testid="vault-settings" className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")}>
          <Plus />
          {t`Add`}
        </Button>
      </div>
      {items === null ? (
        <PendingRead failed={failed} onRetry={load} />
      ) : items.length > 0 ? (
        <SettingsGroup>
          {items.map((item) => (
            <SettingRow
              key={item.name}
              label={item.name}
              subline={new URL(item.origin).host}
              chevron
              onClick={() => setEditing(item)}
            />
          ))}
        </SettingsGroup>
      ) : null}
      {editing ? (
        <VaultItemDialog
          item={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

/** Adds a credential, or replaces the value of `item` and offers to delete it. */
function VaultItemDialog({
  item,
  onClose,
  onSaved,
}: {
  item: BotSecretDestination | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLingui();
  const { confirm, dialog } = useConfirm();
  const [site, setSite] = useState("");
  const [name, setName] = useState("");
  const [authType, setAuthType] = useState<AuthType>("bearer");
  const [authField, setAuthField] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready =
    Boolean(value) &&
    (item !== null ||
      (Boolean(site.trim() && name) && (authType === "bearer" || Boolean(authField.trim()))));
  const login = (item?.auth.type ?? authType) === "login";

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not save`);
      setBusy(false);
    }
  }

  function save() {
    if (!ready || busy) return;
    const auth: BotSecretDestination["auth"] =
      authType === "header"
        ? { type: "header", name: authField.trim() }
        : authType === "basic" || authType === "login"
          ? { type: authType, username: authField.trim() }
          : { type: "bearer" };
    const destination = item ?? { name, origin: siteOrigin(site), auth };
    // Cleared before the request, so the value is never shown again.
    setValue("");
    void run(() => rpc.vault.put({ ...destination, value }));
  }

  async function remove() {
    if (!item || busy || !(await confirm(t`Delete ${item.name}?`, t`Delete`))) return;
    void run(() => rpc.vault.remove({ name: item.name }));
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent data-testid="vault-item-dialog">
        <DialogHeader>
          <DialogTitle>{item ? item.name : login ? t`New login` : t`New API key`}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          {item ? null : (
            <>
              <LabeledInput
                label={t`Site`}
                value={site}
                onChange={setSite}
                placeholder="api.example.com"
                autoFocus
              />
              <LabeledInput
                label={t`Name`}
                value={name}
                // Names are what the bot calls the key by: lowercase letters, digits and "_".
                onChange={(next) => setName(next.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
                placeholder="example_api"
              />
              <div className="flex flex-col gap-2">
                <Label>{t`Sent as`}</Label>
                <SegmentedControl
                  aria-label={t`Sent as`}
                  value={authType}
                  onValueChange={(next) => {
                    setAuthType(next);
                    setAuthField("");
                  }}
                  options={[
                    { value: "bearer", label: "Bearer" },
                    { value: "header", label: t`Header` },
                    { value: "basic", label: "Basic" },
                    { value: "login", label: t`Login` },
                  ]}
                  className="self-start"
                />
              </div>
              {authType === "header" ? (
                <LabeledInput
                  label={t`Header name`}
                  value={authField}
                  onChange={setAuthField}
                  placeholder="X-Api-Key"
                />
              ) : authType === "basic" || authType === "login" ? (
                <LabeledInput label={t`Username`} value={authField} onChange={setAuthField} />
              ) : null}
            </>
          )}
          <LabeledInput
            label={login ? t`Password` : t`Key`}
            type="password"
            autoComplete="off"
            value={value}
            onChange={setValue}
            autoFocus={item !== null}
          />
          {error ? <p className="text-meta text-destructive">{error}</p> : null}
          <DialogFooter>
            {item ? (
              <Button
                type="button"
                variant="ghost"
                className="me-auto text-destructive"
                disabled={busy}
                onClick={() => void remove()}
              >
                {t`Delete`}
              </Button>
            ) : null}
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={busy || !ready}>
              {item ? (login ? t`Replace password` : t`Replace key`) : t`Save`}
            </Button>
          </DialogFooter>
        </form>
        {dialog}
      </DialogContent>
    </Dialog>
  );
}

function LabeledInput({
  label,
  onChange,
  ...props
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} onChange={(event) => onChange(event.target.value)} {...props} />
    </div>
  );
}
